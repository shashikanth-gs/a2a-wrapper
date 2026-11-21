/** Provider-neutral cancellation (TaskRunRegistry). */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import { TaskState } from "@a2a-js/sdk";
import { TaskRunRegistry, CANCELED, DEFAULT_ABORT_TIMEOUT_MS } from "../../index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeBus() {
  const events: any[] = [];
  const bus = {
    events,
    publish: vi.fn((e: any) => { events.push(e); }),
    finished: vi.fn(),
    on: vi.fn(function (this: unknown) { return this; }),
    off: vi.fn(function (this: unknown) { return this; }),
    once: vi.fn(function (this: unknown) { return this; }),
    removeAllListeners: vi.fn(function (this: unknown) { return this; }),
  };
  return bus as typeof bus & ExecutionEventBus;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("TaskRunRegistry.cancel", () => {
  it("publishes exactly one canceled event with the run's contextId, then finishes the bus", async () => {
    const reg = new TaskRunRegistry();
    const run = reg.begin("t1", "ctx-9", makeBus());
    const cancelBus = makeBus();

    expect(await reg.cancel("t1", cancelBus)).toBe(true);

    expect(cancelBus.events).toHaveLength(1);
    const ev = cancelBus.events[0];
    expect(ev.kind).toBe("statusUpdate");
    expect(ev.data.taskId).toBe("t1");
    expect(ev.data.contextId).toBe("ctx-9");
    expect(ev.data.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(cancelBus.finished).toHaveBeenCalledTimes(1);
    expect(run.canceled).toBe(true);
    expect(run.signal.aborted).toBe(true);
  });

  it("is a silent no-op for unknown, ended and already-canceled tasks", async () => {
    const reg = new TaskRunRegistry();
    const abort = vi.fn();
    const bus = makeBus();

    expect(await reg.cancel("nope", bus, { abort })).toBe(false);

    const run = reg.begin("t1", "c", makeBus());
    run.end();
    expect(await reg.cancel("t1", bus, { abort })).toBe(false);

    reg.begin("t2", "c", makeBus());
    expect(await reg.cancel("t2", bus, { abort })).toBe(true);
    expect(await reg.cancel("t2", bus, { abort })).toBe(false);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(bus.events).toHaveLength(1);
    expect(bus.finished).toHaveBeenCalledTimes(1);
  });

  it("is a no-op once the run began finalizing (completion wins)", async () => {
    const reg = new TaskRunRegistry();
    const run = reg.begin("t1", "c", makeBus());
    expect(run.beginFinalize()).toBe(true);
    const bus = makeBus();
    expect(await reg.cancel("t1", bus, { abort: vi.fn() })).toBe(false);
    expect(bus.events).toHaveLength(0);
  });

  it("cancel wins the race: beginFinalize() then returns false", async () => {
    const reg = new TaskRunRegistry();
    const run = reg.begin("t1", "c", makeBus());
    await reg.cancel("t1", makeBus());
    expect(run.beginFinalize()).toBe(false);
  });

  it("publishes canceled BEFORE awaiting a slow backend abort (the SDK closes the bus when execute returns)", async () => {
    const reg = new TaskRunRegistry();
    reg.begin("t1", "c", makeBus());
    const bus = makeBus();
    let finishAbort!: () => void;
    const cancelling = reg.cancel("t1", bus, { abort: () => new Promise<void>((r) => { finishAbort = r; }) });
    await tick();

    expect(bus.events).toHaveLength(1); // already out, abort still pending
    expect(bus.finished).toHaveBeenCalledTimes(1);

    finishAbort();
    expect(await cancelling).toBe(true);
    expect(bus.events).toHaveLength(1);
  });

  it("calls abort with the run", async () => {
    const reg = new TaskRunRegistry();
    const run = reg.begin("t1", "c", makeBus());
    const abort = vi.fn(async () => {});
    await reg.cancel("t1", makeBus(), { abort });
    expect(abort).toHaveBeenCalledWith(run);
  });

  it("abort rejecting is swallowed and reported to onAbortFailed", async () => {
    const reg = new TaskRunRegistry();
    const run = reg.begin("t1", "c", makeBus());
    const onAbortFailed = vi.fn();
    const bus = makeBus();
    expect(await reg.cancel("t1", bus, { abort: async () => { throw new Error("boom"); }, onAbortFailed })).toBe(true);
    expect(onAbortFailed).toHaveBeenCalledWith(run, expect.objectContaining({ message: "boom" }));
    expect(bus.events).toHaveLength(1);
  });

  it("a synchronous throw in abort is handled the same way", async () => {
    const reg = new TaskRunRegistry();
    reg.begin("t1", "c", makeBus());
    const onAbortFailed = vi.fn();
    await reg.cancel("t1", makeBus(), { abort: () => { throw new Error("sync"); }, onAbortFailed });
    expect(onAbortFailed).toHaveBeenCalledOnce();
  });

  it("a hanging abort is bounded by a timeout, then onAbortFailed runs; the timer is cleared", async () => {
    vi.useFakeTimers();
    const reg = new TaskRunRegistry();
    reg.begin("t1", "c", makeBus());
    const onAbortFailed = vi.fn();
    const p = reg.cancel("t1", makeBus(), { abort: () => new Promise(() => {}), onAbortFailed });
    await vi.advanceTimersByTimeAsync(DEFAULT_ABORT_TIMEOUT_MS + 1);
    expect(await p).toBe(true);
    expect(onAbortFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: expect.stringContaining("timed out") }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honours a custom abortTimeoutMs and swallows an onAbortFailed that throws", async () => {
    vi.useFakeTimers();
    const reg = new TaskRunRegistry();
    reg.begin("t1", "c", makeBus());
    const p = reg.cancel("t1", makeBus(), {
      abort: () => new Promise(() => {}),
      abortTimeoutMs: 50,
      onAbortFailed: () => { throw new Error("cleanup failed"); },
    });
    await vi.advanceTimersByTimeAsync(51);
    await expect(p).resolves.toBe(true);
  });

  it("does not call onAbortFailed when abort succeeds", async () => {
    const reg = new TaskRunRegistry();
    reg.begin("t1", "c", makeBus());
    const onAbortFailed = vi.fn();
    await reg.cancel("t1", makeBus(), { abort: async () => {}, onAbortFailed });
    expect(onAbortFailed).not.toHaveBeenCalled();
  });
});

describe("TaskRun", () => {
  it("run.bus passes events through until canceled, then drops publish() and finished()", async () => {
    const reg = new TaskRunRegistry();
    const raw = makeBus();
    const run = reg.begin("t1", "c", raw);

    run.bus.publish({ kind: "x" } as any);
    expect(raw.events).toHaveLength(1);

    await reg.cancel("t1", makeBus());
    run.bus.publish({ kind: "late" } as any);
    run.bus.finished();
    expect(raw.events).toHaveLength(1);
    expect(raw.finished).not.toHaveBeenCalled();
  });

  it("run.bus delegates listener methods to the real bus", () => {
    const reg = new TaskRunRegistry();
    const raw = makeBus();
    const run = reg.begin("t1", "c", raw);
    const fn = () => {};
    run.bus.on("event", fn);
    run.bus.off("event", fn);
    expect(raw.on).toHaveBeenCalledWith("event", fn);
    expect(raw.off).toHaveBeenCalledWith("event", fn);
  });

  it("run.race resolves with the work's value when it settles first", async () => {
    const run = new TaskRunRegistry().begin("t1", "c", makeBus());
    expect(await run.race(Promise.resolve(42))).toBe(42);
  });

  it("run.race wakes immediately with CANCELED, and a later rejection is not unhandled", async () => {
    const reg = new TaskRunRegistry();
    const run = reg.begin("t1", "c", makeBus());
    let rejectWork!: (e: Error) => void;
    const work = new Promise<string>((_, rej) => { rejectWork = rej; });
    const raced = run.race(work);

    await reg.cancel("t1", makeBus());
    expect(await raced).toBe(CANCELED);
    rejectWork(new Error("Request aborted")); // must not surface as an unhandled rejection
    await tick();
  });

  it("run.race still propagates a rejection when the run was not canceled", async () => {
    const run = new TaskRunRegistry().begin("t1", "c", makeBus());
    await expect(run.race(Promise.reject(new Error("backend failed")))).rejects.toThrow("backend failed");
  });

  it("end() unregisters, and an older run's end() never removes a newer run of the same task", () => {
    const reg = new TaskRunRegistry();
    const a = reg.begin("t1", "c", makeBus());
    const b = reg.begin("t1", "c", makeBus());
    a.end();
    expect(reg.has("t1")).toBe(true);
    expect(reg.get("t1")).toBe(b);
    b.end();
    expect(reg.has("t1")).toBe(false);
  });

  it("concurrent tasks are independent", async () => {
    const reg = new TaskRunRegistry();
    const a = reg.begin("a", "c1", makeBus());
    const b = reg.begin("b", "c1", makeBus());
    await reg.cancel("a", makeBus());
    expect(a.canceled).toBe(true);
    expect(b.canceled).toBe(false);
    expect(b.signal.aborted).toBe(false);
  });
});
