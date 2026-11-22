/** Regression tests from the review of the run runtime (PR #117, round 2). */

import { describe, it, expect, vi, afterEach } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import { InMemoryTaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import * as core from "../../index.js";
import {
  ABORT_FAILED_OUTCOME,
  ANONYMOUS_CALLER,
  CoreExecutor,
  InMemoryRunStore,
  OrphanGuardTaskStore,
  RunRegistry,
  endTaskInStore,
  newRecordHeader,
  type RunRecord,
} from "../../index.js";
import { makeInit, makeProvider, makePublisher, tick } from "./harness.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const owner = { id: "anonymous", kind: "anonymous" };

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  if (!cond()) throw new Error("timed out");
}

function deferredAbort() {
  const pending: Array<(o: any) => void> = [];
  const abort = vi.fn((_info: any, _reason: string) => new Promise<any>((r) => pending.push(r)));
  return { abort, settle: (i: number) => pending[i]({ stopped: "confirmed", session: "reusable" }) };
}

describe("R1: cancel / expire during an interrupt's in-flight abort keeps the lane gate and sends abort(cancel)", () => {
  for (const mode of ["cancel", "expire"] as const) {
    it(`${mode}: the next task on the context waits for the interrupt abort, then abort(cancel), before starting`, async () => {
      const d = deferredAbort();
      const provider = makeProvider({ abort: d.abort as any });
      const registry = new RunRegistry({ provider });
      void registry.execute(makeInit("a", "shared"));
      await until(() => provider.runs.length === 1);
      void registry.execute(makeInit("b", "shared"));

      await registry.interrupt("a", ANONYMOUS_CALLER);
      expect(d.abort).toHaveBeenCalledTimes(1);
      expect(d.abort.mock.calls[0][1]).toBe("interrupt");

      if (mode === "cancel") expect((await registry.cancel("a", ANONYMOUS_CALLER)).claimed).toBe(true);
      else expect(await registry.expire("a", { message: "expired" })).toBe(true);
      await tick();
      expect(provider.runs).toHaveLength(1); // b has NOT started: the interrupt abort is still pending
      expect(d.abort).toHaveBeenCalledTimes(1); // abort(cancel) waits for it

      d.settle(0); // the interrupt abort settles
      await until(() => d.abort.mock.calls.length === 2);
      expect(d.abort.mock.calls[1][1]).toBe("cancel"); // so the provider flushes its native queue
      await tick();
      expect(provider.runs).toHaveLength(1); // still gated: the cancel abort is pending

      d.settle(1);
      await until(() => provider.runs.length === 2);
    });
  }
});

describe("R2: a failed RunRecord write does not break idempotency or exactly-one-terminal", () => {
  class FlakyStore extends InMemoryRunStore {
    override async putRun(r: RunRecord): Promise<void> {
      if (r.state === "canceled") throw new Error("disk full");
      return super.putRun(r);
    }
  }

  it("a second cancel is a no-op even though the record still reads working", async () => {
    const store = new FlakyStore();
    const provider = makeProvider();
    const registry = new RunRegistry({ provider, store, logger: { warn: vi.fn() } });
    const pub = makePublisher();
    void registry.execute(makeInit("t1", "ctx", pub));
    await until(() => provider.runs.length === 1);

    expect((await registry.cancel("t1", ANONYMOUS_CALLER)).claimed).toBe(true);
    expect((await store.getRun("t1"))?.state).toBe("working"); // the write failed
    expect(await registry.cancel("t1", ANONYMOUS_CALLER, () => pub)).toEqual({ claimed: false, reason: "already-canceled" });
    await registry.drain();
    expect(pub.terminal()).toHaveLength(1);
    expect(provider.abort).toHaveBeenCalledTimes(1);
    expect(provider.abortOrphan).not.toHaveBeenCalled();
  });

  it("the SDK saving the first CANCELED is not mistaken for an orphan", async () => {
    const store = new FlakyStore();
    const provider = makeProvider();
    const registry = new RunRegistry({ provider, store, logger: { warn: vi.fn() } });
    const guard = new OrphanGuardTaskStore(new InMemoryTaskStore(), registry);
    void registry.execute(makeInit("t1"));
    await until(() => provider.runs.length === 1);
    await registry.cancel("t1", ANONYMOUS_CALLER);
    await guard.save(
      { id: "t1", contextId: "ctx", status: { state: TaskState.TASK_STATE_CANCELED, timestamp: "t", message: undefined }, artifacts: [], history: [], metadata: {} } as any,
      new ServerCallContext(),
    );
    await registry.drain();
    expect(provider.abortOrphan).not.toHaveBeenCalled();
    expect(provider.abort).toHaveBeenCalledTimes(1);
  });

  it("the terminal write is retried and the tombstone cleared once it lands", async () => {
    let failures = 1;
    class OnceFlaky extends InMemoryRunStore {
      override async putRun(r: RunRecord): Promise<void> {
        if (r.state === "canceled" && failures-- > 0) throw new Error("blip");
        return super.putRun(r);
      }
    }
    const store = new OnceFlaky();
    const provider = makeProvider();
    const registry = new RunRegistry({ provider, store, logger: { warn: vi.fn() } });
    void registry.execute(makeInit("t1"));
    await until(() => provider.runs.length === 1);
    await registry.cancel("t1", ANONYMOUS_CALLER);
    expect((await store.getRun("t1"))?.state).toBe("canceled"); // second attempt succeeded
  });
});

