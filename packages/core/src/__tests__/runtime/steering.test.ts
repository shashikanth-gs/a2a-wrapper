/**
 * Steering of in-flight tasks (#109): `RunRegistry.deliver` and the turn sequence, through the real registry with a fake
 * provider. Every delivery (`queue`, `steer`, `interrupt`) against every provider capability (steer handler present or not
 * and what it returns, abort handler present or not), the termination rule, interactions, cancel and restart.
 * The A2A side (what a streaming or blocking caller receives) is in `a2a/steering-e2e.test.ts`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ANONYMOUS_CALLER,
  InMemoryRunStore,
  RunRegistry,
  deliveryFromSteer,
  messageHasContent,
  newRecordHeader,
  resolveDelivery,
  type CoreInteractionRequest,
  type DeliveryResult,
  type QueuedMessageRecord,
} from "../../index.js";
import { lastInteraction, makeInit, makeMessage, makePublisher, makeProvider, makeReply, requestFor, tick, type FakePublisher } from "./harness.js";

afterEach(() => {
  vi.useRealTimers();
});

async function until(cond: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

type Setup = ReturnType<typeof setup>;

function setup(
  providerOpts: Parameters<typeof makeProvider>[0] = {},
  reg: Partial<ConstructorParameters<typeof RunRegistry>[0]> = {},
) {
  const provider = makeProvider(providerOpts);
  const store = new InMemoryRunStore();
  const warn = vi.fn();
  const registry = new RunRegistry({ provider, store, logger: { warn }, ...reg });
  return { provider, store, registry, warn };
}

/** Start a run and wait until the provider is running its first turn. */
async function startRun(s: Setup, taskId = "t1", contextId = "ctx", publisher: FakePublisher = makePublisher()) {
  const done = s.registry.execute(makeInit(taskId, contextId, publisher));
  const before = s.provider.runs.length;
  await until(() => s.provider.runs.length > before, "provider.run");
  return { done, publisher, call: s.provider.runs[s.provider.runs.length - 1] };
}

const deliver = (s: Setup, message = makeMessage("queue"), taskId = "t1", by = ANONYMOUS_CALLER): Promise<DeliveryResult> =>
  s.registry.deliver(taskId, message, by, requestFor(taskId, message));

const inputText = (call: { req: { input: readonly unknown[] } }) => (call.req.input[0] as { text: string }).text;
const records = (s: Setup, taskId = "t1") => s.store.listQueued(taskId);
const queuedRecord = (id: string, over: Partial<QueuedMessageRecord> = {}): QueuedMessageRecord => ({
  ...newRecordHeader({ id: "anonymous", kind: "anonymous" }, "t"),
  taskId: "t1",
  contextId: "ctx",
  message: makeMessage("queue", "text", { id }),
  holder: "core",
  state: "queued",
  ...over,
});

describe("delivery helpers", () => {
  it("resolveDelivery: absent is an implicit queue, a known word is explicit, anything else is unsupported (never guessed)", () => {
    expect(resolveDelivery(undefined)).toEqual({ kind: "queue", explicit: false });
    expect(resolveDelivery("")).toEqual({ kind: "queue", explicit: false });
    expect(resolveDelivery("queue")).toEqual({ kind: "queue", explicit: true });
    expect(resolveDelivery("steer")).toEqual({ kind: "steer", explicit: true });
    expect(resolveDelivery("interrupt")).toEqual({ kind: "interrupt", explicit: true });
    expect(resolveDelivery("Steer")).toEqual({ kind: "unsupported", explicit: true, value: "Steer" });
    expect(resolveDelivery("replace")).toEqual({ kind: "unsupported", explicit: true, value: "replace" });
  });

  it("messageHasContent: blank text is no content; a file, a data part or an unknown part is", () => {
    expect(messageHasContent({ parts: [] })).toBe(false);
    expect(messageHasContent({ parts: [{ kind: "text", text: "  \n" }] })).toBe(false);
    expect(messageHasContent({ parts: [{ kind: "text", text: "go" }] })).toBe(true);
    expect(messageHasContent({ parts: [{ kind: "data", data: { a: 1 } }] })).toBe(true);
    expect(messageHasContent({ parts: [{ kind: "file", bytes: new Uint8Array([1]) }] })).toBe(true);
    expect(messageHasContent({ parts: [{ kind: "unknown", raw: {} }] })).toBe(true);
  });

  it("deliveryFromSteer: inserted, queued (the provider holds it) and rejected; an unknown state is rejected as unsupported", () => {
    expect(deliveryFromSteer("t", "m", { state: "inserted" })).toEqual({ state: "inserted", taskId: "t", messageId: "m" });
    expect(deliveryFromSteer("t", "m", { state: "queued", handle: "h" })).toEqual({ state: "queued", taskId: "t", messageId: "m", holder: "provider" });
    expect(deliveryFromSteer("t", "m", { state: "rejected", reason: "not-steerable", detail: "d" })).toEqual({
      state: "rejected", taskId: "t", messageId: "m", reason: "not-steerable", detail: "d",
    });
    expect(deliveryFromSteer("t", "m", { state: "from-the-future" } as never)).toMatchObject({ state: "rejected", reason: "unsupported" });
  });
});

