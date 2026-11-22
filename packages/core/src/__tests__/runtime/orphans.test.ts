import { describe, it, expect, vi } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import { InMemoryTaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import {
  ABORT_FAILED_OUTCOME,
  ANONYMOUS_CALLER,
  InMemoryRunStore,
  OrphanGuardTaskStore,
  RunRegistry,
  endTaskInStore,
  newRecordHeader,
  type QueuedMessageRecord,
  type RunRecord,
} from "../../index.js";
import { makeInit, makeProvider, makePublisher } from "./harness.js";

const owner = { id: "anonymous", kind: "anonymous" };
const sctx = () => new ServerCallContext();

function runRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    ...newRecordHeader(owner, "2026-01-01T00:00:00.000Z"),
    runId: "run-1",
    taskId: "t1",
    contextId: "ctx",
    turnId: "turn-1",
    state: "working",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function queued(id: string, over: Partial<QueuedMessageRecord> = {}): QueuedMessageRecord {
  return {
    ...newRecordHeader(owner, "2026-01-01T00:00:00.000Z"),
    taskId: "t1",
    contextId: "ctx",
    message: { id, role: "user", parts: [{ kind: "text", text: id }], from: ANONYMOUS_CALLER, at: "2026-01-01T00:00:00.000Z" },
    holder: "core",
    state: "queued",
    ...over,
  };
}

function sdkTask(state: TaskState, id = "t1") {
  return {
    id,
    contextId: "ctx",
    status: { state, timestamp: new Date().toISOString(), message: undefined },
    artifacts: [],
    history: [],
    metadata: {},
  } as any;
}

async function bindSession(store: InMemoryRunStore, ref = "sess") {
  await store.putBinding({ ...newRecordHeader(owner, "t"), contextId: "ctx", session: { ref, issuer: "fake@1" } });
}

describe("orphans: a save that makes a task CANCELED while core has no live run", () => {
  it("calls abortOrphan with the run's identity and applies the outcome (discard clears binding, releases)", async () => {
    const provider = makeProvider({ abortOrphan: async () => ({ stopped: "confirmed", session: "discard" }) });
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(runRecord());
    await bindSession(store);
    const guard = new OrphanGuardTaskStore(new InMemoryTaskStore(), registry);

    await guard.save(sdkTask(TaskState.TASK_STATE_CANCELED), sctx());
    await registry.drain();

    expect(provider.abortOrphan).toHaveBeenCalledTimes(1);
    expect(provider.abortOrphan).toHaveBeenCalledWith({
      runId: "run-1",
      turnId: "turn-1",
      taskId: "t1",
      contextId: "ctx",
      reason: "cancel",
      session: { ref: "sess" },
    });
    expect(await store.getBinding("ctx")).toBeUndefined();
    expect(provider.release).toHaveBeenCalledWith({ ref: "sess" });
    expect(await store.getRun("t1")).toMatchObject({
      state: "canceled",
      cancel: { by: "store", abort: { stopped: "confirmed", session: "discard" } },
    });

    // a second CANCELED save is not a second abort
    await guard.save(sdkTask(TaskState.TASK_STATE_CANCELED), sctx());
    await registry.drain();
    expect(provider.abortOrphan).toHaveBeenCalledTimes(1);
  });

  it("ignores other states, tasks core never ran, and terminal records", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    const guard = new OrphanGuardTaskStore(new InMemoryTaskStore(), registry);
    await store.putRun(runRecord({ taskId: "done", state: "completed" }));
    await store.putRun(runRecord({ taskId: "w", state: "working" }));

    await guard.save(sdkTask(TaskState.TASK_STATE_WORKING, "w"), sctx());
    await guard.save(sdkTask(TaskState.TASK_STATE_CANCELED, "never-ran"), sctx());
    await guard.save(sdkTask(TaskState.TASK_STATE_CANCELED, "done"), sctx());
    await registry.drain();
    expect(provider.abortOrphan).not.toHaveBeenCalled();
  });

  it("without an abortOrphan handler core cannot trust the session: ABORT_FAILED_OUTCOME, discarded", async () => {
    const provider = makeProvider();
    delete (provider as any).abortOrphan;
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(runRecord());
    await bindSession(store);
    await new OrphanGuardTaskStore(new InMemoryTaskStore(), registry).save(sdkTask(TaskState.TASK_STATE_CANCELED), sctx());
    await registry.drain();
    expect((await store.getRun("t1"))?.cancel?.abort).toEqual(ABORT_FAILED_OUTCOME);
    expect(await store.getBinding("ctx")).toBeUndefined();
  });

  it("abortOrphan rejecting is ABORT_FAILED_OUTCOME", async () => {
    const provider = makeProvider({ abortOrphan: async () => { throw new Error("gone"); } });
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(runRecord());
    await new OrphanGuardTaskStore(new InMemoryTaskStore(), registry).save(sdkTask(TaskState.TASK_STATE_CANCELED), sctx());
    await registry.drain();
    expect((await store.getRun("t1"))?.cancel?.abort).toEqual(ABORT_FAILED_OUTCOME);
  });

  it("a normal cancel of a live run is NOT mistaken for an orphan when the SDK then saves CANCELED", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    const guard = new OrphanGuardTaskStore(new InMemoryTaskStore(), registry);
    void registry.execute(makeInit("t1"));
    await vi.waitFor(() => expect(provider.runs).toHaveLength(1));

    const canceling = registry.cancel("t1", ANONYMOUS_CALLER);
    await guard.save(sdkTask(TaskState.TASK_STATE_CANCELED), sctx()); // racing the cancel's own persistence
    await canceling;
    await guard.save(sdkTask(TaskState.TASK_STATE_CANCELED), sctx());
    await registry.drain();
    expect(provider.abortOrphan).not.toHaveBeenCalled();
    expect(provider.abort).toHaveBeenCalledTimes(1);
  });

  it("the store says canceled while core still runs the task: the run is canceled (one terminal event)", async () => {
    const provider = makeProvider();
    const registry = new RunRegistry({ provider });
    const publisher = makePublisher();
    void registry.execute(makeInit("t1", "ctx", publisher));
    await vi.waitFor(() => expect(provider.runs).toHaveLength(1));
    expect(await registry.handleStoreCancel("t1")).toBe(true);
    expect(publisher.terminal()).toEqual([{ state: "canceled" }]);
    expect(provider.abort).toHaveBeenCalledTimes(1);
  });

  it("cancel() with no live handle but an active record is an orphan cancel: canceled published, abortOrphan called", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(runRecord());
    const publisher = makePublisher();

    expect((await registry.cancel("t1", ANONYMOUS_CALLER, () => publisher)).claimed).toBe(true);
    await registry.drain();
    expect(publisher.terminal()).toEqual([{ state: "canceled" }]);
    expect(provider.abortOrphan).toHaveBeenCalledTimes(1);
    expect(await registry.cancel("t1", ANONYMOUS_CALLER, () => publisher)).toEqual({ claimed: false, reason: "already-canceled" });
  });
});