describe("R3: no abort handler never records `confirmed`", () => {
  it("run() settling within the bound is unconfirmed/reusable; not settling is ABORT_FAILED_OUTCOME", async () => {
    vi.useFakeTimers();
    const provider = makeProvider();
    delete (provider as any).abort;
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    void registry.execute(makeInit("a", "c1"));
    void registry.execute(makeInit("b", "c2"));
    await vi.advanceTimersByTimeAsync(1);
    await registry.cancel("a", ANONYMOUS_CALLER);
    provider.runs[0].resolve();
    await vi.advanceTimersByTimeAsync(1);
    await registry.cancel("b", ANONYMOUS_CALLER); // run() never settles
    await vi.advanceTimersByTimeAsync(5_001);
    await registry.drain();
    expect((await store.getRun("a"))?.cancel?.abort).toEqual({ stopped: "unconfirmed", session: "reusable" });
    expect((await store.getRun("b"))?.cancel?.abort).toEqual(ABORT_FAILED_OUTCOME);
  });

  it("the sweep never drops a provider-held message on an inferred outcome (no abortOrphan handler: unknown)", async () => {
    const provider = makeProvider();
    delete (provider as any).abortOrphan;
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    await store.putRun({ ...newRecordHeader(owner, "t"), runId: "r", taskId: "t1", contextId: "ctx", turnId: "u", state: "working", startedAt: "t" });
    await store.putQueued({
      ...newRecordHeader(owner, "t"),
      taskId: "t1",
      contextId: "ctx",
      message: { id: "h", role: "user", parts: [], from: ANONYMOUS_CALLER, at: "t" },
      holder: "provider",
      handle: "h1",
      state: "queued",
    });
    await registry.sweep();
    expect((await store.listQueued("t1"))[0].state).toBe("unknown");
  });
});

describe("N1: CoreExecutor.execute never rejects while the task is live", () => {
  it("swallows a registry failure for a live task, rethrows otherwise", async () => {
    const boom = async () => { throw new Error("boom"); };
    const bus: any = { publish: vi.fn(), finished: vi.fn() };
    const ctx: any = { taskId: "t1", contextId: "c", task: { id: "t1" }, userMessage: undefined, context: undefined };
    const live = new CoreExecutor({ isLive: () => true, isParked: () => false, execute: boom, provider: {} } as any);
    await expect(live.execute(ctx, bus)).resolves.toBeUndefined();
    const idle = new CoreExecutor({ isLive: () => false, isParked: () => false, execute: boom, provider: {} } as any);
    await expect(idle.execute(ctx, bus)).rejects.toThrow("boom");
  });
});

describe("N2: a queued message's record moves to done when its turn ends", () => {
  it("queued -> running -> done", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    void registry.execute(makeInit("t1"));
    await until(() => provider.runs.length === 1);
    await registry.execute(makeInit("t1", "ctx", makePublisher(), { message: { id: "m2", role: "user", parts: [], from: ANONYMOUS_CALLER, at: "t" } }));
    provider.runs[0].view.complete({});
    await until(() => provider.runs.length === 2);
    expect((await store.listQueued("t1"))[0].state).toBe("running");
    provider.runs[1].view.complete({});
    await registry.drain();
    expect((await store.listQueued("t1"))[0].state).toBe("done");
  });
});

describe("N3: the sweep runs abortOrphan in parallel, bounded", () => {
  it("overlaps calls up to a limit", async () => {
    let active = 0;
    let max = 0;
    const provider = makeProvider({
      abortOrphan: async () => {
        active++;
        max = Math.max(max, active);
        await tick();
        active--;
        return { stopped: "confirmed", session: "reusable" };
      },
    });
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    for (let i = 0; i < 10; i++) {
      await store.putRun({ ...newRecordHeader(owner, "t"), runId: `r${i}`, taskId: `t${i}`, contextId: `c${i}`, turnId: "u", state: "working", startedAt: "t" });
    }
    const report = await registry.sweep();
    expect(report.entries).toHaveLength(10);
    expect(provider.abortOrphan).toHaveBeenCalledTimes(10);
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(4);
  });
});

describe("N4: endTaskInStore uses the record's owner and tenant", () => {
  it("loads and saves under the owner/tenant context", async () => {
    const seen: Array<{ user?: string; tenant?: string }> = [];
    const task: any = { id: "t1", contextId: "c", status: { state: TaskState.TASK_STATE_WORKING, timestamp: "t" }, artifacts: [], history: [], metadata: {} };
    const store: any = {
      load: async (_id: string, ctx: ServerCallContext) => { seen.push({ user: ctx.user?.userName, tenant: ctx.tenant }); return task; },
      save: async (_t: any, ctx: ServerCallContext) => { seen.push({ user: ctx.user?.userName, tenant: ctx.tenant }); },
      list: async () => ({ tasks: [] }),
    };
    await endTaskInStore(store)({ taskId: "t1", contextId: "c", state: "failed", reason: "restart", owner: { id: "alice", kind: "user" }, tenant: "acme" });
    expect(seen).toEqual([{ user: "alice", tenant: "acme" }, { user: "alice", tenant: "acme" }]);
    expect(task.status.state).toBe(TaskState.TASK_STATE_FAILED);
  });
});

describe("N8: the runtime-internal handle is not public API", () => {
  it("RunHandle and RunTurn are not exported from the package", () => {
    expect("RunHandle" in core).toBe(false);
    expect("RunTurn" in core).toBe(false);
  });
});