describe("queue (the default): the next turn of the same task", () => {
  it("is queued by core, persisted, runs as the next turn (same run, new turn id) after the running one, and the task ends once", async () => {
    const s = setup();
    const first = await startRun(s);
    const m = makeMessage("queue", "two");
    expect(await deliver(s, m)).toEqual({ state: "queued", taskId: "t1", messageId: m.id, holder: "core", position: 1 });
    await tick();
    expect(s.provider.runs).toHaveLength(1); // never concurrently
    expect(await records(s)).toMatchObject([{ state: "queued", holder: "core", message: { id: m.id } }]);

    first.call.view.complete({ text: "one" });
    await until(() => s.provider.runs.length === 2, "second turn");
    expect(inputText(s.provider.runs[1])).toBe("two");
    expect(s.provider.runs[1].req.runId).toBe(first.call.req.runId);
    expect(s.provider.runs[1].req.turnId).not.toBe(first.call.req.turnId);
    expect((await records(s))[0].state).toBe("running"); // claimed queued -> running before provider.run
    expect(first.publisher.terminal()).toEqual([]); // the task is not terminal between turns
    // what the first turn produced is output now, not lost
    expect(first.publisher.statuses()).toContainEqual(expect.objectContaining({ state: "working", text: "one" }));

    s.provider.runs[1].view.complete({ text: "two" });
    expect(await first.done).toBe("ended");
    expect(first.publisher.terminal().map((t) => [t.state, t.text])).toEqual([["completed", "two"]]);
    await s.registry.drain();
    expect((await records(s))[0].state).toBe("done");
  });

  it("an omitted delivery is a queue", async () => {
    const s = setup();
    await startRun(s);
    expect(await deliver(s, makeMessage(undefined, "x"))).toMatchObject({ state: "queued", holder: "core", position: 1 });
  });

  it("keeps order and reports an honest position; the stored ordering key never collides after a message started", async () => {
    const s = setup();
    const first = await startRun(s);
    const [a, b, c, d] = ["a", "b", "c", "d"].map((t) => makeMessage("queue", t, { id: `m-${t}` }));
    expect(await deliver(s, a)).toMatchObject({ position: 1 });
    expect(await deliver(s, b)).toMatchObject({ position: 2 });
    expect(await deliver(s, c)).toMatchObject({ position: 3 });

    first.call.view.complete({ text: "0" });
    await until(() => s.provider.runs.length === 2);
    expect(inputText(s.provider.runs[1])).toBe("a");
    // a started, so b and c are ahead of d: its live position is 3, but its stored key is above every earlier one
    expect(await deliver(s, d)).toMatchObject({ position: 3 });
    expect((await records(s)).map((r) => r.message.id)).toEqual(["m-a", "m-b", "m-c", "m-d"]);
    const keys = (await records(s)).map((r) => r.position!);
    expect(new Set(keys).size).toBe(4);
    expect(keys).toEqual([...keys].sort((x, y) => x - y));

    for (let n = 1; n < 4; n++) {
      s.provider.runs[n].view.complete({ text: String(n) });
      await until(() => s.provider.runs.length === n + 2);
    }
    expect(s.provider.runs.slice(1).map(inputText)).toEqual(["a", "b", "c", "d"]);
    await s.registry.drain();
    expect((await records(s)).map((r) => r.state)).toEqual(["done", "done", "done", "running"]); // d is running now
  });

  it("a duplicate message id gets the first answer and never enqueues twice (sequential and concurrent)", async () => {
    const s = setup();
    const first = await startRun(s);
    const m = makeMessage("queue", "once", { id: "dup-1" });
    const [r1, r2, r3] = await Promise.all([deliver(s, m), deliver(s, m), deliver(s, m)]);
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(await deliver(s, m)).toEqual(r1);
    expect(await records(s)).toHaveLength(1);

    first.call.view.complete({ text: "x" });
    await until(() => s.provider.runs.length === 2);
    s.provider.runs[1].view.complete({ text: "y" });
    await first.done;
    expect(s.provider.runs).toHaveLength(2); // the duplicate never became a turn
  });

  it("an idempotencyKey de-duplicates messages with different ids", async () => {
    const s = setup();
    await startRun(s);
    const r1 = await deliver(s, makeMessage("queue", "a", { idempotencyKey: "k1" }));
    const r2 = await deliver(s, makeMessage("queue", "a", { idempotencyKey: "k1" }));
    expect(r1).toMatchObject({ state: "queued", position: 1 });
    expect(r2).toEqual(r1);
    expect(await records(s)).toHaveLength(1);
  });

  it("a message id the store already holds (a retry after a restart) is reported queued as a duplicate, not enqueued again", async () => {
    const s = setup();
    await startRun(s);
    await s.store.putQueued(queuedRecord("old-1", { position: 1 }));
    const r = await s.registry.deliver("t1", makeMessage("queue", "again", { id: "old-1" }), ANONYMOUS_CALLER, requestFor("t1", makeMessage()));
    expect(r).toMatchObject({ state: "queued", holder: "core", reason: "duplicate" });
    expect(await records(s)).toHaveLength(1);
  });

  it("an unknown delivery word is rejected as unsupported (never guessed, never queued)", async () => {
    const s = setup();
    await startRun(s);
    const m = makeMessage("replace", "x");
    expect(await deliver(s, m)).toEqual({ state: "rejected", taskId: "t1", messageId: m.id, reason: "unsupported-delivery", detail: 'unknown delivery "replace"' });
    expect(await records(s)).toEqual([]);
  });

  it("a task that is not running (unknown, ended) rejects with the reason", async () => {
    const s = setup();
    expect(await deliver(s, makeMessage("queue"), "nope")).toMatchObject({ state: "rejected", reason: "unknown-task" });
    const first = await startRun(s);
    first.call.view.complete({ text: "done" });
    await first.done;
    expect(await deliver(s)).toMatchObject({ state: "rejected", reason: "unknown-task" });
  });

  it("every intent goes through the authorize choke point with its own action; a denial changes nothing", async () => {
    const authorize = vi.fn((_by: unknown, action: string) => action !== "steer");
    const s = setup({ steer: async () => ({ state: "inserted" }) }, { authorize });
    await startRun(s);
    expect(await deliver(s, makeMessage("queue", "q"))).toMatchObject({ state: "queued" });
    expect(await deliver(s, makeMessage("steer", "s"))).toMatchObject({ state: "rejected", reason: "denied" });
    expect(await deliver(s, makeMessage("interrupt", "i"))).toMatchObject({ state: "interrupted" });
    expect(authorize.mock.calls.map((c) => c[1])).toEqual(["queue", "steer", "interrupt"]);
    expect(authorize.mock.calls[0][2]).toMatchObject({ taskId: "t1", contextId: "ctx" });
    expect(s.provider.steer).not.toHaveBeenCalled();
    // an async authorizer that throws is a denial
    const s2 = setup({}, { authorize: async () => { throw new Error("policy down"); } });
    await startRun(s2);
    expect(await deliver(s2)).toMatchObject({ state: "rejected", reason: "denied" });
  });
});

