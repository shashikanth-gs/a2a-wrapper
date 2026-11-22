/**
 * Tests: cancel aborts the backend session (#66), now through core's cancel entry point.
 *
 * The Copilot SDK exposes `session.abort()`; a cancel must call it so the backend turn actually stops, not just mark the A2A
 * task canceled. The A2A side (one terminal event, `canceled` published before the abort, late events dropped, idempotency)
 * is core's `RunRegistry`; these tests prove the provider behind it behaves: they run the real request handler over the
 * provider with a faked Copilot client, so nothing touches the network or spawns a CLI.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createProviderTestServer, stateName, summarizeEvent } from "@a2a-wrapper/core";
import { CopilotProvider } from "../copilot/provider.js";
import { makeConfig, type ConfigOptions } from "./helpers/config.js";
import { ManualClient, ManualSession } from "./helpers/manual-session.js";

const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);

/** Terminal states in a stream, in order. */
const terminals = (events: any[]) =>
  events
    .map(summarizeEvent)
    .filter((e) => e.k === "status" && TERMINAL.has(e.state))
    .map((e) => (e as { state: string }).state);
const states = (events: any[]) => events.map(summarizeEvent).flatMap((e) => (e.k === "status" ? [e.state] : []));

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

function setup(config: ConfigOptions = {}, session = new ManualSession(), registry: Record<string, unknown> = {}) {
  const client = new ManualClient([session]);
  const provider = new CopilotProvider(makeConfig(config), { clientFactory: () => client as never });
  const server = createProviderTestServer(provider, { registry });
  return { client, session, provider, server };
}

/** Start a streamed request and wait until the prompt was sent (or, non-streaming, `sendAndWait` was called). */
async function startRunning(h: ReturnType<typeof setup>, streaming = true, contextId = "ctx-1") {
  const live = h.server.startStream({ text: "hello", contextId });
  await vi.waitFor(() => expect(streaming ? h.session.send : h.session.sendAndWait).toHaveBeenCalledTimes(1));
  const taskId = (live.events[0] as any).payload.value.id as string;
  return { live, taskId };
}

