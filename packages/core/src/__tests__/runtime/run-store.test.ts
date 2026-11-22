import { describe, it, expect } from "vitest";
import {
  ANONYMOUS_CALLER,
  InMemoryRunStore,
  newRecordHeader,
  type QueuedMessageRecord,
  type RunRecord,
} from "../../index.js";

const owner = { id: "anonymous", kind: "anonymous" };
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ...newRecordHeader(owner, "t"),
  runId: "r",
  taskId: "t1",
  contextId: "c",
  turnId: "u",
  state: "working",
  startedAt: "t",
  ...over,
});
const q = (id: string, over: Partial<QueuedMessageRecord> = {}): QueuedMessageRecord => ({
  ...newRecordHeader(owner, "t"),
  taskId: "t1",
  contextId: "c",
  message: { id, role: "user", parts: [{ kind: "file", bytes: new Uint8Array([1, 2, 3]) }], from: ANONYMOUS_CALLER, at: "t" },
  holder: "core",
  state: "queued",
  ...over,
});

describe("InMemoryRunStore", () => {
  it("round-trips records through the encoded form: bytes survive, callers never share state", async () => {
    const s = new InMemoryRunStore();
    const rec = run({ input: [{ kind: "file", bytes: new Uint8Array([9, 8]) }] });
    await s.putRun(rec);
    const got = (await s.getRun("t1"))!;
    expect(got).not.toBe(rec);
    expect((got.input![0] as any).bytes).toEqual(new Uint8Array([9, 8]));
    got.state = "failed";
    expect((await s.getRun("t1"))?.state).toBe("working");
  });

  it("refuses a record that is not JSON-safe at write time", async () => {
    const s = new InMemoryRunStore();
    await expect(s.putRun({ ...run(), cancel: { requestedAt: "t", by: () => "x" } as any })).rejects.toThrow(/not JSON-safe/);
  });

  it("lists only non-terminal runs (unknown states included, never assumed finished)", async () => {
    const s = new InMemoryRunStore();
    await s.putRun(run({ taskId: "a", state: "completed" }));
    await s.putRun(run({ taskId: "b", state: "working" }));
    await s.putRun(run({ taskId: "c", state: "input-required" }));
    await s.putRun(run({ taskId: "d", state: "from-the-future" }));
    expect((await s.listNonTerminalRuns()).map((r) => r.taskId).sort()).toEqual(["b", "c", "d"]);
  });

  it("claims a queued message atomically: only one of two concurrent claims wins", async () => {
    const s = new InMemoryRunStore();
    await s.putQueued(q("m1", { position: 1 }));
    const results = await Promise.all([
      s.claimQueued("t1", "m1", "queued", "running"),
      s.claimQueued("t1", "m1", "queued", "running"),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect((await s.listQueued("t1"))[0].state).toBe("running");
    expect(await s.claimQueued("t1", "m1", "queued", "dropped")).toBe(false);
    expect(await s.claimQueued("t1", "missing", "queued", "running")).toBe(false);
  });

  it("claimQueued can record why a message ended, and lists in position order", async () => {
    const s = new InMemoryRunStore();
    await s.putQueued(q("b", { position: 2 }));
    await s.putQueued(q("a", { position: 1 }));
    await s.claimQueued("t1", "a", "queued", "unknown", "provider did not confirm");
    expect((await s.listQueued("t1")).map((r) => [r.message.id, r.state, r.reason])).toEqual([
      ["a", "unknown", "provider did not confirm"],
      ["b", "queued", undefined],
    ]);
  });

  it("stores and deletes context bindings", async () => {
    const s = new InMemoryRunStore();
    await s.putBinding({ ...newRecordHeader(owner, "t"), contextId: "c", session: { ref: "x", issuer: "p@1" } });
    expect((await s.getBinding("c"))?.session?.ref).toBe("x");
    expect(await s.deleteBinding("c")).toBe(true);
    expect(await s.getBinding("c")).toBeUndefined();
  });
});