describe("steer x provider capability", () => {
  it("no steer handler: core queues it and says so honestly (queued, holder core), and it runs as the next turn", async () => {
    const s = setup();
    const first = await startRun(s);
    const m = makeMessage("steer", "focus on x");
    const r = await deliver(s, m);
    expect(r).toMatchObject({ state: "queued", holder: "core", position: 1, reason: expect.stringMatching(/^steer-unsupported/) });
    first.call.view.complete({ text: "one" });
    await until(() => s.provider.runs.length === 2);
    expect(inputText(s.provider.runs[1])).toBe("focus on x");
  });

  it("handler returns inserted: the caller is told inserted, the handler got the RUNNING turn's view and the message, nothing is queued", async () => {
    const s = setup({ steer: async () => ({ state: "inserted" }) });
    const first = await startRun(s);
    const m = makeMessage("steer", "also y");
    expect(await deliver(s, m)).toEqual({ state: "inserted", taskId: "t1", messageId: m.id });
    expect(s.provider.steer).toHaveBeenCalledTimes(1);
    const [view, msg] = s.provider.steer.mock.calls[0];
    expect(view).toMatchObject({ taskId: "t1", runId: first.call.req.runId, turnId: first.call.req.turnId });
    expect(msg).toMatchObject({ id: m.id, delivery: "steer" });
    expect(await records(s)).toEqual([]);
    first.call.view.complete({ text: "one" });
    expect(await first.done).toBe("ended");
    expect(s.provider.runs).toHaveLength(1);
  });

  it("handler returns queued{handle}: core tracks the held message, the task is NOT terminal until it ran or was dropped (beginHeldTurn)", async () => {
    const s = setup({ steer: async () => ({ state: "queued", handle: "h1" }) });
    const first = await startRun(s);
    const m = makeMessage("steer", "later");
    expect(await deliver(s, m)).toEqual({ state: "queued", taskId: "t1", messageId: m.id, holder: "provider" });
    expect(await records(s)).toMatchObject([{ holder: "provider", handle: "h1", state: "queued", message: { id: m.id } }]);

    first.call.view.complete({ text: "one" });
    await tick();
    await tick();
    expect(first.publisher.terminal()).toEqual([]);
    expect(s.registry.isLive("t1")).toBe(true);
    expect(first.publisher.statuses()).toContainEqual(expect.objectContaining({ state: "working", text: "one" }));

    const held = first.call.view.beginHeldTurn("h1");
    expect(held.runId).toBe(first.call.req.runId);
    expect(held.turnId).not.toBe(first.call.req.turnId);
    held.event({ type: "text", text: "held output" });
    held.complete({});
    expect(await first.done).toBe("ended");
    expect(first.publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
    await s.registry.drain();
    expect((await records(s))[0].state).toBe("done");
    expect(s.provider.runs).toHaveLength(1); // the provider ran it itself
  });

  it("a held message the provider drops lets the task end (dropHeld), and the record says dropped", async () => {
    const s = setup({ steer: async () => ({ state: "queued", handle: "h1" }) });
    const first = await startRun(s);
    await deliver(s, makeMessage("steer", "later"));
    first.call.view.complete({ text: "one" });
    await tick();
    expect(first.publisher.terminal()).toEqual([]);
    first.call.view.dropHeld("h1");
    expect(await first.done).toBe("ended");
    expect(first.publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
    await s.registry.drain();
    expect((await records(s))[0]).toMatchObject({ state: "dropped", reason: "dropped by the provider" });
  });

  it("handler returns rejected: the caller is told, the message is NOT queued, and a retry of the same id tries again", async () => {
    const s = setup({ steer: async () => ({ state: "rejected", reason: "not-steerable", detail: "a review turn" }) });
    const first = await startRun(s);
    const m = makeMessage("steer", "no");
    expect(await deliver(s, m)).toEqual({ state: "rejected", taskId: "t1", messageId: m.id, reason: "not-steerable", detail: "a review turn" });
    expect(await records(s)).toEqual([]);
    await deliver(s, m);
    expect(s.provider.steer).toHaveBeenCalledTimes(2); // a definitive rejection changed nothing, so it is not remembered
    first.call.view.complete({ text: "one" });
    expect(await first.done).toBe("ended");
    expect(s.provider.runs).toHaveLength(1); // never silently queued
  });

  it("handler fails or hangs: rejected steer-failed, and the same message id is NOT retried (the provider may have taken it)", async () => {
    const s = setup({ steer: () => new Promise(() => {}) }, { steerTimeoutMs: 20 });
    await startRun(s);
    const m = makeMessage("steer", "x");
    expect(await deliver(s, m)).toMatchObject({ state: "rejected", reason: "steer-failed", detail: expect.stringContaining("timed out") });
    expect(await deliver(s, m)).toMatchObject({ state: "rejected", reason: "steer-failed" });
    expect(s.provider.steer).toHaveBeenCalledTimes(1);

    const s2 = setup({ steer: async () => { throw new Error("boom"); } });
    await startRun(s2);
    expect(await deliver(s2, makeMessage("steer", "x"))).toMatchObject({ state: "rejected", reason: "steer-failed", detail: "boom" });
    expect(await records(s2)).toEqual([]);
  });

  it("handler answers queued without a handle, or a state core does not know: rejected, never assumed queued", async () => {
    const s = setup({ steer: async () => ({ state: "queued" }) as never });
    await startRun(s);
    expect(await deliver(s, makeMessage("steer", "x"))).toMatchObject({ state: "rejected", reason: "steer-invalid" });
    const s2 = setup({ steer: async () => ({ state: "from-the-future" }) as never });
    await startRun(s2);
    expect(await deliver(s2, makeMessage("steer", "x"))).toMatchObject({ state: "rejected", reason: "unsupported" });
    const s3 = setup({ steer: async () => undefined as never });
    await startRun(s3);
    expect(await deliver(s3, makeMessage("steer", "x"))).toMatchObject({ state: "rejected", reason: "unsupported" });
  });

  it("no running turn to steer (the turn was just stopped): queued behind, reason no-active-turn; the handler is not called", async () => {
    const s = setup({ steer: async () => ({ state: "inserted" }), abort: () => new Promise(() => {}) });
    await startRun(s);
    await s.registry.interrupt("t1", ANONYMOUS_CALLER); // the abort never settles: the turn is stopped, nothing runs
    expect(await deliver(s, makeMessage("steer", "x"))).toMatchObject({ state: "queued", holder: "core", reason: "no-active-turn" });
    expect(s.provider.steer).not.toHaveBeenCalled();
  });

  it("a steer in flight when the turn completes: the task stays open, and `inserted` is NOT reported for a message the ended turn may never have seen (it runs as the next turn)", async () => {
    let release!: (o: { state: "inserted" }) => void;
    const s = setup({ steer: () => new Promise((r) => (release = r as never)) });
    const first = await startRun(s);
    const m = makeMessage("steer", "late steer");
    const pending = deliver(s, m);
    await tick();
    first.call.view.complete({ text: "one" }); // the turn ends under the in-flight steer
    await tick();
    await tick();
    expect(first.publisher.terminal()).toEqual([]); // not terminal while a steer is in flight
    release({ state: "inserted" });
    expect(await pending).toEqual({ state: "queued", taskId: "t1", messageId: m.id, holder: "core", position: 1, reason: "turn-ended-during-steer" });
    await until(() => s.provider.runs.length === 2, "the message runs");
    expect(inputText(s.provider.runs[1])).toBe("late steer");
    s.provider.runs[1].view.complete({ text: "two" });
    expect(await first.done).toBe("ended");
    expect(first.publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
  });

  it("a steer that is rejected after the turn ended: reported rejected, nothing queued, and the task then finishes (exactly one terminal)", async () => {
    let release!: (o: { state: "rejected"; reason: string }) => void;
    const s = setup({ steer: () => new Promise((r) => (release = r as never)) });
    const first = await startRun(s);
    const m = makeMessage("steer", "x");
    const pending = deliver(s, m);
    await tick();
    first.call.view.complete({ text: "one" });
    await tick();
    expect(first.publisher.terminal()).toEqual([]);
    release({ state: "rejected", reason: "no-active-turn" });
    expect(await pending).toMatchObject({ state: "rejected", reason: "no-active-turn" });
    expect(await first.done).toBe("ended");
    expect(first.publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
    expect(s.provider.runs).toHaveLength(1);
    expect(await records(s)).toEqual([]);
  });

  it("a steer that is rejected after the turn ended still lets a task whose last turn failed end failed", async () => {
    let release!: (o: { state: "rejected"; reason: string }) => void;
    const s = setup({ steer: () => new Promise((r) => (release = r as never)) });
    const first = await startRun(s);
    const pending = deliver(s, makeMessage("steer", "x"));
    await tick();
    first.call.view.fail({ message: "boom" });
    await tick();
    release({ state: "rejected", reason: "not-steerable" });
    await pending;
    await first.done;
    expect(first.publisher.terminal().map((t) => [t.state, t.text])).toEqual([["failed", "boom"]]);
  });

  it("a steer that the provider answers after the task ended is rejected task-ended, not reported queued", async () => {
    let release!: (o: { state: "queued"; handle: string }) => void;
    const s = setup({ steer: () => new Promise((r) => (release = r as never)) });
    const first = await startRun(s);
    const pending = deliver(s, makeMessage("steer", "late"));
    await tick();
    await s.registry.cancel("t1", ANONYMOUS_CALLER); // the task ends while the steer is pending
    await first.done;
    release({ state: "queued", handle: "h-late" });
    expect(await pending).toMatchObject({ state: "rejected", reason: "task-ended" });
  });
});

describe("interrupt x provider capability", () => {
  it("with an abort handler: the turn is aborted (reason interrupt), the message is the next turn after the abort settled, the task never goes canceled", async () => {
    let finishAbort!: () => void;
    const s = setup({ abort: () => new Promise((r) => (finishAbort = () => r({ stopped: "confirmed", session: "reusable" }))) });
    const first = await startRun(s);
    const m = makeMessage("interrupt", "change course");
    expect(await deliver(s, m)).toEqual({ state: "interrupted", taskId: "t1", messageId: m.id });
    expect(first.call.view.signal.reason).toBe("interrupt");
    expect(s.provider.abort).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1", turnId: first.call.req.turnId }), "interrupt");
    await tick();
    await tick();
    expect(s.provider.runs).toHaveLength(1); // the lane waits for the abort (#107)
    finishAbort();
    await until(() => s.provider.runs.length === 2, "next turn");
    expect(inputText(s.provider.runs[1])).toBe("change course");
    expect(s.provider.runs[1].req.runId).toBe(first.call.req.runId);
    expect(s.provider.runs[1].req.turnId).not.toBe(first.call.req.turnId);
    expect(s.provider.runs[1].view.signal.aborted).toBe(false);
    expect(first.publisher.terminal()).toEqual([]);

    first.call.view.complete({ text: "from the stopped turn" }); // dropped
    s.provider.runs[1].view.complete({ text: "after" });
    expect(await first.done).toBe("ended");
    expect(first.publisher.terminal().map((t) => [t.state, t.text])).toEqual([["completed", "after"]]);
  });

  it("without an abort handler it degrades to a queue, honestly: queued with the reason, the running turn is NOT touched", async () => {
    const s = setup({ noAbort: true });
    const first = await startRun(s);
    const r = await deliver(s, makeMessage("interrupt", "stop that"));
    expect(r).toMatchObject({ state: "queued", holder: "core", position: 1, reason: expect.stringMatching(/^interrupt-unsupported/) });
    expect(first.call.view.signal.aborted).toBe(false);
    first.call.view.complete({ text: "one" });
    await until(() => s.provider.runs.length === 2);
    expect(inputText(s.provider.runs[1])).toBe("stop that");
  });

  it("with nothing running (the turn was already stopped) it is queued as the next turn, reason no-active-turn", async () => {
    const s = setup({ abort: () => new Promise(() => {}) });
    await startRun(s);
    await s.registry.interrupt("t1", ANONYMOUS_CALLER);
    expect(await deliver(s, makeMessage("interrupt", "x"))).toMatchObject({ state: "queued", reason: "no-active-turn" });
  });

  it("an interrupt runs NEXT: the interrupting message goes ahead of messages that were already queued, which keep their order behind it (design doc 3.4: the message becomes the next turn)", async () => {
    const s = setup();
    const first = await startRun(s);
    await deliver(s, makeMessage("queue", "earlier"));
    await deliver(s, makeMessage("queue", "earlier 2"));
    await deliver(s, makeMessage("interrupt", "now"));
    await until(() => s.provider.runs.length === 2);
    first.call.view.complete({ text: "ignored" });
    expect(inputText(s.provider.runs[1])).toBe("now");
    s.provider.runs[1].view.complete({ text: "n" });
    await until(() => s.provider.runs.length === 3);
    expect(inputText(s.provider.runs[2])).toBe("earlier");
    s.provider.runs[2].view.complete({ text: "e" });
    await until(() => s.provider.runs.length === 4);
    expect(inputText(s.provider.runs[3])).toBe("earlier 2");
    // the persisted order is the live order (a restart replays by position)
    const positions = (await s.store.listQueued("t1")).map((r) => r.message.parts.map((p: any) => p.text).join(""));
    expect(positions).toEqual(["now", "earlier", "earlier 2"]);
  });
});

describe("interrupt with no follow-up content: stop and wait (decision 2)", () => {
  it("aborts the turn and parks the task in input-required, marked interrupted, holding its context lane; the next message continues it", async () => {
    const s = setup();
    const first = await startRun(s);
    const other = s.registry.execute(makeInit("t2", "ctx")); // same context: waits in the lane
    const r = await deliver(s, makeMessage("interrupt", ""));
    expect(r).toMatchObject({ state: "interrupted" });
    expect(await first.done).toBe("parked");
    await s.registry.drain();
    expect((await s.store.getRun("t1"))?.state).toBe("input-required");
    expect(first.publisher.statuses().at(-1)).toMatchObject({ state: "input-required", metadata: { interrupted: true } });
    expect(first.publisher.terminal()).toEqual([]);
    expect(s.registry.isParked("t1")).toBe(true);
    expect(s.registry.isLive("t1")).toBe(true);
    expect(s.provider.abort).toHaveBeenCalledWith(expect.anything(), "interrupt");
    await tick();
    expect(s.provider.runs).toHaveLength(1); // t2 is still waiting: t1 holds the lane

    const m = makeMessage("queue", "carry on");
    expect(await deliver(s, m)).toMatchObject({ state: "queued", holder: "core", position: 1, reason: "continues-interrupted-task" });
    expect(first.publisher.statuses().at(-1)).toMatchObject({ state: "working", metadata: { interrupted: false } });
    await until(() => s.provider.runs.length === 2);
    expect(inputText(s.provider.runs[1])).toBe("carry on");
    expect(s.provider.runs[1].req.runId).toBe(first.call.req.runId);
    expect(s.registry.isParked("t1")).toBe(false);
    s.provider.runs[1].view.complete({ text: "done" });
    await until(() => s.provider.runs.length === 3, "t2 starts once t1 ended");
    expect(s.provider.runs[2].req.taskId).toBe("t2");
    s.provider.runs[2].view.complete({ text: "t2" });
    await other;
  });

  it("any intent continues it: a steer to an interrupted task is the message that continues it", async () => {
    const s = setup({ steer: async () => ({ state: "inserted" }) });
    await startRun(s);
    await deliver(s, makeMessage("interrupt", ""));
    await s.registry.drain();
    expect(await deliver(s, makeMessage("steer", "go"))).toMatchObject({ state: "queued", reason: "continues-interrupted-task" });
    await until(() => s.provider.runs.length === 2);
    expect(s.provider.steer).not.toHaveBeenCalled();
  });

  it("a task nobody continues fails with timeout after interruptedTimeoutMs and releases its lane", async () => {
    const s = setup({}, { interruptedTimeoutMs: 25 });
    const first = await startRun(s);
    const other = s.registry.execute(makeInit("t2", "ctx"));
    await deliver(s, makeMessage("interrupt", ""));
    await vi.waitFor(() => expect(first.publisher.terminal().map((t) => [t.state, t.metadata?.code])).toEqual([["failed", "timeout"]]));
    await until(() => s.provider.runs.length === 2, "t2 starts after the lane is released");
    expect(s.provider.runs[1].req.taskId).toBe("t2");
    s.provider.runs[1].view.complete({ text: "t2" });
    await other;
  });

  it("cancel of an interrupted task ends it canceled once and releases the lane", async () => {
    const s = setup();
    const first = await startRun(s);
    const other = s.registry.execute(makeInit("t2", "ctx"));
    await deliver(s, makeMessage("interrupt", ""));
    await s.registry.drain();
    expect(await s.registry.cancel("t1", ANONYMOUS_CALLER)).toMatchObject({ claimed: true });
    expect(first.publisher.terminal().map((t) => t.state)).toEqual(["canceled"]);
    await until(() => s.provider.runs.length === 2);
    s.provider.runs[1].view.complete({ text: "t2" });
    await other;
  });

  it("the interrupt primitive with no message parks the same way (the open question of #107 is closed)", async () => {
    const s = setup();
    await startRun(s);
    expect(await s.registry.interrupt("t1", ANONYMOUS_CALLER)).toEqual({ interrupted: true });
    await s.registry.drain();
    expect((await s.store.getRun("t1"))?.state).toBe("input-required");
  });
});

describe("interactions and steering (decision 1)", () => {
  const permission = (): CoreInteractionRequest => ({
    kind: "permission",
    title: "Run npm test?",
    options: [
      { id: "once", label: "Allow once", kind: "allow_once" },
      { id: "no", label: "Reject", kind: "reject_once" },
    ],
  });

  async function park(s: Setup) {
    const pub = makePublisher();
    const done = s.registry.execute(makeInit("t1", "ctx", pub));
    await until(() => s.provider.runs.length > 0);
    const call = s.provider.runs[0];
    const answer = call.view.ask(permission());
    expect(await done).toBe("parked");
    return { pub, call, answer };
  }
  const interactionSetup = (opts: Parameters<typeof makeProvider>[0] = {}) =>
    setup({ steer: async () => ({ state: "inserted" }), ...opts }, { interactionPolicy: { mode: "ask" } });
  const reply = (pub: FakePublisher, data: Record<string, unknown>) => [{ kind: "data" as const, data: { interactionId: lastInteraction(pub).id, ...data } }];
  const pendingStates = async (s: Setup) => (await s.store.listPending("t1")).map((p) => p.state);

  it("a steer while an interaction is presented does NOT answer it and does not reach the provider: queued behind it, honestly", async () => {
    const s = interactionSetup();
    const { pub, call, answer } = await park(s);
    const m = makeMessage("steer", "yes please");
    expect(await deliver(s, m)).toMatchObject({ state: "queued", holder: "core", position: 1, reason: expect.stringMatching(/^interaction-presented/) });
    expect(s.provider.steer).not.toHaveBeenCalled();
    expect(await pendingStates(s)).toEqual(["presented"]); // not answered, not withdrawn
    expect(pub.calls.filter((c) => c.k === "interaction")).toHaveLength(1); // not even re-prompted

    // The person answers; the steer then runs as the next turn.
    const replied = s.registry.execute(makeReply("t1", reply(pub, { optionId: "once" })));
    expect(await answer).toMatchObject({ outcome: "selected", optionId: "once" });
    call.view.complete({ text: "first turn" });
    await until(() => s.provider.runs.length === 2, "the queued steer runs");
    expect(inputText(s.provider.runs[1])).toBe("yes please");
    s.provider.runs[1].view.complete({ text: "second" });
    expect(await replied).toBe("ended");
  });

  it("an explicit queue that is not a reply waits behind the interaction (no re-prompt); one that IS a reply answers it", async () => {
    const s = interactionSetup();
    const { pub, call, answer } = await park(s);
    expect(await deliver(s, makeMessage("queue", "later"))).toMatchObject({ state: "queued", position: 1 });
    expect(pub.calls.filter((c) => c.k === "interaction")).toHaveLength(1);
    expect(await pendingStates(s)).toEqual(["presented"]);

    const r = makeReply("t1", reply(pub, { optionId: "once" }));
    const replied = s.registry.execute({ ...r, message: { ...r.message!, delivery: "queue" } });
    expect(await answer).toMatchObject({ outcome: "selected" });
    expect(await pendingStates(s)).toEqual(["answered"]);
    call.view.complete({ text: "one" });
    await until(() => s.provider.runs.length === 2);
    s.provider.runs[1].view.complete({ text: "two" });
    await replied;
  });

  it("a message with no delivery stays a reply attempt first: a non-reply is re-prompted, not queued", async () => {
    const s = interactionSetup();
    const { pub, answer } = await park(s);
    const outcome = await s.registry.execute(makeReply("t1", [{ kind: "text", text: "what?" }], pub));
    expect(outcome).toBe("parked");
    expect(pub.calls.filter((c) => c.k === "interaction")).toHaveLength(2); // re-published with a hint
    expect(await records(s)).toEqual([]);
    void answer;
  });

  it("an interrupt PREEMPTS the interaction: pending settles canceled, the turn is aborted, the message is the next turn", async () => {
    const s = interactionSetup();
    const { call, answer } = await park(s);
    const m = makeMessage("interrupt", "forget that, do this");
    expect(await deliver(s, m)).toEqual({ state: "interrupted", taskId: "t1", messageId: m.id });
    expect(await answer).toEqual({ outcome: "canceled" });
    expect(call.view.signal.reason).toBe("interrupt");
    expect(s.provider.abort).toHaveBeenCalledWith(expect.anything(), "interrupt");
    await until(() => s.provider.runs.length === 2, "next turn");
    expect(inputText(s.provider.runs[1])).toBe("forget that, do this");
    expect(await pendingStates(s)).toEqual(["canceled"]);
    expect(s.registry.isParked("t1")).toBe(false);
    await s.registry.drain();
    expect((await s.store.getRun("t1"))?.state).toBe("working");
    s.provider.runs[1].view.complete({ text: "ok" });
  });

  it("an interrupt with no content preempts the interaction and parks the task interrupted", async () => {
    const s = interactionSetup();
    const { pub, answer } = await park(s);
    expect(await deliver(s, makeMessage("interrupt", ""))).toMatchObject({ state: "interrupted" });
    expect(await answer).toEqual({ outcome: "canceled" });
    await s.registry.drain();
    expect(await pendingStates(s)).toEqual(["canceled"]);
    expect((await s.store.getRun("t1"))?.state).toBe("input-required");
    expect(s.registry.isParked("t1")).toBe(true);
    expect(pub.statuses().at(-1)).toMatchObject({ state: "input-required", metadata: { interrupted: true } });
  });

  it("an interrupt on a provider without abort cannot preempt: queued behind the interaction", async () => {
    const s = interactionSetup({ noAbort: true });
    const { call } = await park(s);
    expect(await deliver(s, makeMessage("interrupt", "x"))).toMatchObject({ state: "queued", reason: expect.stringMatching(/^interrupt-unsupported/) });
    expect(call.view.signal.aborted).toBe(false);
    expect(await pendingStates(s)).toEqual(["presented"]);
  });
});

describe("cancel with queued and held messages", () => {
  it("drops core-queued AND provider-held messages (the records say why), starts nothing, one canceled; a held view after cancel is dead", async () => {
    const s = setup({ steer: async () => ({ state: "queued", handle: "h1" }) });
    const first = await startRun(s);
    await deliver(s, makeMessage("steer", "held"));
    const q = makeMessage("queue", "queued");
    await deliver(s, q);
    expect(await records(s)).toHaveLength(2);

    expect(await s.registry.cancel("t1", ANONYMOUS_CALLER)).toMatchObject({ claimed: true });
    await s.registry.drain();
    expect(first.publisher.terminal().map((t) => t.state)).toEqual(["canceled"]);
    expect((await records(s)).map((r) => [r.holder, r.state, r.reason])).toEqual([
      ["provider", "dropped", "task canceled"],
      ["core", "dropped", "task canceled"],
    ].sort());
    expect(s.provider.abort).toHaveBeenCalledWith(expect.anything(), "cancel"); // the provider is told to flush its own queue
    await tick();
    expect(s.provider.runs).toHaveLength(1);
    const dead = first.call.view.beginHeldTurn("h1");
    dead.event({ type: "text", text: "ignored" });
    dead.complete({ text: "ignored" });
    expect(first.publisher.terminal().map((t) => t.state)).toEqual(["canceled"]);
  });

  it("a cancel while an interrupt's abort is in flight sends abort(cancel) after it and the queued interrupting message never runs", async () => {
    let finishAbort!: () => void;
    const abort = vi.fn((_i: unknown, reason: string) =>
      reason === "interrupt" ? new Promise((r) => (finishAbort = () => r({ stopped: "confirmed", session: "reusable" }))) : Promise.resolve({ stopped: "confirmed", session: "reusable" }),
    );
    const s = setup({ abort: abort as never });
    await startRun(s);
    await deliver(s, makeMessage("interrupt", "next"));
    const canceled = s.registry.cancel("t1", ANONYMOUS_CALLER);
    await canceled;
    finishAbort();
    await s.registry.drain();
    expect(abort.mock.calls.map((c) => c[1])).toEqual(["interrupt", "cancel"]);
    expect(s.provider.runs).toHaveLength(1);
    expect((await records(s))[0]).toMatchObject({ state: "dropped" });
  });
});

describe("the termination rule", () => {
  it("a failed turn with a message queued does not end the task: the failure is reported as non-terminal output and the queue continues", async () => {
    const s = setup();
    const first = await startRun(s);
    await deliver(s, makeMessage("queue", "again"));
    first.call.view.fail({ message: "boom" });
    await until(() => s.provider.runs.length === 2);
    expect(first.publisher.terminal()).toEqual([]);
    expect(first.publisher.statuses()).toContainEqual(expect.objectContaining({ state: "working", text: "The previous turn failed: boom" }));
    s.provider.runs[1].view.complete({ text: "recovered" });
    expect(await first.done).toBe("ended");
    expect(first.publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
  });

  it("the LAST turn decides the terminal state, and an earlier turn's result is not repeated in it", async () => {
    const s = setup();
    const first = await startRun(s);
    await deliver(s, makeMessage("queue", "again"));
    first.call.view.complete({ text: "answer one", artifacts: [{ id: "a1", parts: [{ kind: "text", text: "artifact one" }] }] });
    await until(() => s.provider.runs.length === 2);
    s.provider.runs[1].view.fail({ message: "second failed" });
    await first.done;
    expect(first.publisher.terminal().map((t) => [t.state, t.text])).toEqual([["failed", "second failed"]]);
    const artifacts = first.publisher.calls.filter((c) => c.k === "artifact");
    expect(artifacts).toHaveLength(1); // published once, when turn one ended
    expect(first.publisher.statuses().filter((x) => x.text === "answer one")).toHaveLength(1);
  });

  it("with a held message pending the task stays open even when the provider's run() returns; the liveness backstop then drops it", async () => {
    const s = setup({ steer: async () => ({ state: "queued", handle: "h-forgotten" }) });
    const first = await startRun(s);
    await deliver(s, makeMessage("steer", "x"));
    first.call.view.complete({ text: "one" });
    first.call.resolve(); // run() settles; the provider never begins or drops the held message
    expect(await first.done).toBe("ended");
    expect(s.warn).toHaveBeenCalledWith(expect.stringContaining("neither begun nor dropped"), "h-forgotten");
    await s.registry.drain();
    expect((await records(s))[0].state).toBe("dropped");
  });
});

describe("restart (design doc 3.6): what the sweep does with queue records written by deliver", () => {
  it("replays only records still `queued` (claimed queued -> running first, in position order), never `running` ones; provider-held are dropped only when confirmed", async () => {
    const s = setup({ steer: async () => ({ state: "queued", handle: "h1" }) });
    const first = await startRun(s);
    await deliver(s, makeMessage("queue", "a", { id: "m-a" }));
    await deliver(s, makeMessage("queue", "b", { id: "m-b" }));
    await deliver(s, makeMessage("steer", "held", { id: "m-h" }));
    first.call.view.complete({ text: "turn one" });
    await until(() => s.provider.runs.length === 2); // a is running now (claimed)
    await s.registry.drain();
    expect((await records(s)).map((r) => [r.message.id, r.state])).toEqual([["m-a", "running"], ["m-b", "queued"], ["m-h", "queued"]]);

    // The process dies here. A new registry over the same store sweeps.
    const provider2 = makeProvider({ abortOrphan: async () => ({ stopped: "confirmed", session: "reusable" }) });
    const registry2 = new RunRegistry({ provider: provider2, store: s.store });
    const seen: Array<{ id: string; stateInStore: string | undefined }> = [];
    const report = await registry2.sweep({
      replay: async (rec) => {
        seen.push({ id: rec.message.id, stateInStore: (await s.store.listQueued("t1")).find((r) => r.message.id === rec.message.id)?.state });
      },
    });
    expect(seen).toEqual([{ id: "m-b", stateInStore: "running" }]); // claimed BEFORE the replay; m-a (running) and the held one never
    expect(report.entries[0]).toMatchObject({ action: "turn-failed-queue-continued", queued: { replayed: ["m-b"], dropped: expect.arrayContaining(["m-a", "m-h"]) } });
    const states = Object.fromEntries((await records(s)).map((r) => [r.message.id, [r.state, r.reason]]));
    expect(states["m-a"]).toEqual(["dropped", "was running at restart; never replayed"]);
    expect(states["m-h"][0]).toBe("dropped");
    expect(states["m-b"][0]).toBe("running");
    // a second sweep (another instance) replays nothing: the atomic claim was taken
    const again = await new RunRegistry({ provider: makeProvider(), store: s.store }).sweep({ replay: async () => void seen.push({ id: "again", stateInStore: "" }) });
    expect(seen).toHaveLength(1);
    void again;
  });

  it("a provider-held message whose orphan the provider did not confirm stopped is left `unknown`, never assumed dropped", async () => {
    const s = setup({ steer: async () => ({ state: "queued", handle: "h1" }) });
    await startRun(s);
    await deliver(s, makeMessage("steer", "held", { id: "m-h" }));
    await s.registry.drain();
    const registry2 = new RunRegistry({ provider: makeProvider({ abortOrphan: async () => ({ stopped: "unconfirmed", session: "discard" }) }), store: s.store });
    const report = await registry2.sweep();
    expect(report.entries[0].queued.unknown).toEqual(["m-h"]);
    expect((await records(s))[0].state).toBe("unknown");
  });
});

describe("settleSteer: the real delivery of a provider-held steer, learned after the fact", () => {
  it("inserted: the record is done, the handle stops being held (the task can end), and no turn starts", async () => {
    const s = setup({ steer: async () => ({ state: "queued", handle: "h1" }) });
    const first = await startRun(s);
    await deliver(s, makeMessage("steer", "later"));
    first.call.view.complete({ text: "one" });
    await tick();
    expect(first.publisher.terminal()).toEqual([]); // still held

    first.call.view.settleSteer("h1", "inserted");
    expect(await first.done).toBe("ended");
    expect(first.publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
    await s.registry.drain();
    expect((await records(s))[0]).toMatchObject({ state: "done" });
    expect(s.provider.runs).toHaveLength(1);
  });

  it("dropped: the record is dropped with a reason and the task can end", async () => {
    const s = setup({ steer: async () => ({ state: "queued", handle: "h1" }) });
    const first = await startRun(s);
    await deliver(s, makeMessage("steer", "later"));
    first.call.view.complete({ text: "one" });
    await tick();
    first.call.view.settleSteer("h1", "dropped");
    expect(await first.done).toBe("ended");
    await s.registry.drain();
    expect((await records(s))[0]).toMatchObject({ state: "dropped", reason: expect.stringContaining("dropped") });
  });

  it("is idempotent, and a handle that is not held (or was already begun or dropped) is ignored", async () => {
    const s = setup({ steer: async () => ({ state: "queued", handle: "h1" }) });
    const first = await startRun(s);
    await deliver(s, makeMessage("steer", "later"));
    first.call.view.settleSteer("unknown", "inserted");
    first.call.view.settleSteer("h1", "inserted");
    first.call.view.settleSteer("h1", "dropped"); // the second word does not rewrite the record
    first.call.view.dropHeld("h1");
    expect(() => first.call.view.beginHeldTurn("h1")).toThrow(); // gone: settled
    first.call.view.complete({ text: "one" });
    expect(await first.done).toBe("ended");
    await s.registry.drain();
    expect((await records(s))[0]).toMatchObject({ state: "done" });
  });

  it("while the running turn is still live the task stays open until the settle is not needed: settling mid-turn changes nothing visible", async () => {
    const s = setup({ steer: async () => ({ state: "queued", handle: "h1" }) });
    const first = await startRun(s);
    await deliver(s, makeMessage("steer", "later"));
    first.call.view.settleSteer("h1", "inserted");
    await tick();
    expect(first.publisher.terminal()).toEqual([]); // the turn is still running
    first.call.view.complete({ text: "one" });
    expect(await first.done).toBe("ended");
    expect(first.publisher.terminal().map((t) => t.state)).toEqual(["completed"]); // and ends without waiting for the handle
  });

  it("after a cancel it is a silent no-op (the records were dropped by the cancel)", async () => {
    const s = setup({ steer: async () => ({ state: "queued", handle: "h1" }) });
    const first = await startRun(s);
    await deliver(s, makeMessage("steer", "later"));
    await s.registry.cancel("t1", ANONYMOUS_CALLER, () => first.publisher);
    expect(() => first.call.view.settleSteer("h1", "inserted")).not.toThrow();
    await s.registry.drain();
    expect((await records(s))[0]).toMatchObject({ state: "dropped", reason: "task canceled" });
  });
});
