/**
 * Permission requests and `ask_user` questions through core's interactions.
 *
 * Default (`interactions.mode: "auto"`): nobody is asked and every permission is approved, as before; rules (`autoAnswer`)
 * answer what they match. `ask`: what no rule answers reaches the A2A client as `input-required` and the Copilot handler
 * resumes on the reply; everything but an explicit allow denies.
 */

import { describe, expect, it, vi } from "vitest";
import { createProviderTestServer, stateName, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { interactionPolicyOf } from "../server/index.js";
import { CopilotProvider } from "../copilot/provider.js";
import { permissionInteraction, permissionResult, questionAnswer, questionInteraction } from "../copilot/interactions.js";
import { McpEvidenceHooks } from "../copilot/mcp-hooks.js";
import { makeConfig, type ConfigOptions } from "./helpers/config.js";
import { ManualClient, ManualSession } from "./helpers/manual-session.js";

function boot(config: ConfigOptions = {}) {
  const session = new ManualSession();
  const client = new ManualClient([session]);
  const provider = new CopilotProvider(makeConfig(config), { clientFactory: () => client as never });
  const full = makeConfig(config);
  const server = createProviderTestServer(provider, { registry: { interactionPolicy: interactionPolicyOf(full) } });
  return { session, client, provider, server };
}
type H = ReturnType<typeof boot>;

const shell = { kind: "shell", intention: "Create perm.txt", fullCommandText: "echo hi > perm.txt", hasWriteFileRedirection: true };
const readReq = { kind: "read", intention: "Read a file", path: "/etc/hosts" };
const invocation = { sessionId: "sess-1" };

/** Start a task and wait until the session options (and so the permission handler) exist and the prompt was sent. */
async function running(h: H) {
  const live = h.server.startStream({ text: "do it", contextId: "ctx" });
  await vi.waitFor(() => expect(h.session.send).toHaveBeenCalledTimes(1));
  const options = h.client.createOptions[0] as any;
  const taskId = (live.events[0] as any).payload.value.id as string;
  return { live, options, taskId };
}

/** The text and structured part of the input-required status a stream carries. */
function inputRequired(events: any[]) {
  const e = events.find((x: any) => x.payload.$case === "statusUpdate" && stateName(x.payload.value.status.state) === "input-required");
  if (!e) return undefined;
  const parts = e.payload.value.status.message.parts;
  const text = parts.map((p: any) => p.content?.value).find((v: any) => typeof v === "string") as string;
  const data = parts.map((p: any) => p.content?.value).find((v: any) => v && typeof v === "object")!;
  return { text, data, code: /`\d+ ([A-Z0-9]{4})`/.exec(text)?.[1] };
}

/** The prompt in the status message of a Task that is input-required (what a blocking reply returns when the run parks again). */
function promptOf(task: any) {
  expect(stateName(task.status.state)).toBe("input-required");
  const parts = task.status.message.parts.map((p: any) => p.content?.value);
  return { text: parts.find((v: any) => typeof v === "string") as string, data: parts.find((v: any) => v && typeof v === "object") };
}

const dataReply = (value: unknown) => [{ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" }];

const finish = (h: H) => {
  h.session.emit("assistant.message_delta", { deltaContent: "done" });
  h.session.emit("session.idle");
};

describe("default policy (auto): the headless behaviour is unchanged", () => {
  it("approves every permission request without asking anybody", async () => {
    const h = boot();
    const { live, options } = await running(h);
    for (const req of [shell, readReq, { kind: "mcp", serverName: "s", toolName: "t" }, { kind: "url", url: "https://x" }]) {
      const res = await options.onPermissionRequest(req, invocation);
      expect(res.kind, req.kind).toBe("approve-once");
    }
    finish(h);
    const { events } = await live.done;
    expect(inputRequired(events)).toBeUndefined();
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
  });

  it("the pre-tool hook still answers allow, and ask_user is not offered to the model", async () => {
    const h = boot();
    const { live, options } = await running(h);
    expect(options.onUserInputRequest).toBeUndefined();
    const out = await options.hooks.onPreToolUse({ toolName: "x", toolArgs: {} }, { sessionId: "s" });
    expect(out).toEqual({ permissionDecision: "allow" });
    finish(h);
    await live.done;
  });

  it("an autoAnswer rule decides what it matches; the rest is still approved (nobody is asked)", async () => {
    const h = boot({ interactions: { mode: "auto", autoAnswer: [{ match: { tool: "shell" }, answer: { decline: true } }] } });
    const { live, options } = await running(h);
    expect((await options.onPermissionRequest(shell, invocation)).kind).toBe("reject");
    expect((await options.onPermissionRequest(readReq, invocation)).kind).toBe("approve-once");
    finish(h);
    await live.done;
  });

  it("a permission request with no running turn is approved (the headless default)", async () => {
    const h = boot();
    const { live, options } = await running(h);
    finish(h);
    await live.done;
    await new Promise((r) => setTimeout(r, 5));
    expect((await options.onPermissionRequest(shell, invocation)).kind).toBe("approve-once");
  });
});

describe("ask mode: permission requests reach the client", () => {
  const ask = { interactions: { mode: "ask", timeoutMs: 60_000 } } as const;

  it("parks the task as input-required (stream ends), and an allow reply resumes the Copilot handler", async () => {
    const h = boot(ask);
    const { live, options, taskId } = await running(h);
    const decision = options.onPermissionRequest(shell, invocation);

    const { events } = await live.done; // the stream ends at input-required
    const prompt = inputRequired(events)!;
    expect(prompt.text).toContain("Run a shell command");
    expect(prompt.text).toContain("echo hi > perm.txt");
    expect(prompt.data.interaction).toMatchObject({ kind: "permission", subject: { tool: "shell", action: "execute", risk: "high" } });
    expect(prompt.data.interaction.options.map((o: any) => o.kind)).toEqual(["allow_once", "reject_once"]);
    expect(prompt.code).toMatch(/^[A-Z0-9]{4}$/);

    const reply = h.server.send({ text: `1 ${prompt.code}`, contextId: "ctx", taskId });
    expect(await decision).toEqual({ kind: "approve-once" });
    finish(h);
    expect(stateName((await reply).status.state)).toBe("completed");
  });

  it("a deny reply rejects it, also with the client's feedback in a structured reply", async () => {
    const h = boot(ask);
    const { live, options, taskId } = await running(h);
    const decision = options.onPermissionRequest(shell, invocation);
    const first = inputRequired((await live.done).events)!;

    // "no" denies; the second request parks the run again, which is what the blocking reply returns
    const reply1 = h.server.send({ text: "no", contextId: "ctx", taskId });
    expect(await decision).toEqual({ kind: "reject" });
    const decision2 = options.onPermissionRequest(shell, invocation);
    const second = promptOf(await reply1);

    const reply2 = h.server.send({
      contextId: "ctx",
      taskId,
      parts: dataReply({ interactionId: second.data.interactionId, optionId: "reject", feedback: "not in this directory" }),
    });
    expect(await decision2).toEqual({ kind: "reject", feedback: "not in this directory" });
    expect(first.data.interactionId).not.toBe(second.data.interactionId);
    finish(h);
    expect(stateName((await reply2).status.state)).toBe("completed");
  });

  it("an unanswered request does not approve: canceling the task answers the handler user-not-available", async () => {
    const h = boot(ask);
    const { live, options, taskId } = await running(h);
    const decision = options.onPermissionRequest(shell, invocation);
    await live.done;
    await h.server.cancel(taskId);
    expect(await decision).toEqual({ kind: "user-not-available" });
  });

  it("an expired request fails the task and answers the handler without approving", async () => {
    const h = boot({ interactions: { mode: "ask", timeoutMs: 30, onTimeout: "fail" } });
    const { live, options, taskId } = await running(h);
    const decision = options.onPermissionRequest(shell, invocation);
    await live.done;
    const res = await decision;
    expect(res.kind).not.toBe("approve-once");
    await vi.waitFor(async () => expect(stateName((await h.server.getTask(taskId)).status.state)).toBe("failed"));
  });

  it("with onTimeout deny the task goes on and the request is denied", async () => {
    const h = boot({ interactions: { mode: "ask", timeoutMs: 30, onTimeout: "deny" } });
    const { live, options, taskId } = await running(h);
    const decision = options.onPermissionRequest(shell, invocation);
    await live.done;
    expect((await decision).kind).toBe("user-not-available");
    finish(h);
    await vi.waitFor(async () => expect(stateName((await h.server.getTask(taskId)).status.state)).toBe("completed"));
  });

  it("an autoAnswer rule answers without asking: low risk is allowed, shell still goes to the client", async () => {
    const h = boot({ interactions: { mode: "ask", autoAnswer: [{ match: { risk: "low" }, answer: { kind: "allow_once" } }] } });
    const { live, options } = await running(h);
    expect((await options.onPermissionRequest(readReq, invocation)).kind).toBe("approve-once"); // risk low: answered by the rule
    const pending = options.onPermissionRequest(shell, invocation);
    const { events } = await live.done;
    expect(inputRequired(events)?.text).toContain("Run a shell command");
    void pending;
  });

  it("a permission request with no running turn is denied under ask (never approved by default)", async () => {
    const h = boot(ask);
    const { live, options, taskId } = await running(h);
    await h.server.cancel(taskId);
    await live.done;
    await new Promise((r) => setTimeout(r, 5));
    expect((await options.onPermissionRequest(shell, invocation)).kind).toBe("user-not-available");
  });

  it("the pre-tool hook leaves the decision to the permission handler", async () => {
    const h = boot(ask);
    const { live, options } = await running(h);
    expect(await options.hooks.onPreToolUse({ toolName: "x", toolArgs: {} }, { sessionId: "s" })).toEqual({});
    finish(h);
    await live.done;
  });
});

describe("ask mode: ask_user questions", () => {
  const ask = { interactions: { mode: "ask", timeoutMs: 60_000 } } as const;

  it("is offered to the model only in ask mode, and a structured answer resumes the tool call", async () => {
    const h = boot(ask);
    const { live, options, taskId } = await running(h);
    expect(typeof options.onUserInputRequest).toBe("function");
    const answer = options.onUserInputRequest({ question: "Which color?", choices: ["red", "blue"], allowFreeform: true });
    const prompt = inputRequired((await live.done).events)!;
    expect(prompt.data.interaction).toMatchObject({ kind: "question", questions: [{ id: "answer", prompt: "Which color?" }] });

    const reply = h.server.send({ contextId: "ctx", taskId, parts: dataReply({ interactionId: prompt.data.interactionId, answers: { answer: { optionIds: ["1"] } } }) });
    expect(await answer).toEqual({ answer: "blue", wasFreeform: false });
    finish(h);
    await reply;
  });

  it("a free-text answer is freeform; an unanswered question ends the tool call with an error", async () => {
    const h = boot(ask);
    const { live, options, taskId } = await running(h);
    const answer = options.onUserInputRequest({ question: "Name?" });
    const prompt = inputRequired((await live.done).events)!;
    const reply1 = h.server.send({ contextId: "ctx", taskId, parts: dataReply({ interactionId: prompt.data.interactionId, answers: { answer: { text: "Ada" } } }) });
    expect(await answer).toEqual({ answer: "Ada", wasFreeform: true });

    const none = options.onUserInputRequest({ question: "again?" });
    none.catch(() => {});
    await reply1; // parks again
    await h.server.cancel(taskId);
    await expect(none).rejects.toThrow(/not answered/);
  });
});

describe("the mapping", () => {
  it("permission requests become interactions with a risk and subject for rules to match", () => {
    expect(permissionInteraction(shell)).toMatchObject({ kind: "permission", title: "Run a shell command", subject: { tool: "shell", command: "echo hi > perm.txt", risk: "high" } });
    expect(permissionInteraction(readReq)).toMatchObject({ subject: { tool: "read", resources: ["/etc/hosts"], risk: "low" } });
    expect(permissionInteraction({ kind: "write", fileName: "a.txt" })).toMatchObject({ subject: { tool: "write", resources: ["a.txt"], risk: "high" } });
    expect(permissionInteraction({ kind: "mcp", serverName: "fs", toolName: "read", readOnly: true })).toMatchObject({ subject: { tool: "fs/read", risk: "low" } });
    expect(permissionInteraction({ kind: "mcp", serverName: "fs", toolName: "write" })).toMatchObject({ subject: { risk: "medium" } });
    expect(permissionInteraction({ kind: "url", url: "https://x" })).toMatchObject({ subject: { tool: "fetch", risk: "medium" } });
    expect(permissionInteraction({ kind: "memory" })).toMatchObject({ title: "Permission requested (memory)" });
  });

  it("only an explicit allow approves under ask; everything else denies; under auto unavailable approves", () => {
    const by = { id: "u", kind: "user" };
    expect(permissionResult({ outcome: "selected", optionId: "allow", by }, false)).toEqual({ kind: "approve-once" });
    expect(permissionResult({ outcome: "selected", optionId: "reject", feedback: "no", by }, false)).toEqual({ kind: "reject", feedback: "no" });
    expect(permissionResult({ outcome: "selected", optionId: "something-else", by }, false)).toEqual({ kind: "reject" });
    expect(permissionResult({ outcome: "declined", by }, false)).toEqual({ kind: "reject" });
    expect(permissionResult({ outcome: "dismissed" }, false)).toEqual({ kind: "reject" });
    for (const outcome of ["canceled", "expired", "withdrawn"] as const) expect(permissionResult({ outcome }, false)).toEqual({ kind: "user-not-available" });
    expect(permissionResult({ outcome: "unavailable", reason: "x" }, false)).toMatchObject({ kind: "reject" });
    expect(permissionResult({ outcome: "unavailable", reason: "x" }, true)).toEqual({ kind: "approve-once" });
  });

  it("questions: one question with the choices as options; the answer maps back", () => {
    const q = questionInteraction({ question: "Which?", choices: ["a", "b"], allowFreeform: false });
    expect(q).toMatchObject({ kind: "question", questions: [{ id: "answer", prompt: "Which?", allowFreeform: false, options: [{ id: "0", label: "a" }, { id: "1", label: "b" }] }] });
    const by = { id: "u", kind: "user" };
    expect(questionAnswer({ outcome: "answered", answers: { answer: { optionIds: ["0"] } }, by }, { question: "Which?", choices: ["a", "b"] })).toEqual({ answer: "a", wasFreeform: false });
    expect(questionAnswer({ outcome: "answered", answers: { answer: { freeText: "z" } }, by }, { question: "Which?" })).toEqual({ answer: "z", wasFreeform: true });
    expect(questionAnswer({ outcome: "canceled" }, { question: "?" })).toBeUndefined();
  });

  it("the config section becomes core's policy (only what the operator set)", () => {
    expect(interactionPolicyOf(makeConfig())).toEqual({});
    expect(interactionPolicyOf(makeConfig({ interactions: { mode: "ask", timeoutMs: 5, onTimeout: "deny", autoAnswer: [{ match: {}, answer: { kind: "allow_once" } }] } }))).toEqual({
      mode: "ask",
      timeoutMs: 5,
      onTimeout: "deny",
      autoAnswer: [{ match: {}, answer: { kind: "allow_once" } }],
    });
  });

  it("MCP evidence hooks: allow by default, leave the decision when asked not to", async () => {
    expect(await new McpEvidenceHooks().getHooks().onPreToolUse!({ toolName: "t", toolArgs: {} }, { sessionId: "s" })).toEqual({ permissionDecision: "allow" });
    expect(await new McpEvidenceHooks(false).getHooks().onPreToolUse!({ toolName: "t", toolArgs: {} }, { sessionId: "s" })).toEqual({});
    void summarizeTask;
  });
});
