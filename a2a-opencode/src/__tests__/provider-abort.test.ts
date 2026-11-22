/**
 * Stopping work: `tasks/cancel` through the real request handler (the task is canceled at once, the server session really
 * stops, the context goes on), the `abort` outcomes, `abortOrphan` for a session whose wrapper process died, and shutdown.
 */

import { describe, expect, it } from "vitest";
import { InMemoryRunStore, summarizeTask, type TaskRunInfo } from "@a2a-wrapper/core";
import { FakeBackend, hang, reply, idle, text } from "./helpers/fake-backend.js";
import { serve, sleep, states, streamText, until, useConfig } from "./helpers/harness.js";

const ctx = useConfig();

const info = (taskId: string, extra: Partial<TaskRunInfo> = {}): TaskRunInfo => ({ runId: "r1", turnId: "t1", taskId, contextId: "ctx", ...extra });

async function startRunning(h: ReturnType<typeof serve>, contextId = "ctx") {
  const live = h.server.startStream({ text: "work", contextId });
  await until(() => h.backend.prompts.length === 1, 2000, "the prompt to reach the server");
  await sleep(10);
  const taskId = (live.events[0] as any).payload.value.id as string;
  return { live, taskId };
}

describe("tasks/cancel", () => {
  for (const kind of ["v1", "v2"] as const) {
    it(`(${kind}) cancels at once, stops the server session, and the context goes on with the same session`, async () => {
      const h = serve(ctx.config, { kind, scripts: [hang("partial"), reply("pong")] });
      h.backend.busy.add("ses_1");
      h.backend.onAbort = (sid) => void h.backend.busy.delete(sid);
      const { live, taskId } = await startRunning(h);

      const t0 = Date.now();
      const canceled = await h.server.cancel(taskId);
      expect(summarizeTask(canceled).state).toBe("canceled");
      expect(Date.now() - t0).toBeLessThan(500);
      await live.done;
      await h.server.registry.drain();

      expect(h.backend.calls.filter((c) => c.startsWith("sessionAbort") || c.startsWith("sessionInterrupt")).length).toBe(1);
      expect(summarizeTask(await h.server.getTask(taskId)).state).toBe("canceled");

      // the aborted session stays valid for the next turn of the context
      const { summary } = await streamText(h.server, "again", "ctx");
      expect(states(summary).at(-1)).toBe("completed");
      expect(h.backend.prompts.map((p) => p.sessionId)).toEqual(["ses_1", "ses_1"]);
    });
  }

  it("a late answer after the cancel is dropped (the task stays canceled)", async () => {
    const h = serve(ctx.config, { scripts: [hang("partial")] });
    const { live, taskId } = await startRunning(h);
    await h.server.cancel(taskId);
    h.backend.emit(text(" more", "ses_1"));
    h.backend.emit(idle("ses_1"));
    await live.done;
    await sleep(50);
    expect(summarizeTask(await h.server.getTask(taskId)).state).toBe("canceled");
  });

  it("an abort the server rejects is treated as unconfirmed: core drops the binding so the context starts afresh", async () => {
    const store = new InMemoryRunStore();
    const h = serve(ctx.config, { scripts: [hang("partial"), reply("fresh")] }, { runStore: store });
    const { live, taskId } = await startRunning(h);
    h.backend.abortError = new Error("HTTP 500");

    await h.server.cancel(taskId);
    await live.done;
    await h.server.registry.drain();
    expect(await store.getBinding("ctx")).toBeUndefined();

    h.backend.abortError = undefined;
    await streamText(h.server, "again", "ctx");
    expect(h.backend.prompts.map((p) => p.sessionId)).toEqual(["ses_1", "ses_2"]);
  });

  it("a cancel while the session is still being opened sends nothing", async () => {
    const backend = new FakeBackend({ scripts: [reply("never")] });
    const create = backend.sessionCreate.bind(backend);
    backend.sessionCreate = async (...a: Parameters<typeof create>) => {
      await sleep(150);
      return create(...a);
    };
    const h = serve(ctx.config, backend);
    const live = h.server.startStream({ text: "work", contextId: "ctx" });
    await until(() => live.events.length >= 1);
    const taskId = (live.events[0] as any).payload.value.id as string;
    await h.server.cancel(taskId);
    await live.done;
    await sleep(250);
    expect(backend.prompts).toHaveLength(0);
  });
});

