import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ABORT_FAILED_OUTCOME,
  ANONYMOUS_CALLER,
  CANCELED,
  InMemoryRunStore,
  RunRegistry,
  newRecordHeader,
  type CoreInteractionRequest,
  type CoreInteractionResult,
  type InteractionRuntime,
  type RunHandle,
} from "../../index.js";
import { makeInit, makeProvider, makePublisher, tick } from "./harness.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const owner = { id: "anonymous", kind: "anonymous" };

async function until(cond: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function setup(opts: Parameters<typeof makeProvider>[0] = {}, reg: Partial<ConstructorParameters<typeof RunRegistry>[0]> = {}) {
  const provider = makeProvider(opts);
  const store = new InMemoryRunStore();
  const registry = new RunRegistry({ provider, store, ...reg });
  return { provider, store, registry };
}

/** Start a run and wait until the provider is running its turn. */
async function startRun(
  s: ReturnType<typeof setup>,
  taskId = "t1",
  contextId = "ctx",
  publisher = makePublisher(),
) {
  const done = s.registry.execute(makeInit(taskId, contextId, publisher));
  const before = s.provider.runs.length;
  await until(() => s.provider.runs.length > before, "provider.run");
  return { done, publisher, call: s.provider.runs[s.provider.runs.length - 1] };
}

/** A fake of the interactions runtime (#108): one pending ask, settled by core on cancel. */
function fakeInteractions() {
  const asked: Array<{ request: CoreInteractionRequest; settled?: CoreInteractionResult }> = [];
  const runtime: InteractionRuntime = {
    ask(handle: RunHandle, request) {
      return new Promise<CoreInteractionResult>((resolve) => {
        const entry: (typeof asked)[number] = { request };
        asked.push(entry);
        handle.registerPending({
          cancel() {
            entry.settled = { outcome: "canceled" };
            resolve(entry.settled);
          },
        });
        handle.signalParked();
      });
    },
  };
  return { asked, runtime };
}

describe("RunRegistry.cancel: sequencing", () => {
  it("claims, publishes exactly one canceled status, closes the stream, aborts the signal with reason cancel", async () => {
    const s = setup();
    const { done, publisher, call } = await startRun(s);

    const out = await s.registry.cancel("t1", ANONYMOUS_CALLER);
    expect(out).toMatchObject({ claimed: true });
    expect(publisher.terminal()).toEqual([{ state: "canceled" }]);
    expect(publisher.calls.filter((c) => c.k === "finished")).toHaveLength(1);
    expect(call.view.signal.aborted).toBe(true);
    expect(call.view.signal.reason).toBe("cancel");
    expect(await done).toBe("ended");
    expect(s.registry.isLive("t1")).toBe(false);

    const rec = await s.store.getRun("t1");
    expect(rec).toMatchObject({ state: "canceled", cancel: { by: "anonymous" } });
    expect(rec?.endedAt).toBeDefined();
  });

  it("wakes race() immediately and a late rejection of the work is swallowed", async () => {
    const s = setup();
    const { call } = await startRun(s);
    let rejectWork!: (e: Error) => void;
    const work = new Promise<string>((_, rej) => (rejectWork = rej));
    const raced = call.view.race(work);
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    expect(await raced).toBe(CANCELED);
    rejectWork(new Error("Request aborted"));
    await tick();
  });

  it("calls provider.abort(info, 'cancel') with the run's identity and session", async () => {
    const s = setup();
    const { call } = await startRun(s);
    call.view.bind({ ref: "sess-1" });
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    await s.registry.drain();
    expect(s.provider.abort).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t1", contextId: "ctx", turnId: call.req.turnId, runId: call.req.runId, session: { ref: "sess-1" } }),
      "cancel",
    );
  });

  it("the RPC does not wait for a hanging abort: it returns right after canceled is published", async () => {
    vi.useFakeTimers();
    const s = setup({ abort: () => new Promise(() => {}) });
    const { publisher } = await (async () => {
      const p = makePublisher();
      void s.registry.execute(makeInit("t1", "ctx", p));
      await vi.advanceTimersByTimeAsync(1);
      return { publisher: p };
    })();

    let returned = false;
    void s.registry.cancel("t1", ANONYMOUS_CALLER).then(() => (returned = true));
    await vi.advanceTimersByTimeAsync(0); // one tick, far below the abort timeout
    expect(returned).toBe(true);
    expect(publisher.terminal()).toEqual([{ state: "canceled" }]);

    // the abort times out in the background and is applied as unconfirmed/discard
    await vi.advanceTimersByTimeAsync(5_001);
    await s.registry.drain();
    expect((await s.store.getRun("t1"))?.cancel?.abort).toEqual(ABORT_FAILED_OUTCOME);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abort rejection is ABORT_FAILED_OUTCOME: binding cleared, session released, outcome recorded", async () => {
    const s = setup({ abort: async () => { throw new Error("boom"); } });
    const { call } = await startRun(s);
    call.view.bind({ ref: "sess-1", meta: { a: 1 } });
    await s.registry.drain();
    expect((await s.store.getBinding("ctx"))?.session).toMatchObject({ ref: "sess-1", issuer: "fake@1" });

    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    await s.registry.drain();

    expect(await s.store.getBinding("ctx")).toBeUndefined();
    expect(s.provider.release).toHaveBeenCalledWith({ ref: "sess-1" });
    expect((await s.store.getRun("t1"))?.cancel?.abort).toEqual(ABORT_FAILED_OUTCOME);
  });

  it("outcome session 'discard' clears the binding and releases; 'reusable' keeps both", async () => {
    for (const session of ["discard", "reusable"] as const) {
      const s = setup({ abort: async () => ({ stopped: "confirmed", session }) });
      const { call } = await startRun(s, `t-${session}`, `c-${session}`);
      call.view.bind({ ref: "s" });
      await s.registry.drain();
      await s.registry.cancel(`t-${session}`, ANONYMOUS_CALLER);
      await s.registry.drain();
      expect(!!(await s.store.getBinding(`c-${session}`))).toBe(session === "reusable");
      expect(s.provider.release).toHaveBeenCalledTimes(session === "discard" ? 1 : 0);
      expect((await s.store.getRun(`t-${session}`))?.cancel?.abort).toEqual({ stopped: "confirmed", session });
    }
  });

  it("without an abort handler the lane waits for run() to settle (confirmed)", async () => {
    const s = setup();
    delete (s.provider as any).abort;
    const { call } = await startRun(s);
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    call.resolve(); // provider honours the signal and returns
    await s.registry.drain();
    expect((await s.store.getRun("t1"))?.cancel?.abort).toEqual({ stopped: "confirmed", session: "reusable" });
  });

  it("authorize is the choke point: a denied cancel claims nothing and publishes nothing", async () => {
    const authorize = vi.fn(() => false);
    const s = setup({}, { authorize });
    const { publisher, call } = await startRun(s);
    expect(await s.registry.cancel("t1", { id: "mallory", kind: "user" })).toEqual({ claimed: false, reason: "denied" });
    expect(authorize).toHaveBeenCalledWith({ id: "mallory", kind: "user" }, "cancel", expect.objectContaining({ taskId: "t1" }));
    expect(publisher.terminal()).toEqual([]);
    expect(call.view.signal.aborted).toBe(false);
    expect(s.registry.isLive("t1")).toBe(true);
  });

  it("an async authorizer works and the claim is still taken once", async () => {
    const s = setup({}, { authorize: async () => true });
    const { publisher } = await startRun(s);
    const [a, b] = await Promise.all([s.registry.cancel("t1", ANONYMOUS_CALLER), s.registry.cancel("t1", ANONYMOUS_CALLER)]);
    expect([a.claimed, b.claimed].sort()).toEqual([false, true]);
    expect(publisher.terminal()).toHaveLength(1);
  });

  it("records who canceled", async () => {
    const s = setup();
    await startRun(s);
    await s.registry.cancel("t1", { id: "alice", kind: "user" });
    expect((await s.store.getRun("t1"))?.cancel?.by).toBe("alice");
  });
});

