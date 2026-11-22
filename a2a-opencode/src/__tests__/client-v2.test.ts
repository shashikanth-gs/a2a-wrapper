import { describe, it, expect } from "vitest";
import { posix, win32 } from "node:path";
import {
  OpenCodeClientV2,
  toV2Permissions,
  toV2McpConfig,
  normalizeMcpStatus,
  buildFormAnswer,
  toAbsoluteDirectory,
} from "../opencode/client-v2.js";

const client = () => new OpenCodeClientV2({ baseUrl: "http://127.0.0.1:1", healthCheckInterval: 0 });
const translate = (ev: unknown) =>
  client().translateEvent(ev as never, new Map(), new Map()) as Array<Record<string, any>>;

describe("toV2Permissions", () => {
  it("maps {permission,pattern,action} to {action,resource,effect}", () => {
    expect(toV2Permissions([{ permission: "read", pattern: "*", action: "allow" }])).toEqual([
      { action: "read", resource: "*", effect: "allow" },
    ]);
  });
  it("also emits the 2.x `shell` name for 1.x `bash` rules", () => {
    const out = toV2Permissions([{ permission: "bash", pattern: "*", action: "allow" }])!;
    expect(out.map((r) => r.action)).toEqual(["bash", "shell"]);
  });
  it("returns undefined for an empty ruleset", () => {
    expect(toV2Permissions([])).toBeUndefined();
    expect(toV2Permissions(undefined)).toBeUndefined();
  });
});

describe("toV2McpConfig", () => {
  it("translates a local entry (enabled/timeout/environment)", () => {
    expect(
      toV2McpConfig({ type: "local", command: ["node", "x.js"], environment: { A: "1" }, enabled: false, timeout: 5000 }),
    ).toEqual({
      type: "local",
      command: ["node", "x.js"],
      environment: { A: "1" },
      disabled: true,
      timeout: { startup: 5000 },
    });
  });
  it("translates a remote entry", () => {
    expect(toV2McpConfig({ type: "remote", url: "https://x/mcp", headers: { h: "v" }, enabled: true })).toEqual({
      type: "remote",
      url: "https://x/mcp",
      headers: { h: "v" },
    });
  });
});

describe("normalizeMcpStatus", () => {
  it.each([
    [{ type: "connected" }, "connected"],
    ["NeedsAuth", "needs_auth"],
    [{ status: "failed", error: "boom" }, "failed"],
    [undefined, "unknown"],
  ])("normalizes %j", (raw, expected) => {
    expect(normalizeMcpStatus(raw).status).toBe(expected);
  });
  it("carries the error message", () => {
    expect(normalizeMcpStatus({ type: "failed", error: "boom" }).error).toBe("boom");
  });
});

describe("buildFormAnswer", () => {
  const fields = [
    { key: "choice", type: "string", options: [{ value: "a", label: "Alpha" }] },
    { key: "many", type: "multiselect", options: [{ value: "x", label: "X" }] },
    { key: "ok", type: "boolean" },
    { key: "n", type: "number", default: 7 },
    { key: "free", type: "string", default: "dflt" },
  ];
  it("maps labels to option values and applies defaults", () => {
    expect(buildFormAnswer(fields, [["Alpha"], ["X"], [""], [""], [""]])).toEqual({
      choice: "a",
      many: ["x"],
      ok: true,
      n: 7,
      free: "dflt",
    });
  });
});