/** Make the next `send` answer and go idle. */
function answerWith(session: ManualSession, text: string): void {
  session.send.mockImplementation(async () => {
    queueMicrotask(() => {
      session.emit("assistant.message_delta", { deltaContent: text });
      session.emit("session.idle");
    });
    return "m";
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cancel aborts the backend session", () => {
  it("streaming: calls session.abort(), publishes canceled once, no completed/failed", async () => {
    const h = setup({ streaming: true });
    const { live, taskId } = await startRunning(h);

    await h.server.cancel(taskId);
    const { events, error } = await live.done;

    expect(error).toBeUndefined();
    expect(h.session.abort).toHaveBeenCalledTimes(1);
    expect(terminals(events)).toEqual(["canceled"]);
    expect(states(events)).not.toContain("completed");
    expect(states(events)).not.toContain("failed");
    // The canceled event carries the real contextId, not "".
    const canceled = events.find((e: any) => e.payload.$case === "statusUpdate" && stateName(e.payload.value.status.state) === "canceled");
    expect(canceled.payload.value.contextId).toBe("ctx-1");
  });

  it("the cancel does not wait for the backend: canceled is out and the call returned while abort() is still pending", async () => {
    const h = setup({ streaming: true });
    let finishAbort!: () => void;
    h.session.abort.mockImplementation(() => new Promise<void>((r) => { finishAbort = r; }));
    const { live, taskId } = await startRunning(h);

    const canceled = await h.server.cancel(taskId);
    expect(stateName(canceled.status.state)).toBe("canceled");
    const { events } = await live.done;
    expect(h.session.abort).toHaveBeenCalledTimes(1);
    expect(terminals(events)).toEqual(["canceled"]);
    finishAbort();
    await tick();
  });

  it("non-streaming: aborts, and the rejected sendAndWait is not reported as failed", async () => {
    const h = setup({ streaming: false });
    const { live, taskId } = await startRunning(h, false);

    await h.server.cancel(taskId);
    const { events } = await live.done;

    expect(h.session.abort).toHaveBeenCalledTimes(1);
    expect(terminals(events)).toEqual(["canceled"]);
  });

  it("drops late events from the aborted turn (never published after canceled) and leaks no listeners", async () => {
    const h = setup({ streaming: true, chunks: true });
    const { live, taskId } = await startRunning(h);

    await h.server.cancel(taskId);
    const { events } = await live.done;
    const countAtCancel = events.length;
    await tick();

    // The aborted turn keeps talking: deltas, tool progress, even an idle.
    h.session.emit("assistant.message_delta", { deltaContent: "late text" });
    h.session.emit("tool.execution_start", { toolName: "bash" });
    h.session.emit("session.idle");
    await tick();

    expect(events.length).toBe(countAtCancel);
    const stored = JSON.stringify(await h.server.getTask(taskId));
    expect(stored).not.toContain("late text");
    // Listeners were removed, so they cannot leak into the next turn.
    expect(h.session.listenerCount("assistant.message_delta")).toBe(0);
    expect(h.session.listenerCount("session.idle")).toBe(0);
  });

  it("a following message in the same context reuses the aborted session cleanly", async () => {
    const h = setup({ streaming: true });
    const { live, taskId } = await startRunning(h, true, "ctx-reuse");
    await h.server.cancel(taskId);
    await live.done;

    // Second turn on the same session completes normally.
    answerWith(h.session, "fresh answer");
    const second = await h.server.stream({ text: "again", contextId: "ctx-reuse" });

    expect(terminals(second.events)).toEqual(["completed"]);
    expect(JSON.stringify(second.events.map(summarizeEvent))).toContain("fresh answer");
    // Abort succeeded, so the session was kept (no new session, no resume): the binding names the live one.
    expect(h.client.created).toHaveLength(1);
    expect(h.client.resumed).toEqual([]);
    expect(h.session.disconnect).not.toHaveBeenCalled();
  });

  it("cancel while the session is still being opened: never sends the prompt", async () => {
    const h = setup({ streaming: true });
    let release!: () => void;
    h.client.gate = new Promise<void>((r) => { release = r; });

    const live = h.server.startStream({ text: "hello", contextId: "ctx-1" });
    await vi.waitFor(() => expect(h.client.createOptions).toHaveLength(1));
    const taskId = (live.events[0] as any).payload.value.id as string;
    await h.server.cancel(taskId);
    release();
    const { events } = await live.done;

    expect(h.session.send).not.toHaveBeenCalled();
    expect(h.session.abort).not.toHaveBeenCalled();
    expect(terminals(events)).toEqual(["canceled"]);
  });
});

describe("cancel is safe and idempotent", () => {
  it("unknown task: rejected by the handler, nothing aborted", async () => {
    const h = setup();
    await expect(h.server.cancel("does-not-exist")).rejects.toBeDefined();
    expect(h.session.abort).not.toHaveBeenCalled();
  });

  it("cancel after completion changes nothing and does not abort", async () => {
    const h = setup({ streaming: true });
    answerWith(h.session, "done");
    const { events } = await h.server.stream({ text: "hello", contextId: "c" });
    const taskId = (events[0] as any).payload.value.id as string;
    const before = events.length;

    await h.server.cancel(taskId).catch(() => {}); // not cancelable: the handler refuses
    expect(events.length).toBe(before);
    expect(terminals(events)).toEqual(["completed"]);
    expect(stateName((await h.server.getTask(taskId)).status.state)).toBe("completed");
    expect(h.session.abort).not.toHaveBeenCalled();
  });

  it("double cancel aborts and publishes only once", async () => {
    const h = setup({ streaming: true });
    const { live, taskId } = await startRunning(h);

    await Promise.allSettled([h.server.cancel(taskId), h.server.cancel(taskId)]);
    const { events } = await live.done;

    expect(h.session.abort).toHaveBeenCalledTimes(1);
    expect(terminals(events)).toEqual(["canceled"]);
  });

  it("cancel racing completion yields exactly one terminal state", async () => {
    const h = setup({ streaming: true });
    answerWith(h.session, "answer"); // idle fires and the cancel lands in the same tick
    const live = h.server.startStream({ text: "hello", contextId: "c" });
    await vi.waitFor(() => expect(live.events.length).toBeGreaterThan(0));
    const taskId = (live.events[0] as any).payload.value.id as string;
    await Promise.allSettled([h.server.cancel(taskId)]);
    const { events } = await live.done;
    expect(terminals(events)).toHaveLength(1);
  });
});

describe("cancel versus completion", () => {
  it("a cancel that lands before completion is finalizing wins and suppresses completed", async () => {
    const h = setup({ streaming: true });
    // idle fires, but the cancel lands in the same tick, before the turn resumes
    h.session.send.mockImplementation(async () => {
      queueMicrotask(() => {
        h.session.emit("assistant.message_delta", { deltaContent: "answer" });
        h.session.emit("session.idle");
        const taskId = [...(h.provider as any).turns.keys()][0] as string;
        void h.server.cancel(taskId);
      });
      return "m";
    });
    const { events } = await h.server.stream({ text: "hello", contextId: "c" });
    expect(terminals(events)).toEqual(["canceled"]);
  });
});

describe("abort failure handling and handle cleanup", () => {
  it("abort() rejecting still cancels, and discards the session so the next turn starts clean", async () => {
    const h = setup({ streaming: true });
    h.session.abort.mockRejectedValue(new Error("connection lost"));
    const { live, taskId } = await startRunning(h, true, "ctx-discard");

    await h.server.cancel(taskId);
    const { events } = await live.done;
    expect(terminals(events)).toEqual(["canceled"]);
    // core discards the binding and releases the session: the in-process handle is dropped
    await vi.waitFor(() => expect(h.session.disconnect).toHaveBeenCalled());

    // the next message in the context starts on a NEW session
    const second = new ManualSession("sess-2");
    answerWith(second, "clean");
    (h.client as any).sessions.push(second);
    const next = await h.server.stream({ text: "again", contextId: "ctx-discard" });
    expect(terminals(next.events)).toEqual(["completed"]);
    expect(h.client.created.map((s) => s.sessionId)).toEqual(["sess-1", "sess-2"]);
  });

  it("abort() hanging is bounded by the abort timeout, then the session is discarded", async () => {
    const h = setup({ streaming: true }, new ManualSession(), { abortTimeoutMs: 50 });
    h.session.abort.mockImplementation(() => new Promise<void>(() => {}));
    const { live, taskId } = await startRunning(h);

    await h.server.cancel(taskId);
    const { events } = await live.done;

    expect(terminals(events)).toEqual(["canceled"]);
    await vi.waitFor(() => expect(h.session.disconnect).toHaveBeenCalled());
  });

  it.each([true, false])("no listeners or tracked turns leak after cancel (streaming=%s)", async (streaming) => {
    const h = setup({ streaming });
    const { live, taskId } = await startRunning(h, streaming);

    await h.server.cancel(taskId);
    await live.done;
    await tick();

    for (const ev of ["assistant.usage", "session.usage_info", "session.idle", "user.message"]) {
      expect(h.session.listenerCount(ev)).toBe(0);
    }
    expect((h.provider as any).turns.size).toBe(0);
  });

  it("non-streaming: the prompt timeout timer is cleared after a normal completion", async () => {
    const h = setup({ streaming: false });
    h.session.sendAndWait.mockResolvedValue({ data: { content: "ok" } });
    const cleared = vi.spyOn(globalThis, "clearTimeout");

    const task = await h.server.send({ text: "hello", contextId: "c" });

    expect(stateName(task.status.state)).toBe("completed");
    // the 10 minute prompt timer was cleared, not left to keep the process alive
    expect(cleared).toHaveBeenCalled();
    await tick();
    expect(h.session.listenerCount("assistant.usage")).toBe(0);
  });
});