describe("RunRegistry.cancel: edge cases", () => {
  it("double cancel is idempotent", async () => {
    const s = setup();
    const { publisher } = await startRun(s);
    expect((await s.registry.cancel("t1", ANONYMOUS_CALLER)).claimed).toBe(true);
    expect(await s.registry.cancel("t1", ANONYMOUS_CALLER)).toEqual({ claimed: false, reason: "already-canceled" });
    await s.registry.drain();
    expect(publisher.terminal()).toHaveLength(1);
    expect(s.provider.abort).toHaveBeenCalledTimes(1);
  });

  it("an unknown task is a no-op", async () => {
    const s = setup();
    expect(await s.registry.cancel("nope", ANONYMOUS_CALLER)).toEqual({ claimed: false, reason: "unknown-task" });
  });

  it("cancel after the run completed: not cancelable, nothing published", async () => {
    const s = setup();
    const { call, done, publisher } = await startRun(s);
    call.view.complete({ text: "done" });
    expect(await done).toBe("ended");
    expect(await s.registry.cancel("t1", ANONYMOUS_CALLER)).toEqual({ claimed: false, reason: "already-terminal" });
    expect(publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
  });

  it("cancel racing complete: exactly one terminal event, whichever claims first (complete first)", async () => {
    const s = setup();
    const { call, publisher } = await startRun(s);
    call.view.complete({ text: "done" });
    const out = await s.registry.cancel("t1", ANONYMOUS_CALLER);
    expect(out.claimed).toBe(false);
    expect(publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
    expect(call.view.signal.aborted).toBe(false);
  });

  it("cancel racing complete (cancel first): the late complete is dropped", async () => {
    const s = setup();
    const { call, publisher } = await startRun(s);
    const canceling = s.registry.cancel("t1", ANONYMOUS_CALLER);
    call.view.complete({ text: "too late" }); // same tick, after the synchronous claim
    call.view.fail({ message: "nope" });
    await canceling;
    expect(publisher.terminal().map((t) => t.state)).toEqual(["canceled"]);
    expect((await s.store.getRun("t1"))?.state).toBe("canceled");
  });

  it("everything the provider publishes after a cancel is a silent drop; ask resolves canceled; a late settlement is swallowed", async () => {
    const s = setup();
    const { call, publisher } = await startRun(s);
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    const callsAfterCancel = publisher.calls.length;

    call.view.progress("still here");
    call.view.event({ type: "text", text: "late" });
    call.view.artifact({ parts: [{ kind: "text", text: "late" }] });
    call.view.bind({ ref: "resurrected" });
    call.view.complete({ text: "late" });
    call.view.reject({ message: "late" });
    expect(await call.view.ask({ kind: "confirm", title: "?" } as CoreInteractionRequest)).toEqual({ outcome: "canceled" });
    expect(() => call.view.dropHeld("h")).not.toThrow();
    call.reject(new Error("aborted")); // late settlement of provider.run
    await s.registry.drain();

    expect(publisher.calls.length).toBe(callsAfterCancel);
    expect(await s.store.getBinding("ctx")).toBeUndefined();
  });

  it("cancel before start: a run waiting in its lane is removed, canceled is published, the provider is never called for it", async () => {
    const s = setup();
    const first = await startRun(s, "a", "shared");
    const pubB = makePublisher();
    const doneB = s.registry.execute(makeInit("b", "shared", pubB));
    await tick();
    expect(s.provider.runs).toHaveLength(1); // b waits behind a

    expect((await s.registry.cancel("b", ANONYMOUS_CALLER)).claimed).toBe(true);
    expect(pubB.terminal()).toEqual([{ state: "canceled" }]);
    expect(await doneB).toBe("ended");
    expect(s.provider.abort).not.toHaveBeenCalled();

    first.call.view.complete({ text: "a done" });
    await first.done;
    await tick();
    expect(s.provider.runs).toHaveLength(1); // b never started
    expect((await s.store.getRun("b"))?.state).toBe("canceled");
  });

  it("cancel of a task parked at input-required after execute() returned (the old registry entry would be gone)", async () => {
    const fake = fakeInteractions();
    const s = setup({}, { interactions: fake.runtime });
    const publisher = makePublisher();
    const executed = s.registry.execute(makeInit("t1", "ctx", publisher));
    await until(() => s.provider.runs.length === 1);
    const call = s.provider.runs[0];
    const answer = call.view.ask({ kind: "confirm", title: "ok?" } as CoreInteractionRequest);

    expect(await executed).toBe("parked"); // execute() returned; the run lives on
    expect(s.registry.isLive("t1")).toBe(true);

    const out = await s.registry.cancel("t1", ANONYMOUS_CALLER);
    expect(out.claimed).toBe(true);
    expect(await answer).toEqual({ outcome: "canceled" }); // settled before any await of the cancel
    expect(fake.asked[0].settled).toEqual({ outcome: "canceled" });
    expect(publisher.terminal()).toEqual([{ state: "canceled" }]);
    expect(call.view.signal.reason).toBe("cancel");
  });

  it("pending interactions are settled canceled synchronously inside the claim", async () => {
    const fake = fakeInteractions();
    const s = setup({}, { interactions: fake.runtime });
    void s.registry.execute(makeInit("t1"));
    await until(() => s.provider.runs.length === 1);
    const answer = s.provider.runs[0].view.ask({ kind: "confirm", title: "?" } as CoreInteractionRequest);
    const canceling = s.registry.cancel("t1", ANONYMOUS_CALLER);
    expect(fake.asked[0].settled).toEqual({ outcome: "canceled" }); // before the cancel promise settled
    await canceling;
    expect(await answer).toEqual({ outcome: "canceled" });
  });

  it("without an interactions runtime ask answers unavailable (the runtime is #108)", async () => {
    const s = setup();
    const { call } = await startRun(s);
    expect(await call.view.ask({ kind: "confirm", title: "?" } as CoreInteractionRequest)).toMatchObject({ outcome: "unavailable" });
  });
});

describe("two execute() calls on one task", () => {
  it("never run the provider concurrently: the second is queued as the next turn, then runs", async () => {
    const s = setup();
    const first = await startRun(s);
    const second = await s.registry.execute(makeInit("t1", "ctx", first.publisher));
    expect(second).toBe("queued");
    await tick();
    expect(s.provider.runs).toHaveLength(1);
    expect((await s.store.listQueued("t1"))).toHaveLength(1);

    first.call.view.complete({ text: "one" });
    await until(() => s.provider.runs.length === 2, "second turn");
    expect(first.publisher.terminal()).toEqual([]); // the task did not go terminal between turns
    expect((await s.store.listQueued("t1"))[0].state).toBe("running");
    expect(s.provider.runs[1].req.runId).toBe(first.call.req.runId); // same run
    expect(s.provider.runs[1].req.turnId).not.toBe(first.call.req.turnId);

    s.provider.runs[1].view.complete({ text: "two" });
    expect(await first.done).toBe("ended");
    expect(first.publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
  });

  it("cancel drops the core-queued message and records why", async () => {
    const s = setup();
    const first = await startRun(s);
    await s.registry.execute(makeInit("t1", "ctx", first.publisher, { message: { id: "m2", role: "user", parts: [], from: ANONYMOUS_CALLER, at: "now" } }));
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    await s.registry.drain();
    expect(await s.store.listQueued("t1")).toMatchObject([{ state: "dropped", reason: "task canceled", message: { id: "m2" } }]);
    await tick();
    expect(s.provider.runs).toHaveLength(1);
  });
});

describe("interrupt", () => {
  it("aborts the signal with reason interrupt but keeps the task non-terminal, publishes no canceled and keeps the provider queue", async () => {
    const s = setup();
    const { call, publisher } = await startRun(s);
    expect(await s.registry.interrupt("t1", ANONYMOUS_CALLER)).toEqual({ interrupted: true });
    expect(call.view.signal.aborted).toBe(true);
    expect(call.view.signal.reason).toBe("interrupt");
    await s.registry.drain();
    expect(s.provider.abort).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1" }), "interrupt");
    expect(publisher.terminal()).toEqual([]);
    expect(publisher.calls.some((c) => c.k === "finished")).toBe(false);
    expect(s.registry.isLive("t1")).toBe(true);
    expect((await s.store.getRun("t1"))?.state).toBe("working");

    // the interrupted turn's own late complete is a drop; it cannot end the task
    call.view.complete({ text: "from the stopped turn" });
    expect(publisher.terminal()).toEqual([]);
  });

  it("the task continues with the interrupting message as the next turn and ends once", async () => {
    const s = setup();
    const first = await startRun(s);
    const nextPub = makePublisher();
    expect(await s.registry.interrupt("t1", ANONYMOUS_CALLER, makeInit("t1", "ctx", nextPub))).toEqual({ interrupted: true });
    await until(() => s.provider.runs.length === 2, "next turn");
    expect(s.provider.runs[1].view.signal.aborted).toBe(false); // a fresh signal
    s.provider.runs[1].view.complete({ text: "after interrupt" });
    expect(nextPub.terminal().map((t) => t.state)).toEqual(["completed"]);
    expect(first.publisher.terminal()).toEqual([]);
  });

  it("the next turn waits for the interrupted turn's abort to settle", async () => {
    let finishAbort!: () => void;
    const s = setup({ abort: () => new Promise((r) => (finishAbort = () => r({ stopped: "confirmed", session: "reusable" }))) });
    await startRun(s);
    await s.registry.interrupt("t1", ANONYMOUS_CALLER, makeInit("t1"));
    await tick();
    expect(s.provider.runs).toHaveLength(1);
    finishAbort();
    await until(() => s.provider.runs.length === 2, "next turn after abort");
  });

  it("is refused for an unknown or finished task", async () => {
    const s = setup();
    expect(await s.registry.interrupt("nope", ANONYMOUS_CALLER)).toEqual({ interrupted: false, reason: "unknown-task" });
  });

  it("a cancel after an interrupt still cancels the task", async () => {
    const s = setup();
    const { publisher } = await startRun(s);
    await s.registry.interrupt("t1", ANONYMOUS_CALLER);
    expect((await s.registry.cancel("t1", ANONYMOUS_CALLER)).claimed).toBe(true);
    expect(publisher.terminal()).toEqual([{ state: "canceled" }]);
  });
});

describe("context lane gate", () => {
  it("the next task on the context waits for the cancel's abort to settle before reusing the session", async () => {
    let finishAbort!: () => void;
    const s = setup({ abort: () => new Promise((r) => (finishAbort = () => r({ stopped: "confirmed", session: "reusable" }))) });
    await startRun(s, "a", "shared");
    const doneB = s.registry.execute(makeInit("b", "shared"));
    await tick();

    await s.registry.cancel("a", ANONYMOUS_CALLER);
    await tick();
    expect(s.provider.runs).toHaveLength(1); // b is still waiting: the abort has not settled

    finishAbort();
    await until(() => s.provider.runs.length === 2, "b to start");
    s.provider.runs[1].view.complete({});
    await doneB;
  });

  it("a hanging abort times out (discard) and then the next turn starts, without the old session", async () => {
    vi.useFakeTimers();
    const s = setup({ abort: () => new Promise(() => {}) });
    await s.store.putBinding({
      ...newRecordHeader(owner, "t"),
      contextId: "shared",
      session: { ref: "old", issuer: "fake@1" },
    });
    void s.registry.execute(makeInit("a", "shared"));
    await vi.advanceTimersByTimeAsync(1);
    expect(s.provider.runs[0].req.session).toEqual({ ref: "old" });

    void s.registry.execute(makeInit("b", "shared"));
    await s.registry.cancel("a", ANONYMOUS_CALLER);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.provider.runs).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_001);
    expect(s.provider.runs).toHaveLength(2);
    expect(s.provider.runs[1].req.session).toBeUndefined(); // discarded
    expect(s.provider.release).toHaveBeenCalledWith({ ref: "old" });
  });

  it("turns of different contexts run concurrently", async () => {
    const s = setup();
    await startRun(s, "a", "c1");
    await startRun(s, "b", "c2");
    expect(s.provider.runs).toHaveLength(2);
  });
});

describe("how a turn ends", () => {
  it("run() resolving with text completes the turn with it; without text it fails", async () => {
    const s = setup();
    const a = await startRun(s, "a", "c1");
    a.call.view.event({ type: "text", text: "he" });
    a.call.view.event({ type: "text", text: "llo" });
    a.call.resolve();
    await a.done;
    expect(a.publisher.terminal()).toEqual([{ state: "completed", text: "hello" }]);

    const b = await startRun(s, "b", "c2");
    b.call.resolve();
    await b.done;
    expect(b.publisher.terminal()).toMatchObject([{ state: "failed", text: "provider returned without a result" }]);
  });

  it("run() rejecting fails the turn with the error message", async () => {
    const s = setup();
    const a = await startRun(s);
    a.call.reject(new Error("backend exploded"));
    await a.done;
    expect(a.publisher.terminal()).toMatchObject([{ state: "failed", text: "backend exploded" }]);
  });

  it("a second terminal call for one turn is ignored; reject ends the run rejected", async () => {
    const s = setup();
    const a = await startRun(s, "a", "c1");
    a.call.view.complete({ text: "one" });
    a.call.view.complete({ text: "two" });
    a.call.view.fail({ message: "three" });
    expect(a.publisher.terminal().map((t) => t.state)).toEqual(["completed"]);

    const b = await startRun(s, "b", "c2");
    b.call.view.reject({ message: "out of scope" });
    expect(b.publisher.terminal()).toMatchObject([{ state: "rejected", text: "out of scope" }]);
  });

  it("a handle is registered until the terminal event is out, not until execute() returns", async () => {
    const fake = fakeInteractions();
    const s = setup({}, { interactions: fake.runtime });
    const publisher = makePublisher();
    const executed = s.registry.execute(makeInit("t1", "ctx", publisher));
    await until(() => s.provider.runs.length === 1);
    void s.provider.runs[0].view.ask({ kind: "confirm", title: "?" } as CoreInteractionRequest);
    await executed;
    expect(s.registry.isLive("t1")).toBe(true);
    s.provider.runs[0].view.complete({});
    expect(s.registry.isLive("t1")).toBe(false);
  });

  it("notifies settle listeners once the terminal event is out", async () => {
    const s = setup();
    const settled = vi.fn();
    s.registry.onSettled(settled);
    const a = await startRun(s);
    a.call.view.complete({});
    expect(settled).toHaveBeenCalledWith({ taskId: "t1", contextId: "ctx" });
  });
});

describe("expiry (third terminal claim)", () => {
  it("is exclusive with complete and cancel", async () => {
    const s = setup();
    const { call, publisher } = await startRun(s);
    expect(await s.registry.expire("t1", { message: "interaction expired", code: "timeout" })).toBe(true);
    call.view.complete({});
    expect((await s.registry.cancel("t1", ANONYMOUS_CALLER)).claimed).toBe(false);
    expect(await s.registry.expire("t1", { message: "again" })).toBe(false);
    expect(publisher.terminal()).toMatchObject([{ state: "failed", text: "interaction expired" }]);
  });
});

describe("provider-held messages (steering runtime hooks, #109)", () => {
  it("the task stays open until a held message is begun or dropped", async () => {
    const s = setup();
    const { call, publisher, done } = await startRun(s);
    expect(s.registry.registerHeld("t1", "h1")).toBe(true);
    call.view.complete({ text: "first" });
    expect(publisher.terminal()).toEqual([]);

    const held = call.view.beginHeldTurn("h1");
    expect(held.turnId).not.toBe(call.view.turnId);
    expect(held.runId).toBe(call.view.runId);
    held.complete({ text: "held done" });
    expect(await done).toBe("ended");
    expect(publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
  });

  it("dropHeld lets the task go terminal", async () => {
    const s = setup();
    const { call, publisher } = await startRun(s);
    s.registry.registerHeld("t1", "h1");
    call.view.complete({});
    call.view.dropHeld("h1");
    expect(publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
  });

  it("liveness backstop: run() settling with a held handle neither begun nor dropped treats it as dropped", async () => {
    const warn = vi.fn();
    const s = setup({}, { logger: { warn } });
    const { call, publisher, done } = await startRun(s);
    s.registry.registerHeld("t1", "h1");
    call.view.complete({});
    expect(publisher.terminal()).toEqual([]);
    call.resolve();
    expect(await done).toBe("ended");
    expect(publisher.terminal().map((t) => t.state)).toEqual(["completed"]);
    expect(warn).toHaveBeenCalled();
  });

  it("cancel drops provider-held messages and records why", async () => {
    const s = setup();
    await startRun(s);
    s.registry.registerHeld("t1", "h1", { id: "mh", role: "user", parts: [], from: ANONYMOUS_CALLER, at: "now" });
    await s.registry.drain();
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    await s.registry.drain();
    expect(await s.store.listQueued("t1")).toMatchObject([{ holder: "provider", handle: "h1", state: "dropped", reason: "task canceled" }]);
  });

  it("beginHeldTurn after the run is gone returns a view that drops everything", async () => {
    const s = setup();
    const { call, publisher } = await startRun(s);
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    const n = publisher.calls.length;
    const view = call.view.beginHeldTurn("whatever");
    view.complete({ text: "x" });
    view.progress("x");
    expect(publisher.calls.length).toBe(n);
  });
});