describe("event translation (2.x to canonical)", () => {
  it("text delta becomes message.part.updated", () => {
    const [e] = translate({ type: "session.text.delta", data: { sessionID: "s1", assistantMessageID: "m1", delta: "hi" } });
    expect(e.type).toBe("message.part.updated");
    expect(e.properties.delta).toBe("hi");
    expect(e.properties.sessionID).toBe("s1");
    expect(e.properties.part).toMatchObject({ type: "text", messageID: "m1" });
  });

  it("tool lifecycle: running then completed, with the tool name from input.started", () => {
    const c = client();
    const names = new Map<string, string>();
    const starts = new Map<string, number>();
    const tr = (ev: unknown) => c.translateEvent(ev as never, names, starts) as Array<Record<string, any>>;
    expect(tr({ type: "session.tool.input.started", data: { sessionID: "s", id: "t1", name: "shell" } })).toEqual([]);
    const [run] = tr({
      type: "session.tool.called",
      created: 100,
      data: { sessionID: "s", id: "t1", assistantMessageID: "m", input: { command: "ls" } },
    });
    expect(run.properties.part).toMatchObject({
      type: "tool",
      tool: "shell",
      callID: "t1",
      state: { status: "running", input: { command: "ls" } },
    });
    const [done] = tr({
      type: "session.tool.success",
      created: 160,
      data: { sessionID: "s", id: "t1", assistantMessageID: "m", content: [{ type: "text", text: "out" }] },
    });
    expect(done.properties.part.state).toMatchObject({ status: "completed", output: "out", time: { start: 100, end: 160 } });
  });

  it("tool failure becomes an error state", () => {
    const [e] = translate({
      type: "session.tool.failed",
      data: { sessionID: "s", id: "t", assistantMessageID: "m", error: { message: "nope" } },
    });
    expect(e.properties.part.state).toMatchObject({ status: "error", error: "nope" });
  });

  it.each([
    ["session.execution.succeeded", "succeeded"],
    ["session.execution.interrupted", "interrupted"],
    ["session.idle", "idle"],
  ])("%s becomes session.idle (saying how the execution ended)", (type, execution) => {
    expect(translate({ type, data: { sessionID: "s" } })).toEqual([
      { type: "session.idle", properties: { sessionID: "s", execution } },
    ]);
  });

  it("an interruption carries its reason", () => {
    expect(translate({ type: "session.execution.interrupted", data: { sessionID: "s", reason: "user" } })).toEqual([
      { type: "session.idle", properties: { sessionID: "s", execution: "interrupted", reason: "user" } },
    ]);
  });

  it("execution.started and the durable inbox events are passed on", () => {
    expect(translate({ type: "session.execution.started", data: { sessionID: "s" } })).toEqual([
      { type: "session.execution.started", properties: { sessionID: "s" } },
    ]);
    for (const type of ["session.inbox.enqueued", "session.inbox.delivered", "session.inbox.cancelled"]) {
      expect(translate({ type, data: { sessionID: "s", inboxID: "msg_1", item: { payload: { text: "x" } } } })).toEqual([
        { type, properties: { sessionID: "s", inboxID: "msg_1" } },
      ]);
    }
  });

  it("permission and form answers become the replied events (so a pending ask can be withdrawn)", () => {
    expect(translate({ type: "permission.replied", data: { sessionID: "s", requestID: "p1", reply: "reject" } })).toEqual([
      { type: "permission.replied", properties: { sessionID: "s", requestID: "p1", reply: "reject" } },
    ]);
    expect(translate({ type: "form.replied", data: { sessionID: "s", id: "f1", answer: {} } })).toEqual([
      { type: "question.replied", properties: { sessionID: "s", requestID: "f1" } },
    ]);
    expect(translate({ type: "form.cancelled", data: { sessionID: "s", id: "f1" } })).toEqual([
      { type: "question.rejected", properties: { sessionID: "s", requestID: "f1" } },
    ]);
  });

  it("execution.failed becomes session.error", () => {
    const [e] = translate({ type: "session.execution.failed", data: { sessionID: "s", error: { message: "bad" } } });
    expect(e).toMatchObject({ type: "session.error", properties: { sessionID: "s", error: { message: "bad" } } });
  });

  it("permission.asked becomes a canonical permission request", () => {
    const [e] = translate({
      type: "permission.asked",
      data: { id: "per_1", sessionID: "s", action: "shell", resources: ["ls"], save: ["ls *"] },
    });
    expect(e).toMatchObject({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "s", permission: "shell", patterns: ["ls"] },
    });
  });

  it("form.created becomes question.asked, and noise events are dropped", () => {
    const [q] = translate({
      type: "form.created",
      data: { form: { id: "f1", sessionID: "s", fields: [{ key: "k", type: "string", options: [{ value: "v", label: "L" }] }] } },
    });
    expect(q.type).toBe("question.asked");
    expect(q.properties.questions[0].options[0].label).toBe("L");
    expect(translate({ type: "provider.updated", data: {} })).toEqual([]);
  });
});

describe("toAbsoluteDirectory (server may run on another OS)", () => {
  const absolute = [
    String.raw`C:\Users\me\proj`,
    "C:/Users/me/proj",
    "/srv/proj",
    String.raw`\\server\share\proj`,
  ];
  it.each(absolute)("keeps absolute path %s as-is, whatever OS the wrapper runs on", (p) => {
    expect(toAbsoluteDirectory(p)).toBe(p);
  });
  it("resolves relative paths to an absolute one", () => {
    const out = toAbsoluteDirectory("./workspace");
    expect(posix.isAbsolute(out) || win32.isAbsolute(out)).toBe(true);
    expect(out.endsWith("workspace")).toBe(true);
  });
});