describe("abort outcomes", () => {
  it("is confirmed when the server says the session is idle, and the session stays reusable", async () => {
    const h = serve(ctx.config, { scripts: [hang("partial")] });
    const { taskId } = await startRunning(h);
    const out = await h.provider.abort(info(taskId), "cancel");
    expect(out).toEqual({ stopped: "confirmed", session: "reusable" });
  });

  it("is unconfirmed when the session is still busy after the wait", async () => {
    const h = serve(ctx.config, { scripts: [hang("partial")] });
    const { taskId } = await startRunning(h);
    h.backend.busy.add("ses_1");
    const t0 = Date.now();
    const out = await h.provider.abort(info(taskId), "cancel");
    expect(out).toEqual({ stopped: "unconfirmed", session: "reusable" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
  }, 15_000);

  it("a turn that is not running has nothing to abort", async () => {
    const h = serve(ctx.config, {});
    expect(await h.provider.abort(info("nope"), "cancel")).toEqual({ stopped: "confirmed", session: "reusable" });
  });

  it("shutdown stops what is running on the server", async () => {
    const h = serve(ctx.config, { scripts: [hang("partial")] });
    await startRunning(h);
    await h.provider.shutdown();
    expect(h.backend.calls).toContain("sessionAbort:ses_1");
  });
});

describe("abortOrphan: the SERVER session outlives the wrapper", () => {
  const orphan = (ref?: string, reason = "cancel") => ({ runId: "r", turnId: "t", taskId: "task-x", contextId: "c", reason, ...(ref ? { session: { ref } } : {}) });

  it("stops the session by id and reports confirmed only when the server says it is idle", async () => {
    const h = serve(ctx.config, { existingSessions: ["ses_9"] });
    h.backend.busy.add("ses_9");
    h.backend.onAbort = (sid) => void h.backend.busy.delete(sid);
    expect(await h.provider.abortOrphan(orphan("ses_9"))).toEqual({ stopped: "confirmed", session: "reusable" });
    expect(h.backend.calls).toContain("sessionAbort:ses_9");
  });

  it("a cancel cancels exactly the held handles core names (the rest of the inbox is not ours); an interrupt cancels none", async () => {
    const h = serve(ctx.config, { kind: "v2", existingSessions: ["ses_9"] });
    h.backend.inbox.set("m1", { id: "m1", sessionId: "ses_9", text: "ours", delivery: "steer" });
    h.backend.inbox.set("m2", { id: "m2", sessionId: "ses_9", text: "a person typed this", delivery: "queue" });
    await h.provider.abortOrphan({ ...orphan("ses_9", "interrupt"), heldHandles: ["m1"] });
    expect(h.backend.calls).not.toContain("inboxCancel:m1");
    await h.provider.abortOrphan(orphan("ses_9", "cancel")); // no handles known: nothing to cancel
    expect(h.backend.calls.filter((c) => c.startsWith("inboxCancel"))).toEqual([]);
    await h.provider.abortOrphan({ ...orphan("ses_9", "cancel"), heldHandles: ["m1"] });
    expect(h.backend.calls.filter((c) => c.startsWith("inboxCancel"))).toEqual(["inboxCancel:m1"]);
    expect(h.backend.inbox.has("m2")).toBe(true);
  });

  it("unconfirmed when the server does not go idle", async () => {
    const h = serve(ctx.config, { existingSessions: ["ses_9"] });
    h.backend.busy.add("ses_9");
    expect(await h.provider.abortOrphan(orphan("ses_9"))).toEqual({ stopped: "unconfirmed", session: "reusable" });
  }, 15_000);

  it("a session the server does not know is gone: nothing runs there, and core may discard the binding", async () => {
    const h = serve(ctx.config, {});
    expect(await h.provider.abortOrphan(orphan("ses_missing"))).toEqual({ stopped: "confirmed", session: "discard" });
    expect(h.backend.calls.some((c) => c.startsWith("sessionAbort"))).toBe(false);
  });

  it("without a session reference there is nothing to ask the server about: unconfirmed", async () => {
    const h = serve(ctx.config, {});
    expect(await h.provider.abortOrphan(orphan())).toEqual({ stopped: "unconfirmed", session: "reusable" });
  });

  it("a server that cannot be reached or refuses the abort is the failed outcome", async () => {
    const h = serve(ctx.config, { existingSessions: ["ses_9"] });
    h.backend.abortError = new Error("HTTP 500");
    expect(await h.provider.abortOrphan(orphan("ses_9"))).toEqual({ stopped: "unconfirmed", session: "discard" });
  });
});

describe("a turn that is interrupted", () => {
  it("is not an error: the lifecycle closes and the next turn runs on the same session", async () => {
    const h = serve(ctx.config, { scripts: [hang("partial"), reply("INTERRUPTED")] });
    const { live, taskId } = await startRunning(h);
    const r = await h.server.stream({ text: "stop that", contextId: "ctx", taskId, delivery: "interrupt" });
    expect(r.error).toBeUndefined();
    await live.done;
    await h.server.registry.drain();
    expect(summarizeTask(await h.server.getTask(taskId)).state).toBe("completed");
    expect(h.backend.prompts.map((p) => p.sessionId)).toEqual(["ses_1", "ses_1"]);
  });
});
