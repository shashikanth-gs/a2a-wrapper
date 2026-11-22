/**
 * The `RunStore` contract, as a reusable test suite.
 *
 * `runStoreContractTests(name, factory)` registers one `describe` block that exercises EVERY method of the `RunStore`
 * interface (runs, context bindings, queued messages with the atomic `claimQueued`, pending interactions). A store that
 * is not in memory (SQLite, Postgres, ...) is verified by calling it with its own factory; nothing here knows how the
 * store keeps its data. `factory` must return an EMPTY store each time (a fresh database, schema or key prefix).
 *
 * ```ts
 * runStoreContractTests("SqliteRunStore", () => new SqliteRunStore(":memory:"));
 * ```
 *
 * The suite pins what the run runtime relies on (design doc 3.6, 3.10, 3.11, 3.12): records come back as equal but never
 * shared copies, a record that is not JSON-safe fails at WRITE time, `claimQueued` is a real compare-and-set (exactly one of
 * any number of concurrent claims wins; this is what keeps a message from starting twice across instances or a crash),
 * queued messages list in `position` order, and pending interactions list in `seq` order.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ANONYMOUS_CALLER,
  newRecordHeader,
  type ContextBinding,
  type PendingInteraction,
  type QueuedMessageRecord,
  type RunRecord,
  type RunStore,
} from "../../index.js";

const owner = { id: "anonymous", kind: "anonymous" };

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ...newRecordHeader(owner, "2026-01-01T00:00:00.000Z"),
  runId: "r1",
  taskId: "t1",
  contextId: "c1",
  turnId: "u1",
  state: "working",
  startedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const queued = (id: string, over: Partial<QueuedMessageRecord> = {}): QueuedMessageRecord => ({
  ...newRecordHeader(owner, "2026-01-01T00:00:00.000Z"),
  taskId: "t1",
  contextId: "c1",
  message: { id, role: "user", parts: [{ kind: "text", text: `message ${id}` }], from: ANONYMOUS_CALLER, at: "2026-01-01T00:00:00.000Z" },
  holder: "core",
  state: "queued",
  ...over,
});

const pending = (id: string, seq: number, over: Partial<PendingInteraction> = {}): PendingInteraction => ({
  ...newRecordHeader(owner, "2026-01-01T00:00:00.000Z"),
  interaction: {
    kind: "confirm",
    id,
    title: `approve ${id}?`,
    options: [
      { id: "yes", label: "Yes", kind: "allow_once" },
      { id: "no", label: "No", kind: "reject_once" },
    ],
  } as PendingInteraction["interaction"],
  taskId: "t1",
  contextId: "c1",
  runId: "r1",
  seq,
  state: "presented",
  expiresAt: "2026-01-01T01:00:00.000Z",
  ...over,
});

const binding = (contextId: string, ref: string): ContextBinding => ({
  ...newRecordHeader(owner, "2026-01-01T00:00:00.000Z"),
  contextId,
  session: { ref, issuer: "provider@1" },
});

export function runStoreContractTests(name: string, factory: () => RunStore | Promise<RunStore>): void {
  describe(`RunStore contract: ${name}`, () => {
    let store: RunStore;
    beforeEach(async () => {
      store = await factory();
    });

    describe("runs", () => {
      it("returns undefined for an unknown task", async () => {
        expect(await store.getRun("nope")).toBeUndefined();
      });

      it("round-trips a record, bytes included, and returns copies the caller cannot use to change the store", async () => {
        const rec = run({ input: [{ kind: "file", bytes: new Uint8Array([9, 8, 7]) }] });
        await store.putRun(rec);
        const got = (await store.getRun("t1"))!;
        expect(got).toEqual(rec);
        expect((got.input![0] as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([9, 8, 7]));
        got.state = "failed";
        expect((await store.getRun("t1"))?.state).toBe("working");
        rec.state = "completed";
        expect((await store.getRun("t1"))?.state).toBe("working"); // the writer's later changes do not reach the store either
      });

      it("putRun replaces the record of the same task and keeps tasks apart", async () => {
        await store.putRun(run({ taskId: "a", state: "working" }));
        await store.putRun(run({ taskId: "b", state: "working" }));
        await store.putRun(run({ taskId: "a", state: "completed" }));
        expect((await store.getRun("a"))?.state).toBe("completed");
        expect((await store.getRun("b"))?.state).toBe("working");
      });

      it("refuses a record that is not JSON-safe at WRITE time and keeps what was there", async () => {
        await store.putRun(run());
        await expect(store.putRun({ ...run(), cancel: { requestedAt: "t", by: () => "x" } as never })).rejects.toThrow();
        expect((await store.getRun("t1"))?.state).toBe("working");
      });

      it("listNonTerminalRuns returns active, interrupted and UNKNOWN states and no terminal one", async () => {
        for (const [taskId, state] of [
          ["done", "completed"],
          ["failed", "failed"],
          ["canceled", "canceled"],
          ["rejected", "rejected"],
          ["working", "working"],
          ["submitted", "submitted"],
          ["asked", "input-required"],
          ["auth", "auth-required"],
          ["future", "from-the-future"],
        ] as const) {
          await store.putRun(run({ taskId, state }));
        }
        expect((await store.listNonTerminalRuns()).map((r) => r.taskId).sort()).toEqual(["asked", "auth", "future", "submitted", "working"]);
      });

      it("a run that ends leaves the non-terminal list", async () => {
        await store.putRun(run());
        expect(await store.listNonTerminalRuns()).toHaveLength(1);
        await store.putRun(run({ state: "completed", endedAt: "2026-01-01T00:01:00.000Z" }));
        expect(await store.listNonTerminalRuns()).toHaveLength(0);
      });
    });

    describe("context bindings", () => {
      it("returns undefined for an unknown context", async () => {
        expect(await store.getBinding("nope")).toBeUndefined();
      });

      it("stores, replaces and deletes a binding per context", async () => {
        await store.putBinding(binding("c1", "s1"));
        await store.putBinding(binding("c2", "s2"));
        expect((await store.getBinding("c1"))?.session?.ref).toBe("s1");
        await store.putBinding(binding("c1", "s1b"));
        expect((await store.getBinding("c1"))?.session?.ref).toBe("s1b");
        expect(await store.deleteBinding("c1")).toBe(true);
        expect(await store.getBinding("c1")).toBeUndefined();
        expect((await store.getBinding("c2"))?.session?.ref).toBe("s2"); // untouched
      });

      it("deleting a binding that is not there is not an error and reports false", async () => {
        await expect(store.deleteBinding("never-stored")).resolves.toBe(false);
      });

      it("deleteBinding with ifRef is a compare-and-delete: only the binding that still names that ref goes", async () => {
        await store.putBinding(binding("c1", "s1"));
        expect(await store.deleteBinding("c1", "other")).toBe(false);
        expect((await store.getBinding("c1"))?.session?.ref).toBe("s1");
        await store.putBinding(binding("c1", "s2")); // replaced meanwhile
        expect(await store.deleteBinding("c1", "s1")).toBe(false);
        expect((await store.getBinding("c1"))?.session?.ref).toBe("s2");
        expect(await store.deleteBinding("c1", "s2")).toBe(true);
        expect(await store.getBinding("c1")).toBeUndefined();
      });

      it("listBindings returns every binding (decoded copies, any order)", async () => {
        expect(await store.listBindings()).toEqual([]);
        await store.putBinding(binding("c1", "s1"));
        await store.putBinding(binding("c2", "s2"));
        const all = await store.listBindings();
        expect(all.map((b) => b.contextId).sort()).toEqual(["c1", "c2"]);
        all[0].contextId = "mutated"; // a copy: the store is unaffected
        expect((await store.listBindings()).map((b) => b.contextId).sort()).toEqual(["c1", "c2"]);
        await store.deleteBinding("c1");
        expect((await store.listBindings()).map((b) => b.contextId)).toEqual(["c2"]);
      });

      it("touchBinding sets lastUsedAt only, never updatedAt, and never revives or marks the wrong binding", async () => {
        expect(await store.touchBinding("c1", "2026-02-01T00:00:00.000Z")).toBe(false); // nothing there: nothing created
        expect(await store.getBinding("c1")).toBeUndefined();
        await store.putBinding(binding("c1", "s1"));
        expect(await store.touchBinding("c1", "2026-02-01T00:00:00.000Z", "other")).toBe(false); // another session
        expect((await store.getBinding("c1"))?.lastUsedAt).toBeUndefined();
        expect(await store.touchBinding("c1", "2026-02-01T00:00:00.000Z", "s1")).toBe(true);
        const b = await store.getBinding("c1");
        expect(b?.lastUsedAt).toBe("2026-02-01T00:00:00.000Z");
        expect(b?.updatedAt).toBe("2026-01-01T00:00:00.000Z"); // the content did not change
        expect(b?.session?.ref).toBe("s1");
        expect(await store.touchBinding("c1", "2026-03-01T00:00:00.000Z")).toBe(true); // no ifRef: any
        expect((await store.getBinding("c1"))?.lastUsedAt).toBe("2026-03-01T00:00:00.000Z");
      });

      it("a binding round-trips owner, tenant, meta and lastUsedAt, and a non-JSON meta fails at write time", async () => {
        const b: ContextBinding = {
          ...newRecordHeader({ id: "alice", kind: "user" }, "2026-01-01T00:00:00.000Z", "acme"),
          contextId: "c1",
          lastUsedAt: "2026-01-02T00:00:00.000Z",
          session: { ref: "s1", meta: { thread: "t-1", n: [1, 2] }, issuer: "provider@1" },
        };
        await store.putBinding(b);
        expect(await store.getBinding("c1")).toEqual(b);
        const bad = { ...b, session: { ref: "s", meta: { when: new Date() } as never, issuer: "p@1" } };
        await expect(store.putBinding(bad)).rejects.toThrow();
        expect((await store.getBinding("c1"))?.session?.ref).toBe("s1"); // the failed write changed nothing
      });
    });

    describe("queued messages", () => {
      it("lists nothing for a task without any", async () => {
        expect(await store.listQueued("t1")).toEqual([]);
      });

      it("round-trips a message, bytes included, as a copy", async () => {
        const rec = queued("m1", { position: 1 });
        rec.message = { ...rec.message, parts: [{ kind: "file", bytes: new Uint8Array([1, 2, 3]) }] };
        await store.putQueued(rec);
        const got = (await store.listQueued("t1"))[0];
        expect(got).toEqual(rec);
        expect((got.message.parts[0] as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([1, 2, 3]));
        got.state = "dropped";
        expect((await store.listQueued("t1"))[0].state).toBe("queued");
      });

      it("lists in position order, whatever the insertion order; records without a position come after", async () => {
        await store.putQueued(queued("c", { position: 3 }));
        await store.putQueued(queued("none"));
        await store.putQueued(queued("a", { position: 1 }));
        await store.putQueued(queued("b", { position: 2 }));
        expect((await store.listQueued("t1")).map((r) => r.message.id)).toEqual(["a", "b", "c", "none"]);
      });

      it("keys a record by task and message id: putQueued replaces it, other tasks are apart", async () => {
        await store.putQueued(queued("m1", { position: 1 }));
        await store.putQueued(queued("m1", { position: 1, holder: "provider", handle: "h-1" }));
        await store.putQueued(queued("m1", { taskId: "t2", position: 1 }));
        const t1 = await store.listQueued("t1");
        expect(t1).toHaveLength(1);
        expect(t1[0]).toMatchObject({ holder: "provider", handle: "h-1" });
        expect(await store.listQueued("t2")).toHaveLength(1);
      });

      it("refuses a record that is not JSON-safe at write time", async () => {
        const bad = queued("m1");
        bad.message = { ...bad.message, meta: { when: new Date() } };
        await expect(store.putQueued(bad)).rejects.toThrow();
        expect(await store.listQueued("t1")).toEqual([]);
      });

      it("claimQueued moves a record from one state to another and says so", async () => {
        await store.putQueued(queued("m1", { position: 1 }));
        expect(await store.claimQueued("t1", "m1", "queued", "running")).toBe(true);
        expect((await store.listQueued("t1"))[0].state).toBe("running");
      });

      it("claimQueued is a compare-and-set: the wrong `from` or an unknown message changes nothing and returns false", async () => {
        await store.putQueued(queued("m1", { position: 1 }));
        expect(await store.claimQueued("t1", "m1", "running", "done")).toBe(false);
        expect(await store.claimQueued("t1", "missing", "queued", "running")).toBe(false);
        expect(await store.claimQueued("other-task", "m1", "queued", "running")).toBe(false);
        expect((await store.listQueued("t1"))[0].state).toBe("queued");
        expect(await store.claimQueued("t1", "m1", "queued", "running")).toBe(true);
        expect(await store.claimQueued("t1", "m1", "queued", "dropped")).toBe(false); // already claimed
        expect((await store.listQueued("t1"))[0].state).toBe("running");
      });

      it("claimQueued is ATOMIC: of many concurrent claims exactly one wins", async () => {
        await store.putQueued(queued("m1", { position: 1 }));
        const results = await Promise.all(Array.from({ length: 12 }, () => store.claimQueued("t1", "m1", "queued", "running")));
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await store.listQueued("t1"))[0].state).toBe("running");
      });

      it("claimQueued of different messages of one task are independent", async () => {
        await store.putQueued(queued("a", { position: 1 }));
        await store.putQueued(queued("b", { position: 2 }));
        const results = await Promise.all([store.claimQueued("t1", "a", "queued", "running"), store.claimQueued("t1", "b", "queued", "running")]);
        expect(results).toEqual([true, true]);
      });

      it("claimQueued records why a message ended, keeps it, and touches nothing else", async () => {
        await store.putQueued(queued("a", { position: 1 }));
        await store.putQueued(queued("b", { position: 2 }));
        expect(await store.claimQueued("t1", "a", "queued", "dropped", "task canceled")).toBe(true);
        const [a, b] = await store.listQueued("t1");
        expect(a).toMatchObject({ state: "dropped", reason: "task canceled", message: { id: "a" } });
        expect(b).toMatchObject({ state: "queued", message: { id: "b" } });
        expect(b.reason).toBeUndefined();
        // a claim without a reason keeps the reason already stored
        expect(await store.claimQueued("t1", "a", "dropped", "unknown")).toBe(true);
        expect((await store.listQueued("t1"))[0].reason).toBe("task canceled");
      });

      it("claimQueued advances updatedAt and keeps the message as it was", async () => {
        const rec = queued("a", { position: 1 });
        await store.putQueued(rec);
        await store.claimQueued("t1", "a", "queued", "running");
        const got = (await store.listQueued("t1"))[0];
        expect(got.message).toEqual(rec.message);
        expect(Date.parse(got.updatedAt)).toBeGreaterThan(Date.parse(rec.updatedAt));
      });
    });

    describe("pending interactions", () => {
      it("returns undefined / empty for an unknown task or interaction", async () => {
        expect(await store.getPending("t1", "nope")).toBeUndefined();
        expect(await store.listPending("t1")).toEqual([]);
      });

      it("round-trips a record as a copy and finds it by task and interaction id", async () => {
        const rec = pending("i1", 1, { handle: "provider-handle" });
        await store.putPending(rec);
        const got = (await store.getPending("t1", "i1"))!;
        expect(got).toEqual(rec);
        got.state = "expired";
        expect((await store.getPending("t1", "i1"))?.state).toBe("presented");
        expect(await store.getPending("t2", "i1")).toBeUndefined(); // keyed by task as well
      });

      it("putPending replaces the record of the same interaction (the state changes in place)", async () => {
        await store.putPending(pending("i1", 1));
        await store.putPending(pending("i1", 1, { state: "answered", result: { outcome: "selected", optionId: "yes", by: ANONYMOUS_CALLER } }));
        expect(await store.listPending("t1")).toHaveLength(1);
        expect((await store.getPending("t1", "i1"))?.state).toBe("answered");
        expect((await store.getPending("t1", "i1"))?.result).toMatchObject({ outcome: "selected", optionId: "yes" });
      });

      it("lists every interaction of a task in seq order whatever its state, and no other task's", async () => {
        await store.putPending(pending("c", 3, { state: "queued" }));
        await store.putPending(pending("a", 1, { state: "answered" }));
        await store.putPending(pending("b", 2, { state: "expired" }));
        await store.putPending(pending("x", 1, { taskId: "t2" }));
        expect((await store.listPending("t1")).map((p) => [p.interaction.id, p.state])).toEqual([
          ["a", "answered"],
          ["b", "expired"],
          ["c", "queued"],
        ]);
        expect((await store.listPending("t2")).map((p) => p.interaction.id)).toEqual(["x"]);
      });

      it("refuses a record that is not JSON-safe at write time", async () => {
        const bad = pending("i1", 1, { interaction: { ...pending("i1", 1).interaction, meta: { fn: () => 1 } } as never });
        await expect(store.putPending(bad)).rejects.toThrow();
        expect(await store.listPending("t1")).toEqual([]);
      });
    });
  });
}
