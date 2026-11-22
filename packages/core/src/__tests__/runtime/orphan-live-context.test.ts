import { describe, it, expect } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import { InMemoryTaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import { InMemoryRunStore, OrphanGuardTaskStore, RunRegistry, newRecordHeader, type RunRecord, type QueuedMessageRecord, ANONYMOUS_CALLER } from "../../index.js";
import { makeInit, makeProvider, makePublisher, tick } from "./harness.js";

const owner = { id: "anonymous", kind: "anonymous" };
const rec = (over: Partial<RunRecord> = {}): RunRecord => ({
  ...newRecordHeader(owner, "2026-01-01T00:00:00.000Z"),
  runId: "run-old", taskId: "t-old", contextId: "ctx", turnId: "turn-1", state: "working", startedAt: "2026-01-01T00:00:00.000Z", ...over,
});
const bind = (store: InMemoryRunStore) => store.putBinding({ ...newRecordHeader(owner, "t"), contextId: "ctx", session: { ref: "sess", issuer: "fake@1" } });

describe("abortOrphan versus a context that is live again", () => {
  it("the startup sweep skips an orphan whose context has a live run: no abortOrphan, binding kept, confirmed for the task", async () => {
    const provider = makeProvider({ abortOrphan: async () => ({ stopped: "confirmed", session: "discard" }) });
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(rec());
    await bind(store);
    void registry.execute(makeInit("t-live", "ctx", makePublisher())); // the context was resumed
    await tick();

    const report = await registry.sweep();
    await registry.drain();

    expect(provider.abortOrphan).not.toHaveBeenCalled();
    expect(await store.getBinding("ctx")).toBeDefined();
    expect(provider.release).not.toHaveBeenCalled();
    expect(report.entries.length).toBeGreaterThan(0);
  });

  it("a store-cancel of the old task does not stop the session the live run uses", async () => {
    const provider = makeProvider({ abortOrphan: async () => ({ stopped: "confirmed", session: "discard" }) });
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(rec());
    await bind(store);
    void registry.execute(makeInit("t-live", "ctx", makePublisher()));
    await tick();
    const guard = new OrphanGuardTaskStore(new InMemoryTaskStore(), registry);

    await guard.save({ id: "t-old", contextId: "ctx", status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined }, artifacts: [], history: [], metadata: {} } as any, new ServerCallContext());
    await registry.drain();

    expect(provider.abortOrphan).not.toHaveBeenCalled();
    expect(await store.getBinding("ctx")).toBeDefined();
  });

  it("without a live run of the context the orphan is still aborted (control)", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(rec());
    await bind(store);
    await registry.sweep();
    expect(provider.abortOrphan).toHaveBeenCalledTimes(1);
  });
});

describe("OrphanInfo.heldHandles", () => {
  it("carries the provider-held handles core still knows for the run (and only those)", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(rec());
    await bind(store);
    const q = (id: string, over: Partial<QueuedMessageRecord>): QueuedMessageRecord => ({
      ...newRecordHeader(owner, "t"), taskId: "t-old", contextId: "ctx",
      message: { id, role: "user", parts: [{ kind: "text", text: id }], from: ANONYMOUS_CALLER, at: "t" }, holder: "provider", state: "queued", ...over,
    });
    await store.putQueued(q("m1", { handle: "h1" }));
    await store.putQueued(q("m2", { handle: "h2", state: "done" }));
    await store.putQueued(q("m3", { holder: "core" }));
    await registry.sweep();
    expect(provider.abortOrphan.mock.calls[0]![0]).toMatchObject({ taskId: "t-old", heldHandles: ["h1"] });
  });

  it("is absent when core knows none", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun(rec());
    await registry.sweep();
    expect(provider.abortOrphan.mock.calls[0]![0]).not.toHaveProperty("heldHandles");
  });
});