describe("startup sweep", () => {
  it("aborts an active orphan once, fails the task when it cannot continue, tells the A2A store", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(runRecord());
    await store.putQueued(queued("m-core", { position: 1 }));
    const taskStore = new InMemoryTaskStore();
    await taskStore.save(sdkTask(TaskState.TASK_STATE_WORKING), sctx());

    const report = await registry.sweep({ endTask: endTaskInStore(taskStore, sctx()) });

    expect(provider.abortOrphan).toHaveBeenCalledTimes(1);
    expect(report.entries).toMatchObject([{ taskId: "t1", action: "task-failed", queued: { dropped: ["m-core"] } }]);
    expect(await store.getRun("t1")).toMatchObject({ state: "failed" });
    expect(await store.listQueued("t1")).toMatchObject([{ state: "dropped" }]);
    const t = await taskStore.load("t1", sctx());
    expect(t?.status.state).toBe(TaskState.TASK_STATE_FAILED);

    // running the sweep again finds nothing to do
    expect((await registry.sweep()).entries).toEqual([]);
  });

  it("core-queued: replays only `queued` records after an atomic claim, never a `running` one", async () => {
    const provider = makeProvider({ abortOrphan: async () => ({ stopped: "confirmed", session: "reusable" }) });
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(runRecord());
    await store.putQueued(queued("m-running", { state: "running", position: 1 }));
    await store.putQueued(queued("m-1", { position: 2 }));
    await store.putQueued(queued("m-2", { position: 3 }));
    const replay = vi.fn(async () => {});

    const report = await registry.sweep({ replay });

    expect(replay.mock.calls.map((c: any[]) => c[0].message.id)).toEqual(["m-1", "m-2"]);
    expect(report.entries[0]).toMatchObject({
      action: "turn-failed-queue-continued",
      queued: { replayed: ["m-1", "m-2"], dropped: ["m-running"] },
    });
    const states = Object.fromEntries((await store.listQueued("t1")).map((q) => [q.message.id, q.state]));
    expect(states).toEqual({ "m-running": "dropped", "m-1": "running", "m-2": "running" });
    expect((await store.getRun("t1"))?.state).toBe("working"); // the task continues
  });

  it("does not continue the queue when the session must be discarded: task failed, queue dropped and reported", async () => {
    const provider = makeProvider({ abortOrphan: async () => ({ stopped: "confirmed", session: "discard" }) });
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(runRecord());
    await store.putQueued(queued("m-1", { position: 1 }));
    const replay = vi.fn(async () => {});
    const report = await registry.sweep({ replay });
    expect(replay).not.toHaveBeenCalled();
    expect(report.entries[0]).toMatchObject({ action: "task-failed", queued: { dropped: ["m-1"] } });
  });

  it("provider-held: dropped only when abortOrphan confirmed; otherwise unknown and reported", async () => {
    for (const stopped of ["confirmed", "unconfirmed"] as const) {
      const provider = makeProvider({ abortOrphan: async () => ({ stopped, session: "reusable" }) });
      const store = new InMemoryRunStore();
      const registry = new RunRegistry({ provider, store });
      await store.putRun(runRecord());
      await store.putQueued(queued("held", { holder: "provider", handle: "h1" }));
      const report = await registry.sweep();
      const [rec] = await store.listQueued("t1");
      if (stopped === "confirmed") {
        expect(rec.state).toBe("dropped");
        expect(report.entries[0].queued.dropped).toEqual(["held"]);
      } else {
        expect(rec.state).toBe("unknown");
        expect(rec.reason).toMatch(/unknown/);
        expect(report.entries[0].queued.unknown).toEqual(["held"]);
      }
    }
  });

  it("an interrupted record with no open interaction is failed (server restarted); an unknown state is never assumed finished", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store, logger: { warn: vi.fn() } });
    await store.putRun(runRecord({ taskId: "wait", state: "input-required" }));
    await store.putRun(runRecord({ taskId: "odd", state: "some-future-state" }));
    const report = await registry.sweep();
    expect(report.entries.map((e) => [e.taskId, e.action]).sort()).toEqual([
      ["odd", "skipped-unknown-state"],
      ["wait", "interrupted-failed"],
    ]);
    expect(provider.abortOrphan).not.toHaveBeenCalled();
    expect((await store.getRun("odd"))?.state).toBe("some-future-state");
  });

  it("skips records that have a live handle", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    void registry.execute(makeInit("t1"));
    await vi.waitFor(() => expect(provider.runs).toHaveLength(1));
    await registry.drain();
    const report = await registry.sweep();
    expect(report.entries).toMatchObject([{ taskId: "t1", action: "skipped-live" }]);
    expect(provider.abortOrphan).not.toHaveBeenCalled();
  });
});
