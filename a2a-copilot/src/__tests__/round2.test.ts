/**
 * Round 2: `session.ttl` is a hard maximum age again, a late `steering` echo does not split the turn, and `unavailable` is
 * read by its typed code with a fixed message for the model.
 */

import { describe, expect, it, vi } from "vitest";
import { createProviderTestServer, summarizeTask } from "@a2a-wrapper/core";
import { CopilotProvider } from "../copilot/provider.js";
import { UNAVAILABLE_FEEDBACK, nobodyWasAsked, permissionResult } from "../copilot/interactions.js";
import { registryOptionsOf } from "../server/index.js";
import { makeConfig, type ConfigOptions } from "./helpers/config.js";
import { ManualClient, ManualSession } from "./helpers/manual-session.js";

function answering(id: string): ManualSession {
  const s = new ManualSession(id);
  s.send.mockImplementation(async () => {
    queueMicrotask(() => {
      s.emit("assistant.message_delta", { deltaContent: "ok" });
      s.emit("session.idle");
    });
    return "m";
  });
  return s;
}

describe("session.ttl is a hard maximum age; idleTtl is the optional idle expiry", () => {
  const HOUR = 3_600_000;

  it("registryOptionsOf maps ttl to bindingMaxAgeMs, idleTtl to bindingTtlMs (unset by default), and nothing when sessions are not reused", () => {
    expect(registryOptionsOf(makeConfig())).toMatchObject({ bindingMaxAgeMs: HOUR });
    expect(registryOptionsOf(makeConfig())).not.toHaveProperty("bindingTtlMs");
    expect(registryOptionsOf(makeConfig({ session: { ttl: 5000, idleTtl: 700 } }))).toMatchObject({ bindingMaxAgeMs: 5000, bindingTtlMs: 700 });
    const none = registryOptionsOf(makeConfig({ session: { reuseByContext: false } }));
    expect(none).not.toHaveProperty("bindingMaxAgeMs");
    expect(registryOptionsOf(makeConfig({ session: { ttl: 0 } }))).not.toHaveProperty("bindingMaxAgeMs");
  });

  function boot(config: ConfigOptions) {
    const sessions = [answering("s1"), answering("s2"), answering("s3")];
    const client = new ManualClient(sessions);
    const full = makeConfig(config);
    const provider = new CopilotProvider(full, { clientFactory: () => client as never });
    const clock = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
    const server = createProviderTestServer(provider, { registry: { ...registryOptionsOf(full), now: () => new Date(clock.ms).toISOString() } });
    const send = async (at: number) => {
      clock.ms = Date.parse("2026-01-01T00:00:00.000Z") + at;
      return summarizeTask(await server.send({ text: "hi", contextId: "ctx" }));
    };
    return { client, send };
  }

  it("a conversation used again and again is still reset when its session reaches the max age", async () => {
    const h = boot({ session: { ttl: HOUR } });
    await h.send(0);
    await h.send(40 * 60_000); // younger than an hour: resumed (live handle reused)
    expect(h.client.created.map((s) => s.sessionId)).toEqual(["s1"]);
    await h.send(80 * 60_000); // used 40 minutes ago, but the session is 80 minutes old: a new session
    expect(h.client.created.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    await h.send(100 * 60_000); // the new session is 20 minutes old: reused
    expect(h.client.created.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  it("an idle TTL is separate and off by default: a conversation idle for a long time but younger than ttl is resumed", async () => {
    const h = boot({ session: { ttl: HOUR } });
    await h.send(0);
    await h.send(50 * 60_000);
    expect(h.client.created).toHaveLength(1);
    const idle = boot({ session: { ttl: HOUR, idleTtl: 10 * 60_000 } });
    await idle.send(0);
    await idle.send(20 * 60_000); // idle 20 minutes: reset by the idle TTL although only 20 minutes old
    expect(idle.client.created).toHaveLength(2);
  });
});

describe("a late steering echo: the message was folded into the CURRENT turn", () => {
  it("settles the held handle as inserted and stays in the same segment (no split, one response)", async () => {
    const session = new ManualSession();
    const client = new ManualClient([session]);
    const provider = new CopilotProvider(makeConfig({ timeouts: { steerAck: 20 } }), { clientFactory: () => client as never });
    const server = createProviderTestServer(provider);
    const live = server.startStream({ text: "first", contextId: "ctx" });
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(1));
    const taskId = (live.events[0] as any).payload.value.id as string;
    session.send.mockImplementation(async () => "m"); // no echo inside the window

    const settle = vi.spyOn((provider as any).turns.get(taskId).view, "settleSteer");
    const ack = await server.stream({ text: "also", contextId: "ctx", taskId, delivery: "steer" });
    expect(ack.events[0].payload.value.metadata["urn:a2a-wrapper:delivery-result:v1"]).toMatchObject({ state: "queued", holder: "provider" });

    const handle = session.send.mock.calls.at(-1)![0].clientTurnId as string;
    session.emit("assistant.message_delta", { deltaContent: "part one " });
    session.emit("user.message", { clientTurnId: handle, delivery: "steering" }); // late echo: steering
    session.emit("assistant.message_delta", { deltaContent: "part two" });
    session.emit("session.idle");
    await live.done;

    expect(settle).toHaveBeenCalledWith(handle, "inserted");
    const task = summarizeTask(await server.getTask(taskId));
    expect(task.state).toBe("completed");
    expect(task.artifacts.filter((a) => a.name === "response").map((a) => a.text)).toEqual(["part one part two"]); // one segment
    expect(task.artifacts.filter((a) => a.name === "trace.lifecycle")).toHaveLength(2); // started, finished: no second turn
    const record = await server.runStore.listQueued(taskId);
    expect(record[0]).toMatchObject({ state: "done" });
  });
});

describe("unavailable is read by its typed code", () => {
  const unavailable = (code?: string) => ({ outcome: "unavailable" as const, reason: "core internal text", ...(code ? { code } : {}) });

  it("policy-auto approves only when the wrapper itself is auto; every other code or mode denies", () => {
    expect(permissionResult(unavailable("policy-auto"), true)).toEqual({ kind: "approve-once" });
    expect(permissionResult(unavailable("interactions-disabled"), true)).toEqual({ kind: "approve-once" });
    // the reviewer's case: registry asks, wrapper is auto, core answers "invalid interaction": never an approval
    expect(permissionResult(unavailable("invalid-request"), true)).toMatchObject({ kind: "reject" });
    expect(permissionResult(unavailable("internal"), true)).toMatchObject({ kind: "reject" });
    expect(permissionResult(unavailable("something-new"), true)).toMatchObject({ kind: "reject" });
    expect(permissionResult(unavailable(), true)).toMatchObject({ kind: "reject" });
    expect(permissionResult(unavailable("policy-auto"), false)).toMatchObject({ kind: "reject" }); // wrapper asks, registry says auto
    expect(nobodyWasAsked(unavailable("policy-auto"))).toBe(true);
    expect(nobodyWasAsked({ outcome: "canceled" })).toBe(false);
  });

  it("the model gets a fixed message, never core's internal reason text", () => {
    const r = permissionResult(unavailable("invalid-request"), false) as { feedback?: string };
    expect(r.feedback).toBe(UNAVAILABLE_FEEDBACK);
    expect(JSON.stringify(r)).not.toContain("core internal text");
  });

  it("through core: registry ask + wrapper auto + a malformed request is denied, not approved", async () => {
    const session = new ManualSession();
    const client = new ManualClient([session]);
    // the wrapper is auto (no interactions config) while the registry is configured to ask
    const provider = new CopilotProvider(makeConfig(), { clientFactory: () => client as never });
    const server = createProviderTestServer(provider, { registry: { interactionPolicy: { mode: "ask" } } });
    const live = server.startStream({ text: "go", contextId: "ctx" });
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(1));
    const turn = [...(provider as any).turns.values()][0];
    const realAsk = turn.ask.bind(turn);
    // a request core refuses (no options): what the provider could never build itself, forced here
    turn.ask = (r: any) => realAsk({ ...r, options: [] });
    const opts = client.createOptions[0] as any;
    const res = await opts.onPermissionRequest({ kind: "shell", fullCommandText: "x" }, { sessionId: "s" });
    expect(res.kind).toBe("reject");
    expect(res.feedback).toBe(UNAVAILABLE_FEEDBACK);
    session.emit("session.idle");
    await live.done;
  });
});
