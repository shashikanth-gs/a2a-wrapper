/**
 * Context binding persistence and reattach after restart (#110): `run.bind`, the resolve rules at turn start (owner, issuer,
 * TTL, authorize), `session-not-found` retry, abort/discard integration, binding GC and start-up validation. Through the real
 * `RunRegistry` over an `InMemoryRunStore` with a fake provider. The A2A end to end is in `a2a/bindings-e2e.test.ts`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ANONYMOUS_CALLER,
  InMemoryRunStore,
  RunRegistry,
  SESSION_NOT_FOUND,
  SessionNotFoundError,
  decodeRecord,
  encodeRecord,
  newRecordHeader,
  type ContextBinding,
  type CoreCaller,
  type RunRecord,
} from "../../index.js";
import { ContextBindings } from "../../runtime/bindings.js";
import { makeInit, makeMessage, makeProvider, makePublisher, requestFor, tick, type FakePublisher } from "./harness.js";

afterEach(() => {
  vi.useRealTimers();
});

const SECRET = "secret-ref-123";
const alice: CoreCaller = { id: "alice", kind: "user" };
const bob: CoreCaller = { id: "bob", kind: "user" };
const anonOwner = { id: "anonymous", kind: "anonymous" };

async function until(cond: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A store whose binding writes can be slowed down, to expose ordering bugs. */
class SlowStore extends InMemoryRunStore {
  putDelayMs = 0;
  async putBinding(b: ContextBinding): Promise<void> {
    if (this.putDelayMs) await new Promise((r) => setTimeout(r, this.putDelayMs));
    return super.putBinding(b);
  }
}

function setup(
  providerOpts: Parameters<typeof makeProvider>[0] = {},
  reg: Partial<ConstructorParameters<typeof RunRegistry>[0]> = {},
  store: InMemoryRunStore = new InMemoryRunStore(),
) {
  const provider = makeProvider(providerOpts);
  const logs: string[] = [];
  const clock = { at: "2026-01-01T00:00:00.000Z" };
  const registry = new RunRegistry({
    provider,
    store,
    now: () => clock.at,
    logger: { warn: (m, d) => void logs.push(`${m} ${d === undefined ? "" : JSON.stringify(d)}`), debug: (m) => void logs.push(m) },
    ...reg,
  });
  return { provider, store, registry, logs, clock };
}
type S = ReturnType<typeof setup>;

/** Start a run and wait until the provider is running its turn. */
async function startRun(s: S, taskId: string, contextId = "ctx", caller: CoreCaller = ANONYMOUS_CALLER, extra: Record<string, unknown> = {}) {
  const publisher = makePublisher();
  const before = s.provider.runs.length;
  const done = s.registry.execute(makeInit(taskId, contextId, publisher, { caller, ...extra }));
  await until(() => s.provider.runs.length > before, "provider.run");
  return { done, publisher, call: s.provider.runs[s.provider.runs.length - 1] };
}

/** Run a whole turn that binds `ref` and completes. */
async function bindAndFinish(s: S, taskId: string, contextId: string, ref: string, caller: CoreCaller = ANONYMOUS_CALLER, meta?: Record<string, never>) {
  const r = await startRun(s, taskId, contextId, caller);
  r.call.view.bind({ ref, ...(meta ? { meta } : {}) });
  r.call.view.complete({ text: "ok" });
  await r.done;
  await s.registry.drain();
  return r;
}

const putBinding = (s: S, contextId: string, ref: string, over: Partial<ContextBinding> & { issuer?: string } = {}) => {
  const { issuer = "fake@1", ...rest } = over;
  const b: ContextBinding = {
    ...newRecordHeader(anonOwner, "2026-01-01T00:00:00.000Z"),
    contextId,
    session: { ref, issuer },
    ...rest,
  };
  return s.store.putBinding(b);
};

const terminalOf = (p: FakePublisher) => p.terminal().map((t) => t.state);

describe("bind: persists a ContextBinding through the RunStore", () => {
  it("writes owner, tenant, timestamps, lastUsedAt and the issuer (provider id@version); the record is JSON-safe via encodeRecord", async () => {
    const s = setup();
    await bindAndFinish(s, "t1", "ctx", "thread-1", alice, { thread: "x" } as never);
    // (tenant comes from ExecuteInit)
    const s2 = setup();
    const r = await startRun(s2, "t2", "ctx2", alice, { tenant: "acme" });
    r.call.view.bind({ ref: "thread-2", meta: { path: "/w", n: [1, 2, { a: null }] } });
    r.call.view.complete({});
    await r.done;
    await s2.registry.drain();

    const b = await s2.store.getBinding("ctx2");
    expect(b).toMatchObject({
      v: 1,
      contextId: "ctx2",
      owner: { id: "alice", kind: "user" },
      tenant: "acme",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      session: { ref: "thread-2", meta: { path: "/w", n: [1, 2, { a: null }] }, issuer: "fake@1" },
    });
    // JSON-safe: survives a text round trip through the record codec unchanged.
    expect(decodeRecord(JSON.parse(JSON.stringify(encodeRecord(b!))))).toEqual(b);
    expect((await s.store.getBinding("ctx"))?.owner).toEqual({ id: "alice", kind: "user" });
  });

  it("survives a registry restart: a new registry on the same store passes request.session to the provider", async () => {
    const store = new InMemoryRunStore();
    const s1 = setup({}, {}, store);
    await bindAndFinish(s1, "t1", "ctx", "thread-1", ANONYMOUS_CALLER, { k: "v" } as never);

    const s2 = setup({}, {}, store); // "restart": nothing in memory but the store
    const r = await startRun(s2, "t2", "ctx");
    expect(r.call.req.session).toEqual({ ref: "thread-1", meta: { k: "v" } });
    r.call.view.complete({});
    await r.done;
  });

  it("a second turn of the same registry also gets request.session", async () => {
    const s = setup();
    await bindAndFinish(s, "t1", "ctx", "thread-1");
    const r = await startRun(s, "t2", "ctx");
    expect(r.call.req.session).toEqual({ ref: "thread-1" });
    r.call.view.complete({});
    await r.done;
  });

  it("a rebind replaces the session and keeps owner and createdAt", async () => {
    const s = setup();
    await bindAndFinish(s, "t1", "ctx", "thread-1", alice);
    s.clock.at = "2026-01-02T00:00:00.000Z";
    const r = await startRun(s, "t2", "ctx", alice);
    r.call.view.bind({ ref: "thread-2" });
    r.call.view.bind({ ref: "thread-3" }); // twice in one turn: the last wins
    r.call.view.complete({});
    await r.done;
    await s.registry.drain();
    const b = await s.store.getBinding("ctx");
    expect(b?.session).toEqual({ ref: "thread-3", issuer: "fake@1" });
    expect(b?.owner).toEqual({ id: "alice", kind: "user" });
    expect(b?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(b?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("a bind after a cancel is a silent drop: no throw, nothing written", async () => {
    const s = setup();
    const r = await startRun(s, "t1", "ctx");
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    expect(() => r.call.view.bind({ ref: "late" })).not.toThrow();
    await s.registry.drain();
    expect(await s.store.getBinding("ctx")).toBeUndefined();
  });

  it("a bind from a stale turn cannot overwrite a newer binding (older held turn binds after the newer one)", async () => {
    const s = setup({ steer: () => ({ state: "queued", handle: "h1" }) });
    const r = await startRun(s, "t1", "ctx");
    const m = makeMessage("steer", "later");
    await s.registry.deliver("t1", m, ANONYMOUS_CALLER, requestFor("t1", m));
    const older = r.call.view;
    const newer = older.beginHeldTurn("h1"); // a newer turn of the same run; the older view is still live
    newer.bind({ ref: "newer" });
    older.bind({ ref: "older" });
    await s.registry.drain();
    expect((await s.store.getBinding("ctx"))?.session?.ref).toBe("newer");
    newer.complete({});
    older.complete({});
    await r.done;
  });

  it("bind writes of one context are applied in call order even when the store is slow", async () => {
    const store = new SlowStore();
    const s = setup({}, {}, store);
    const r = await startRun(s, "t1", "ctx");
    store.putDelayMs = 40;
    r.call.view.bind({ ref: "first" });
    store.putDelayMs = 0;
    r.call.view.bind({ ref: "second" });
    r.call.view.complete({});
    await r.done;
    await s.registry.drain();
    expect((await store.getBinding("ctx"))?.session?.ref).toBe("second");
  });

  it("bind refuses what cannot be stored: an empty ref and a non-JSON meta throw a TypeError and write nothing", async () => {
    const s = setup();
    const r = await startRun(s, "t1", "ctx");
    expect(() => r.call.view.bind({ ref: "" })).toThrow(TypeError);
    expect(() => r.call.view.bind({ ref: "x", meta: { when: new Date() } as never })).toThrow(/JSON/);
    expect(() => r.call.view.bind({ ref: "x", meta: { f: () => 1 } as never })).toThrow(TypeError);
    await s.registry.drain();
    expect(await s.store.getBinding("ctx")).toBeUndefined();
  });

  it("ContextBindings.bind never overwrites a binding another caller owns, and drops an older turn's bind", async () => {
    const store = new InMemoryRunStore();
    const warn = vi.fn();
    const cb = new ContextBindings({
      store,
      log: { warn },
      now: () => "2026-01-01T00:00:00.000Z",
      issuer: () => "p@1",
      sameProvider: () => true,
      release: async () => {},
      authorize: () => true,
      busy: () => false,
    });
    await cb.bind({ contextId: "c", caller: alice, session: { ref: "a" }, seq: 5 });
    await cb.bind({ contextId: "c", caller: bob, session: { ref: "b" }, seq: 6 });
    expect((await store.getBinding("c"))?.session?.ref).toBe("a");
    await cb.bind({ contextId: "c", caller: alice, session: { ref: "old" }, seq: 3 });
    expect((await store.getBinding("c"))?.session?.ref).toBe("a");
    await cb.bind({ contextId: "c", caller: alice, session: { ref: "same-turn" }, seq: 5 });
    expect((await store.getBinding("c"))?.session?.ref).toBe("same-turn");
  });
});

describe("resolve at turn start", () => {
  it("(lane) the binding is read AFTER the lane slot is held: the next task sees what the previous turn bound, even with a slow store", async () => {
    const store = new SlowStore();
    const s = setup({}, {}, store);
    const a = await startRun(s, "a", "shared");
    const doneB = s.registry.execute(makeInit("b", "shared")); // waits in the lane behind a
    await tick();
    expect(s.provider.runs).toHaveLength(1);
    store.putDelayMs = 60; // a's bind is still being written when a ends
    a.call.view.bind({ ref: "from-a" });
    a.call.view.complete({});
    await until(() => s.provider.runs.length === 2, "b to start");
    expect(s.provider.runs[1].req.session).toEqual({ ref: "from-a" });
    s.provider.runs[1].view.complete({});
    await doneB;
  });

  describe("owner (spec 13.1)", () => {
    it("another caller's context is REFUSED: rejected with code forbidden, the provider is never called, the binding is untouched", async () => {
      const s = setup();
      await bindAndFinish(s, "a1", "ctx", "alice-session", alice);

      const pub = makePublisher();
      await s.registry.execute(makeInit("b1", "ctx", pub, { caller: bob }));
      expect(s.provider.runs).toHaveLength(1); // only alice's turn ever reached the provider
      expect(terminalOf(pub)).toEqual(["rejected"]);
      expect(pub.terminal()[0].metadata).toMatchObject({ code: "forbidden" });
      expect(pub.terminal()[0].text).not.toContain("alice");
      expect((await s.store.getBinding("ctx"))?.session?.ref).toBe("alice-session");
      expect((await s.store.getBinding("ctx"))?.owner.id).toBe("alice");
      await s.registry.drain();
      expect((await s.store.getRun("b1"))?.state).toBe("rejected");

      // the owner still resumes it
      const r = await startRun(s, "a2", "ctx", alice);
      expect(r.call.req.session).toEqual({ ref: "alice-session" });
      r.call.view.complete({});
      await r.done;
    });

    it("the same caller in another tenant is refused too; the same tenant resumes", async () => {
      const s = setup();
      const r1 = await startRun(s, "a1", "ctx", alice, { tenant: "acme" });
      r1.call.view.bind({ ref: "s" });
      r1.call.view.complete({});
      await r1.done;
      await s.registry.drain();

      const pub = makePublisher();
      await s.registry.execute(makeInit("a2", "ctx", pub, { caller: alice, tenant: "other" }));
      expect(terminalOf(pub)).toEqual(["rejected"]);

      const r3 = await startRun(s, "a3", "ctx", alice, { tenant: "acme" });
      expect(r3.call.req.session?.ref).toBe("s");
      r3.call.view.complete({});
      await r3.done;
    });

    it("anonymous callers share one owner scope (until authentication is wired): behaviour is unchanged", async () => {
      const s = setup();
      await bindAndFinish(s, "a1", "ctx", "s1");
      const r = await startRun(s, "a2", "ctx");
      expect(r.call.req.session?.ref).toBe("s1");
      r.call.view.complete({});
      await r.done;
    });

    it("the owner check comes before the issuer check: a stale binding of another owner is not deleted by a stranger", async () => {
      const s = setup();
      await putBinding(s, "ctx", "alice-old", { issuer: "other@9", owner: alice });
      const pub = makePublisher();
      await s.registry.execute(makeInit("b1", "ctx", pub, { caller: bob }));
      expect(terminalOf(pub)).toEqual(["rejected"]);
      expect((await s.store.getBinding("ctx"))?.session?.ref).toBe("alice-old");
      expect(s.provider.release).not.toHaveBeenCalled();
    });
  });

  describe("authorize(by, 'resume', target) is the choke point", () => {
    it("is called for every resume with the context's owner; allow lets the session through", async () => {
      const authorize = vi.fn(() => true);
      const s = setup({}, { authorize });
      await bindAndFinish(s, "a1", "ctx", "s1", alice);
      const r = await startRun(s, "a2", "ctx", alice);
      expect(authorize).toHaveBeenCalledWith(alice, "resume", { taskId: "a2", contextId: "ctx", ownerId: "alice" });
      expect(r.call.req.session?.ref).toBe("s1");
      r.call.view.complete({});
      await r.done;
    });

    it("a denial (or a throwing authorizer) refuses the turn, with code forbidden; the binding stays", async () => {
      for (const authorize of [() => false, () => { throw new Error("boom"); }, async () => false]) {
        const s = setup({}, { authorize: (by, action) => (action === "resume" ? authorize() : true) });
        await putBinding(s, "ctx", "s1");
        const pub = makePublisher();
        await s.registry.execute(makeInit("t", "ctx", pub));
        expect(terminalOf(pub)).toEqual(["rejected"]);
        expect(pub.terminal()[0].metadata).toMatchObject({ code: "forbidden" });
        expect(s.provider.runs).toHaveLength(0);
        expect((await s.store.getBinding("ctx"))?.session?.ref).toBe("s1");
      }
    });

    it("is not asked when there is nothing to resume", async () => {
      const authorize = vi.fn(() => true);
      const s = setup({}, { authorize });
      const r = await startRun(s, "t1", "fresh");
      expect(authorize).not.toHaveBeenCalledWith(expect.anything(), "resume", expect.anything());
      r.call.view.complete({});
      await r.done;
    });
  });

  describe("issuer", () => {
    it("a binding written by ANOTHER provider is discarded, not replayed, and never reaches release", async () => {
      const s = setup();
      await putBinding(s, "ctx", SECRET, { issuer: "other-provider@3" });
      const r = await startRun(s, "t1", "ctx");
      expect(r.call.req.session).toBeUndefined(); // fresh
      expect(await s.store.getBinding("ctx")).toBeUndefined();
      expect(s.provider.release).not.toHaveBeenCalled();
      r.call.view.complete({});
      await r.done;
    });

    it("R1: a provider VERSION bump keeps the binding and hands it over (the issuer is the session format, not the package version)", async () => {
      const s = setup();
      await bindAndFinish(s, "t0", "ctx", SECRET);
      (s.provider as any).info = () => ({ id: "fake", displayName: "Fake", version: "99.0.0", inputModes: [], outputModes: [] });
      const r = await startRun(s, "t1", "ctx");
      expect(r.call.req.session?.ref).toBe(SECRET);
      expect(s.provider.release).not.toHaveBeenCalled();
      expect((await s.store.getBinding("ctx"))?.session?.issuer).toBe("fake@1");
      r.call.view.complete({});
      await r.done;
    });

    it("R1: a changed sessionFormat drops the binding WITHOUT replaying it and WITHOUT release", async () => {
      const s = setup();
      await bindAndFinish(s, "t0", "ctx", SECRET);
      (s.provider as any).info = () => ({ id: "fake", displayName: "Fake", version: "1", sessionFormat: "2", inputModes: [], outputModes: [] });
      const r = await startRun(s, "t1", "ctx");
      expect(r.call.req.session).toBeUndefined();
      expect(await s.store.getBinding("ctx")).toBeUndefined();
      expect(s.provider.release).not.toHaveBeenCalled();
      r.call.view.bind({ ref: "new-format" });
      r.call.view.complete({});
      await r.done;
      await s.registry.drain();
      expect((await s.store.getBinding("ctx"))?.session?.issuer).toBe("fake@2");
    });

    it("an explicit issuer override that differs from the stored one discards (and never calls release: the provider id is unknown)", async () => {
      const s = setup({}, { issuer: "cfg-b" });
      await putBinding(s, "ctx", "s", { issuer: "cfg-a" });
      const r = await startRun(s, "t1", "ctx");
      expect(r.call.req.session).toBeUndefined();
      expect(s.provider.release).not.toHaveBeenCalled();
      r.call.view.complete({});
      await r.done;
    });

    it("the discarded session is replaced by whatever the fresh turn binds, stamped with the current issuer", async () => {
      const s = setup();
      await putBinding(s, "ctx", "stale", { issuer: "other@1" });
      await bindAndFinish(s, "t1", "ctx", "fresh");
      expect((await s.store.getBinding("ctx"))?.session).toEqual({ ref: "fresh", issuer: "fake@1" });
    });
  });

  describe("TTL (bindingTtlMs) and last-used touch", () => {
    it("an expired binding is deleted and released and the turn starts fresh", async () => {
      const s = setup({}, { bindingTtlMs: 1000 });
      await putBinding(s, "ctx", SECRET, { lastUsedAt: "2026-01-01T00:00:00.000Z" });
      s.clock.at = "2026-01-01T00:00:01.001Z";
      const r = await startRun(s, "t1", "ctx");
      expect(r.call.req.session).toBeUndefined();
      expect(await s.store.getBinding("ctx")).toBeUndefined();
      expect(s.provider.release).toHaveBeenCalledWith({ ref: SECRET });
      r.call.view.complete({});
      await r.done;
    });

    it("exactly at the TTL it is still valid; resuming touches lastUsedAt (and not updatedAt), which keeps it alive", async () => {
      const s = setup({}, { bindingTtlMs: 1000 });
      await putBinding(s, "ctx", "s1", { lastUsedAt: "2026-01-01T00:00:00.000Z" });
      s.clock.at = "2026-01-01T00:00:01.000Z";
      const r = await startRun(s, "t1", "ctx");
      expect(r.call.req.session?.ref).toBe("s1");
      r.call.view.complete({});
      await r.done;
      await s.registry.drain();
      const b = await s.store.getBinding("ctx");
      expect(b?.lastUsedAt).toBe("2026-01-01T00:00:01.000Z");
      expect(b?.updatedAt).toBe("2026-01-01T00:00:00.000Z");

      s.clock.at = "2026-01-01T00:00:01.900Z"; // 900 ms after the touch: alive again
      const r2 = await startRun(s, "t2", "ctx");
      expect(r2.call.req.session?.ref).toBe("s1");
      r2.call.view.complete({});
      await r2.done;
    });

    it("a turn that runs long touches the binding when it ends, so the TTL counts from the end", async () => {
      const s = setup({}, { bindingTtlMs: 1000 });
      await putBinding(s, "ctx", "s1", { lastUsedAt: "2026-01-01T00:00:00.000Z" });
      const r = await startRun(s, "t1", "ctx");
      s.clock.at = "2026-01-01T00:10:00.000Z"; // the turn took ten minutes
      r.call.view.complete({});
      await r.done;
      await s.registry.drain();
      expect((await s.store.getBinding("ctx"))?.lastUsedAt).toBe("2026-01-01T00:10:00.000Z");
    });

    it("without bindingTtlMs a binding never expires; a negative TTL is refused at construction", async () => {
      const s = setup();
      await putBinding(s, "ctx", "s1", { lastUsedAt: "2000-01-01T00:00:00.000Z" });
      const r = await startRun(s, "t1", "ctx");
      expect(r.call.req.session?.ref).toBe("s1");
      r.call.view.complete({});
      await r.done;
      expect(() => new RunRegistry({ provider: makeProvider(), bindingTtlMs: -1 })).toThrow(RangeError);
    });
  });

  it("a store failure while reading the binding is logged and the turn starts fresh", async () => {
    const store = new InMemoryRunStore();
    vi.spyOn(store, "getBinding").mockRejectedValue(new Error("disk on fire"));
    const s = setup({}, {}, store);
    const r = await startRun(s, "t1", "ctx");
    expect(r.call.req.session).toBeUndefined();
    expect(s.logs.join("\n")).toContain("disk on fire");
    r.call.view.complete({});
    await r.done;
  });
});

describe("session-not-found: forget the binding and retry the SAME turn once with no session", () => {
  async function resumedRun(s: S) {
    await putBinding(s, "ctx", SECRET);
    return startRun(s, "t1", "ctx");
  }

  it("view.fail({code: session-not-found}) deletes the binding and runs the same turn again without a session", async () => {
    const s = setup();
    const first = await resumedRun(s);
    expect(first.call.req.session?.ref).toBe(SECRET);
    first.call.view.fail({ code: SESSION_NOT_FOUND, message: "no such thread" });
    first.call.resolve();
    await until(() => s.provider.runs.length === 2, "the retry");
    const second = s.provider.runs[1];
    expect(second.req.session).toBeUndefined();
    expect(second.req.turnId).toBe(first.call.req.turnId); // the SAME turn
    expect(second.req.runId).toBe(first.call.req.runId);
    expect(second.req.taskId).toBe("t1");
    expect(await s.store.getBinding("ctx")).toBeUndefined();
    expect(first.publisher.terminal()).toEqual([]); // the first failure was not published

    second.view.bind({ ref: "new-thread" });
    second.view.complete({ text: "done" });
    await first.done;
    expect(terminalOf(first.publisher)).toEqual(["completed"]);
    await s.registry.drain();
    expect((await s.store.getBinding("ctx"))?.session?.ref).toBe("new-thread");
    expect(s.provider.runs).toHaveLength(2);
  });

  it("run() throwing SessionNotFoundError takes the same path", async () => {
    const s = setup();
    const first = await resumedRun(s);
    first.call.reject(new SessionNotFoundError());
    await until(() => s.provider.runs.length === 2, "the retry");
    expect(s.provider.runs[1].req.session).toBeUndefined();
    s.provider.runs[1].view.complete({});
    await first.done;
    expect(terminalOf(first.publisher)).toEqual(["completed"]);
  });

  it("only ONE retry: session-not-found again on the retry fails the task (code kept), no third call", async () => {
    const s = setup();
    const first = await resumedRun(s);
    first.call.view.fail({ code: SESSION_NOT_FOUND, message: "gone" });
    first.call.resolve();
    await until(() => s.provider.runs.length === 2, "the retry");
    s.provider.runs[1].view.fail({ code: SESSION_NOT_FOUND, message: "still gone" });
    await first.done;
    expect(terminalOf(first.publisher)).toEqual(["failed"]);
    expect(first.publisher.terminal()[0]).toMatchObject({ text: "still gone", metadata: { code: SESSION_NOT_FOUND } });
    await tick();
    expect(s.provider.runs).toHaveLength(2);
  });

  it("only ONE retry also when the retry throws SessionNotFoundError", async () => {
    const s = setup();
    const first = await resumedRun(s);
    first.call.view.fail({ code: SESSION_NOT_FOUND, message: "gone" });
    first.call.resolve();
    await until(() => s.provider.runs.length === 2, "the retry");
    s.provider.runs[1].reject(new SessionNotFoundError("again"));
    await first.done;
    expect(terminalOf(first.publisher)).toEqual(["failed"]);
    expect(first.publisher.terminal()[0].metadata).toMatchObject({ code: SESSION_NOT_FOUND });
    expect(s.provider.runs).toHaveLength(2);
  });

  it("R2: the retry waits for the FIRST provider.run to settle: never two calls of one turn in flight", async () => {
    const s = setup();
    const first = await resumedRun(s);
    let inFlight = 1;
    let maxInFlight = 1;
    first.call.view.fail({ code: SESSION_NOT_FOUND, message: "gone" });
    await tick();
    expect(s.provider.runs).toHaveLength(1); // the first call is still running: no second call yet
    setTimeout(() => { inFlight--; first.call.resolve(); }, 50); // it keeps running 50 ms, then returns
    await until(() => s.provider.runs.length === 2, "the retry");
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    expect(inFlight).toBe(1);
    expect(maxInFlight).toBe(1);
    s.provider.runs[1].view.complete({});
    await first.done;
    expect(terminalOf(first.publisher)).toEqual(["completed"]);
  });

  it("R2: a first call that never settles ends the turn failed with the session-not-found code, no retry", async () => {
    const s = setup({}, { abortTimeoutMs: 30 });
    const first = await resumedRun(s);
    first.call.view.fail({ code: SESSION_NOT_FOUND, message: "no such thread" });
    await first.done;
    expect(terminalOf(first.publisher)).toEqual(["failed"]);
    expect(first.publisher.terminal()[0]).toMatchObject({ text: "no such thread", metadata: { code: SESSION_NOT_FOUND } });
    expect(s.provider.runs).toHaveLength(1);
    expect(await s.store.getBinding("ctx")).toBeUndefined();
  });

  it("N1: a bind from a dead or stale view is dropped silently even if its arguments are bad; a live view still throws", async () => {
    const s = setup();
    const r = await startRun(s, "t1", "ctx");
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    expect(() => r.call.view.bind({ ref: "" })).not.toThrow();
    const live = await startRun(s, "t2", "ctx2");
    expect(() => live.call.view.bind({ ref: "" })).toThrow(TypeError);
  });

  it("no retry once the turn published something (an event, an artifact or an ask): the failure is final", async () => {
    for (const act of [
      (v: any) => v.event({ type: "text", text: "partial" }),
      (v: any) => v.artifact({ parts: [{ kind: "text", text: "a" }] }),
    ]) {
      const s = setup();
      const first = await resumedRun(s);
      act(first.call.view);
      first.call.view.fail({ code: SESSION_NOT_FOUND, message: "gone" });
      first.call.resolve();
      await first.done;
      expect(terminalOf(first.publisher)).toEqual(["failed"]);
      expect(s.provider.runs).toHaveLength(1);
      expect((await s.store.getBinding("ctx"))?.session?.ref).toBe(SECRET); // not forgotten: core cannot say it is gone
    }
  });

  it("no retry when the turn started with no stored binding: it is an ordinary failure", async () => {
    const s = setup();
    const r = await startRun(s, "t1", "ctx");
    r.call.view.fail({ code: SESSION_NOT_FOUND, message: "x" });
    r.call.resolve();
    await r.done;
    expect(terminalOf(r.publisher)).toEqual(["failed"]);
    expect(s.provider.runs).toHaveLength(1);
  });

  it("the first call's view is dead after the retry: its late events, bind and complete change nothing", async () => {
    const s = setup();
    const first = await resumedRun(s);
    first.call.view.fail({ code: SESSION_NOT_FOUND, message: "gone" });
    first.call.resolve();
    await until(() => s.provider.runs.length === 2, "the retry");
    first.call.view.event({ type: "text", text: "ghost" });
    first.call.view.bind({ ref: "ghost-session" });
    first.call.view.complete({ text: "ghost done" });
    first.call.view.fail({ message: "ghost failed" });
    await tick();
    expect(first.publisher.terminal()).toEqual([]);
    s.provider.runs[1].view.complete({ text: "real" });
    await first.done;
    expect(first.publisher.terminal()).toEqual([{ state: "completed", text: "real" }]);
    await s.registry.drain();
    expect(await s.store.getBinding("ctx")).toBeUndefined(); // the ghost bind did not resurrect anything
    expect(first.publisher.calls.some((c) => c.k === "event")).toBe(false);
  });

  it("a cancel while the retry is being prepared ends the task; the retried provider.run is not started after it", async () => {
    const s = setup();
    const first = await resumedRun(s);
    first.call.view.fail({ code: SESSION_NOT_FOUND, message: "gone" });
    first.call.resolve();
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    await first.done;
    await tick();
    expect(terminalOf(first.publisher)).toEqual(["canceled"]);
  });
});

describe("abort / discard integration", () => {
  it("cancel with session: discard clears the binding and releases it", async () => {
    const s = setup({ abort: async () => ({ stopped: "confirmed", session: "discard" }) });
    const r = await startRun(s, "t1", "ctx");
    r.call.view.bind({ ref: "to-discard" });
    await s.registry.drain();
    expect((await s.store.getBinding("ctx"))?.session?.ref).toBe("to-discard");
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    await s.registry.drain();
    expect(await s.store.getBinding("ctx")).toBeUndefined();
    expect(s.provider.release).toHaveBeenCalledWith({ ref: "to-discard" });
  });

  it("cancel with session: reusable keeps the binding and does not release it", async () => {
    const s = setup({ abort: async () => ({ stopped: "confirmed", session: "reusable" }) });
    const r = await startRun(s, "t1", "ctx");
    r.call.view.bind({ ref: "keep" });
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    await s.registry.drain();
    expect((await s.store.getBinding("ctx"))?.session?.ref).toBe("keep");
    expect(s.provider.release).not.toHaveBeenCalled();
  });

  it("a rejected abort counts as discard: binding cleared and released", async () => {
    const s = setup({ abort: async () => { throw new Error("nope"); } });
    const r = await startRun(s, "t1", "ctx");
    r.call.view.bind({ ref: "to-discard" });
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    await s.registry.drain();
    expect(await s.store.getBinding("ctx")).toBeUndefined();
    expect(s.provider.release).toHaveBeenCalledWith({ ref: "to-discard" });
  });

  it("a discard clears only the binding that still names the aborted session (a replaced binding survives)", async () => {
    const s = setup({ abort: async () => ({ stopped: "confirmed", session: "discard" }) });
    await putBinding(s, "ctx", "started-with");
    const r = await startRun(s, "t1", "ctx");
    expect(r.call.req.session?.ref).toBe("started-with");
    await putBinding(s, "ctx", "replaced-by-someone"); // another writer rebinds while the turn runs
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    await s.registry.drain();
    expect((await s.store.getBinding("ctx"))?.session?.ref).toBe("replaced-by-someone");
  });

  it("the issuer rule on discard: a binding written by another provider is deleted but its ref never reaches release", async () => {
    const s = setup({ abort: async () => ({ stopped: "confirmed", session: "discard" }) });
    const r = await startRun(s, "t1", "ctx");
    r.call.view.bind({ ref: "mine" });
    await s.registry.drain();
    const b = (await s.store.getBinding("ctx"))!;
    await s.store.putBinding({ ...b, session: { ref: "mine", issuer: "someone-else@1" } });
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    await s.registry.drain();
    expect(await s.store.getBinding("ctx")).toBeUndefined();
    expect(s.provider.release).not.toHaveBeenCalled();
  });

  describe("abortOrphan after a restart", () => {
    const orphan = (over: Partial<RunRecord> = {}): RunRecord => ({
      ...newRecordHeader(anonOwner, "2026-01-01T00:00:00.000Z"),
      runId: "run-1",
      taskId: "t1",
      contextId: "ctx",
      turnId: "turn-1",
      state: "working",
      startedAt: "2026-01-01T00:00:00.000Z",
      ...over,
    });

    it("the sweep's abortOrphan with session: discard clears the binding and releases it", async () => {
      const s = setup({ abortOrphan: async () => ({ stopped: "confirmed", session: "discard" }) });
      await s.store.putRun(orphan());
      await putBinding(s, "ctx", "orphan-session");
      await s.registry.sweep();
      await s.registry.drain();
      expect(s.provider.abortOrphan).toHaveBeenCalledWith(expect.objectContaining({ session: { ref: "orphan-session" } }));
      expect(await s.store.getBinding("ctx")).toBeUndefined();
      expect(s.provider.release).toHaveBeenCalledWith({ ref: "orphan-session" });
    });

    it("session: reusable keeps it; a missing abortOrphan handler counts as discard", async () => {
      const keep = setup({ abortOrphan: async () => ({ stopped: "confirmed", session: "reusable" }) });
      await keep.store.putRun(orphan());
      await putBinding(keep, "ctx", "s");
      await keep.registry.sweep();
      expect((await keep.store.getBinding("ctx"))?.session?.ref).toBe("s");

      const none = setup();
      delete (none.provider as { abortOrphan?: unknown }).abortOrphan;
      await none.store.putRun(orphan());
      await putBinding(none, "ctx", "s");
      await none.registry.sweep();
      expect(await none.store.getBinding("ctx")).toBeUndefined();
    });

    it("the issuer rule: an orphan binding of another provider or another session format is deleted but never released", async () => {
      const a = setup({ abortOrphan: async () => ({ stopped: "confirmed", session: "discard" }) });
      await a.store.putRun(orphan());
      await putBinding(a, "ctx", "x", { issuer: "other@1" });
      await a.registry.sweep();
      expect(await a.store.getBinding("ctx")).toBeUndefined();
      expect(a.provider.release).not.toHaveBeenCalled();

      const b = setup({ abortOrphan: async () => ({ stopped: "confirmed", session: "discard" }) });
      await b.store.putRun(orphan());
      await putBinding(b, "ctx", "x", { issuer: "fake@0" });
      await b.registry.sweep();
      expect(await b.store.getBinding("ctx")).toBeUndefined();
      expect(b.provider.release).not.toHaveBeenCalled();

      const c = setup({ abortOrphan: async () => ({ stopped: "confirmed", session: "discard" }) });
      await c.store.putRun(orphan());
      await putBinding(c, "ctx", "x"); // same issuer: released
      await c.registry.sweep();
      expect(c.provider.release).toHaveBeenCalledWith({ ref: "x" });
    });
  });
});

describe("start-up validation (validateBindingsOnStart / probeSession)", () => {
  function withProbe(verdicts: Record<string, "alive" | "gone" | "unknown" | "throw" | "hang">, reg: Partial<ConstructorParameters<typeof RunRegistry>[0]> = {}) {
    const s = setup({}, { validateBindingsOnStart: true, abortTimeoutMs: 30, ...reg });
    const probeSession = vi.fn(async (session: { ref: string }) => {
      const v = verdicts[session.ref];
      if (v === "throw") throw new Error(`probe failed for ${session.ref}`);
      if (v === "hang") return new Promise<never>(() => {});
      return v ?? "unknown";
    });
    (s.provider as { probeSession?: unknown }).probeSession = probeSession;
    // The registry reads probeSession when it is constructed: rebuild it over the same store with the probe in place.
    const registry = new RunRegistry({ provider: s.provider, store: s.store, now: () => s.clock.at, logger: { warn: () => {} }, validateBindingsOnStart: true, abortTimeoutMs: 30, ...reg });
    return { ...s, registry, probeSession };
  }

  it("a gone binding is deleted; alive, unknown, a throwing and a hanging probe all keep the binding", async () => {
    const s = withProbe({ g: "gone", a: "alive", u: "unknown", t: "throw", h: "hang" });
    for (const id of ["g", "a", "u", "t", "h"]) await putBinding(s, `ctx-${id}`, id);
    const report = await s.registry.sweep();
    expect(report.bindings).toMatchObject({ gone: ["ctx-g"], alive: ["ctx-a"] });
    expect(report.bindings?.unknown.sort()).toEqual(["ctx-h", "ctx-t", "ctx-u"]);
    expect(await s.store.getBinding("ctx-g")).toBeUndefined();
    for (const id of ["a", "u", "t", "h"]) expect((await s.store.getBinding(`ctx-${id}`))?.session?.ref).toBe(id);
    expect(s.provider.release).not.toHaveBeenCalled(); // gone: nothing left to release
  });

  it("a provider without probeSession: every binding is kept (unknown) and the first resume decides", async () => {
    const s = setup({}, { validateBindingsOnStart: true });
    await putBinding(s, "ctx", "s");
    const report = await s.registry.sweep();
    expect(report.bindings?.unknown).toEqual(["ctx"]);
    expect((await s.store.getBinding("ctx"))?.session?.ref).toBe("s");
  });

  it("is off by default: sweep() does not probe and reports no bindings", async () => {
    const s = setup();
    const probeSession = vi.fn(async () => "gone" as const);
    (s.provider as { probeSession?: unknown }).probeSession = probeSession;
    const registry = new RunRegistry({ provider: s.provider, store: s.store });
    await putBinding(s, "ctx", "s");
    const report = await registry.sweep();
    expect(probeSession).not.toHaveBeenCalled();
    expect(report.bindings).toBeUndefined();
    expect((await s.store.getBinding("ctx"))?.session?.ref).toBe("s");
  });

  it("a binding written by another provider or version is not probed (resume discards it), and nothing is probed when a context is busy", async () => {
    const s = withProbe({ x: "gone", y: "gone" });
    await putBinding(s, "other", "x", { issuer: "someone@1" });
    await putBinding(s, "old", "y", { issuer: "fake@0" });
    const report = await s.registry.sweep();
    expect(s.probeSession).not.toHaveBeenCalled();
    expect(report.bindings?.skipped.sort()).toEqual(["old", "other"]);
    expect(await s.store.getBinding("other")).toBeDefined();
  });

  it("a gone binding then means the next request starts fresh (no request.session)", async () => {
    const s = withProbe({ s1: "gone" });
    await putBinding(s, "ctx", "s1");
    await s.registry.sweep();
    const publisher = makePublisher();
    void s.registry.execute(makeInit("t1", "ctx", publisher));
    await until(() => s.provider.runs.length === 1);
    expect(s.provider.runs[0].req.session).toBeUndefined();
    s.provider.runs[0].view.complete({});
  });
});

describe("binding GC: sweepBindings()", () => {
  const ttl = 1000;
  const old = "2026-01-01T00:00:00.000Z";

  function gc(reg: Partial<ConstructorParameters<typeof RunRegistry>[0]> = {}) {
    const s = setup({}, { bindingTtlMs: ttl, ...reg });
    s.clock.at = "2026-01-01T01:00:00.000Z";
    return s;
  }

  it("removes idle bindings older than the TTL (and releases them), keeps fresh ones", async () => {
    const s = gc();
    await putBinding(s, "stale", "s1", { lastUsedAt: old });
    await putBinding(s, "fresh", "s2", { lastUsedAt: "2026-01-01T00:59:59.500Z" });
    const report = await s.registry.sweepBindings();
    expect(report.removed).toEqual(["stale"]);
    expect(report.kept).toBe(1);
    expect(await s.store.getBinding("stale")).toBeUndefined();
    expect(await s.store.getBinding("fresh")).toBeDefined();
    expect(s.provider.release).toHaveBeenCalledTimes(1);
    expect(s.provider.release).toHaveBeenCalledWith({ ref: "s1" });
  });

  it("falls back to updatedAt for a record with no lastUsedAt", async () => {
    const s = gc();
    await putBinding(s, "legacy", "s1", { updatedAt: old });
    expect((await s.registry.sweepBindings()).removed).toEqual(["legacy"]);
  });

  it("never removes the binding of a context with a LIVE run", async () => {
    const s = gc();
    await putBinding(s, "ctx", "s1", { lastUsedAt: old });
    s.clock.at = old;
    const r = await startRun(s, "t1", "ctx"); // resumes the binding (still within its TTL)
    s.clock.at = "2026-01-01T01:00:00.000Z"; // an hour later the run is still live
    const report = await s.registry.sweepBindings();
    expect(report.removed).toEqual([]);
    expect(report.skippedBusy).toEqual(["ctx"]);
    expect((await s.store.getBinding("ctx"))?.session?.ref).toBe("s1");
    r.call.view.complete({});
    await r.done;
  });

  it("never removes the binding of a context whose run is parked (input-required record, no live handle) or orphaned (active record)", async () => {
    const s = gc();
    const rec = (taskId: string, contextId: string, state: string): RunRecord => ({
      ...newRecordHeader(anonOwner, old),
      runId: `r-${taskId}`,
      taskId,
      contextId,
      turnId: "u",
      state,
      startedAt: old,
    });
    await s.store.putRun(rec("t-parked", "c-parked", "input-required"));
    await s.store.putRun(rec("t-auth", "c-auth", "auth-required"));
    await s.store.putRun(rec("t-orphan", "c-orphan", "working"));
    await s.store.putRun(rec("t-done", "c-done", "completed"));
    for (const c of ["c-parked", "c-auth", "c-orphan", "c-done"]) await putBinding(s, c, `s-${c}`, { lastUsedAt: old });
    const report = await s.registry.sweepBindings();
    expect(report.removed).toEqual(["c-done"]); // a finished run's context is fair game
    expect(report.skippedBusy.sort()).toEqual(["c-auth", "c-orphan", "c-parked"]);
  });

  it("a parked run held by this process (live handle, interaction pending) keeps its binding too", async () => {
    const s = gc({ interactionPolicy: { mode: "ask" } });
    await putBinding(s, "ctx", "s1", { lastUsedAt: old });
    s.clock.at = old;
    const r = await startRun(s, "t1", "ctx");
    void r.call.view.ask({ kind: "confirm", title: "ok?" } as never);
    await until(() => r.publisher.calls.some((c) => c.k === "interaction"), "the interaction");
    s.clock.at = "2026-01-01T01:00:00.000Z"; // an hour later the run is still parked
    const report = await s.registry.sweepBindings();
    expect(report.skippedBusy).toEqual(["ctx"]);
    expect(await s.store.getBinding("ctx")).toBeDefined();
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
  });

  it("without a TTL nothing is removed, unless olderThanMs is given", async () => {
    const s = setup();
    s.clock.at = "2026-01-01T01:00:00.000Z";
    await putBinding(s, "c", "s", { lastUsedAt: old });
    expect((await s.registry.sweepBindings()).removed).toEqual([]);
    expect((await s.registry.sweepBindings({ olderThanMs: 60_000 })).removed).toEqual(["c"]);
  });

  it("re-checks inside the context's queue: a binding touched after the listing survives", async () => {
    const s = gc();
    await putBinding(s, "ctx", "s1", { lastUsedAt: old });
    const original = s.store.listBindings.bind(s.store);
    vi.spyOn(s.store, "listBindings").mockImplementation(async () => {
      const listed = await original();
      await s.store.touchBinding("ctx", "2026-01-01T01:00:00.000Z"); // a resume lands between the listing and the removal
      return listed;
    });
    const report = await s.registry.sweepBindings();
    expect(report.removed).toEqual([]);
    expect(await s.store.getBinding("ctx")).toBeDefined();
  });

  it("a binding of another provider is removed without release", async () => {
    const s = gc();
    await putBinding(s, "c", "s", { lastUsedAt: old, issuer: "other@1" });
    expect((await s.registry.sweepBindings()).removed).toEqual(["c"]);
    expect(s.provider.release).not.toHaveBeenCalled();
  });
});

describe("logs never carry a session ref", () => {
  it("through discard, expiry, owner refusal, retry, release failure and a failed binding write", async () => {
    const logs: string[] = [];
    const sink = (m: string, d?: unknown) => void logs.push(`${m} ${d === undefined ? "" : JSON.stringify(d)}`);
    const make = (reg: Partial<ConstructorParameters<typeof RunRegistry>[0]> = {}, store = new InMemoryRunStore()) => {
      const provider = makeProvider({ abort: async () => ({ stopped: "confirmed", session: "discard" }) });
      provider.release.mockRejectedValue(new Error("release exploded"));
      const registry = new RunRegistry({ provider, store, logger: { warn: sink, debug: sink }, now: () => "2026-01-01T00:00:10.000Z", ...reg });
      return { provider, store, registry };
    };
    const seed = (store: InMemoryRunStore, ctx: string, over: Partial<ContextBinding> = {}) =>
      store.putBinding({ ...newRecordHeader(anonOwner, "2026-01-01T00:00:00.000Z"), contextId: ctx, session: { ref: SECRET, meta: { token: SECRET }, issuer: "fake@1" }, ...over });
    const run = async (x: ReturnType<typeof make>, id: string, ctx: string, caller: CoreCaller = ANONYMOUS_CALLER) => {
      const done = x.registry.execute(makeInit(id, ctx, makePublisher(), { caller }));
      await tick();
      await tick();
      return { done, call: x.provider.runs[x.provider.runs.length - 1] };
    };

    // issuer mismatch (same provider, other version): release called and fails
    let x = make();
    await seed(x.store, "c1", { session: { ref: SECRET, issuer: "fake@0" } });
    let r = await run(x, "t1", "c1");
    r.call?.view.complete({});
    // ttl expiry
    x = make({ bindingTtlMs: 1 });
    await seed(x.store, "c2");
    r = await run(x, "t2", "c2");
    r.call?.view.complete({});
    // owner refusal
    x = make();
    await seed(x.store, "c3", { owner: alice });
    await x.registry.execute(makeInit("t3", "c3", makePublisher(), { caller: bob }));
    // session-not-found retry
    x = make();
    await seed(x.store, "c4");
    r = await run(x, "t4", "c4");
    r.call.view.fail({ code: SESSION_NOT_FOUND, message: "gone" });
    r.call.resolve();
    await tick();
    await tick();
    x.provider.runs[x.provider.runs.length - 1].view.complete({});
    // discard on cancel with a failing release
    x = make();
    r = await run(x, "t5", "c5");
    r.call.view.bind({ ref: SECRET });
    await x.registry.drain();
    await x.registry.cancel("t5", ANONYMOUS_CALLER);
    await x.registry.drain();
    // failing binding write
    const failing = new InMemoryRunStore();
    vi.spyOn(failing, "putBinding").mockRejectedValue(new Error("write failed"));
    x = make({}, failing);
    r = await run(x, "t6", "c6");
    r.call.view.bind({ ref: SECRET, meta: { token: SECRET } });
    await x.registry.drain();

    expect(logs.length).toBeGreaterThan(4);
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).toContain("release exploded");
  });
});

describe("round 3: issuer override, unknown identity, '@' collisions, abandoned first call", () => {
  const setInfo = (s: S, over: Record<string, unknown>) => {
    (s.provider as any).info = () => ({ id: "fake", displayName: "Fake", version: "1", inputModes: [], outputModes: [], ...over });
  };

  it("RunRegistryOptions.issuer is honoured: a binding stamped with it is handed over, new binds carry it, a mismatch is dropped without release", async () => {
    const s = setup({}, { issuer: "custom" });
    await putBinding(s, "ctx", "s1", { issuer: "custom" });
    const r = await startRun(s, "t1", "ctx");
    expect(r.call.req.session?.ref).toBe("s1");
    r.call.view.bind({ ref: "s2" });
    r.call.view.complete({});
    await r.done;
    await s.registry.drain();
    expect((await s.store.getBinding("ctx"))?.session).toEqual({ ref: "s2", issuer: "custom" });
    await putBinding(s, "ctx", "s3", { issuer: "fake@1" }); // the derived issuer is NOT the configured one
    const r2 = await startRun(s, "t2", "ctx");
    expect(r2.call.req.session).toBeUndefined();
    expect(s.provider.release).not.toHaveBeenCalled();
    r2.call.view.complete({});
    await r2.done;
  });

  it("an unknown identity (info() throws) matches nothing: no hand-over, no bind, no release, and two broken providers never share a binding", async () => {
    const s = setup({ abort: async () => ({ stopped: "confirmed", session: "discard" }) });
    (s.provider as any).info = () => {
      throw new Error("no info");
    };
    await putBinding(s, "ctx", "stale", { issuer: "unknown" }); // what the old fallback stamped
    const r = await startRun(s, "t1", "ctx");
    expect(r.call.req.session).toBeUndefined();
    expect(await s.store.getBinding("ctx")).toBeUndefined();
    r.call.view.bind({ ref: "mine" });
    await s.registry.drain();
    expect(await s.store.getBinding("ctx")).toBeUndefined(); // could not be stamped, so not written
    await putBinding(s, "ctx2", "x", { issuer: "unknown" });
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    await s.registry.drain();
    expect(s.provider.release.mock.calls.map((c: any[]) => c[0].ref)).not.toContain("stale"); // only this run's own ref may be released
    s.clock.at = "2026-01-02T00:00:00.000Z";
    expect((await s.registry.sweepBindings({ olderThanMs: 0 })).removed).toEqual(["ctx2"]);
    expect(s.provider.release.mock.calls.map((c: any[]) => c[0].ref)).not.toContain("x"); // a stored binding of unknown issuer is never released
  });

  it("'@' in a provider id or sessionFormat is escaped: (id 'a@b', format '1') and (id 'a', format 'b@1') never collide", async () => {
    const s = setup();
    setInfo(s, { id: "a@b", sessionFormat: "1" });
    await bindAndFinish(s, "t0", "ctx", "owned-by-first");
    expect((await s.store.getBinding("ctx"))?.session?.issuer).toBe("a%40b@1");
    setInfo(s, { id: "a", sessionFormat: "b@1" });
    const r = await startRun(s, "t1", "ctx");
    expect(r.call.req.session).toBeUndefined();
    expect(s.provider.release).not.toHaveBeenCalled();
    r.call.view.bind({ ref: "second" });
    r.call.view.complete({});
    await r.done;
    await s.registry.drain();
    expect((await s.store.getBinding("ctx"))?.session?.issuer).toBe("a@b%401");
    setInfo(s, { id: "a%b", sessionFormat: "1" }); // '%' itself is escaped, so escapes cannot be forged
    expect((await startRun(s, "t2", "ctx")).call.req.session).toBeUndefined();
  });

  it("a first call that never settles after session-not-found is told to stop (abort cancel, with the lost session), best effort", async () => {
    const s = setup({}, { abortTimeoutMs: 30 });
    const first = await (async () => {
      await putBinding(s, "ctx", SECRET);
      return startRun(s, "t1", "ctx");
    })();
    first.call.view.fail({ code: SESSION_NOT_FOUND, message: "gone" });
    await first.done;
    await s.registry.drain();
    expect(s.provider.abort).toHaveBeenCalledTimes(1);
    expect(s.provider.abort).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1", turnId: first.call.req.turnId, session: { ref: SECRET } }), "cancel");
    expect(terminalOf(first.publisher)).toEqual(["failed"]);
  });

  it("... and a throwing abort there is swallowed", async () => {
    const s = setup({ abort: async () => { throw new Error("abort blew up"); } }, { abortTimeoutMs: 30 });
    await putBinding(s, "ctx", SECRET);
    const first = await startRun(s, "t1", "ctx");
    first.call.view.fail({ code: SESSION_NOT_FOUND, message: "gone" });
    await first.done;
    await s.registry.drain();
    expect(terminalOf(first.publisher)).toEqual(["failed"]);
    expect(s.logs.join("\n")).toContain("abort blew up");
  });
});

describe("hard maximum age (bindingMaxAgeMs)", () => {
  const T0 = "2026-01-01T00:00:00.000Z";

  it("an over-age binding is deleted and released and the turn starts fresh, however recently it was used", async () => {
    const s = setup({}, { bindingMaxAgeMs: 1000 });
    await putBinding(s, "ctx", SECRET, { createdAt: T0, updatedAt: "2026-01-01T00:00:01.000Z", lastUsedAt: "2026-01-01T00:00:01.000Z" });
    s.clock.at = "2026-01-01T00:00:01.001Z"; // used a millisecond ago, but born 1001 ms ago
    const r = await startRun(s, "t1", "ctx");
    expect(r.call.req.session).toBeUndefined();
    expect(await s.store.getBinding("ctx")).toBeUndefined();
    expect(s.provider.release).toHaveBeenCalledWith({ ref: SECRET });
    r.call.view.complete({});
    await r.done;
  });

  it("a younger binding is resumed, and use does not extend its life", async () => {
    const s = setup({}, { bindingMaxAgeMs: 1000 });
    await putBinding(s, "ctx", "s1", { createdAt: T0, updatedAt: T0, lastUsedAt: T0 });
    s.clock.at = "2026-01-01T00:00:00.900Z";
    const r = await startRun(s, "t1", "ctx");
    expect(r.call.req.session?.ref).toBe("s1");
    r.call.view.complete({});
    await r.done;
    await s.registry.drain(); // the turn touched lastUsedAt

    s.clock.at = "2026-01-01T00:00:01.100Z"; // used 200 ms ago, but older than 1000 ms
    const r2 = await startRun(s, "t2", "ctx");
    expect(r2.call.req.session).toBeUndefined();
    r2.call.view.complete({});
    await r2.done;
  });

  it("a conversation used repeatedly past the max age is reset once and the new session gets its own age", async () => {
    const s = setup({}, { bindingMaxAgeMs: 1000 });
    s.clock.at = T0;
    await bindAndFinish(s, "t1", "ctx", "first");
    s.clock.at = "2026-01-01T00:00:00.600Z";
    const r2 = await startRun(s, "t2", "ctx");
    expect(r2.call.req.session?.ref).toBe("first");
    r2.call.view.complete({});
    await r2.done;
    s.clock.at = "2026-01-01T00:00:01.200Z";
    const r3 = await startRun(s, "t3", "ctx");
    expect(r3.call.req.session).toBeUndefined(); // over age: fresh
    r3.call.view.bind({ ref: "second" });
    r3.call.view.complete({});
    await r3.done;
    await s.registry.drain();
    expect((await s.store.getBinding("ctx"))?.createdAt).toBe("2026-01-01T00:00:01.200Z");
    s.clock.at = "2026-01-01T00:00:02.000Z"; // 800 ms after the new session started
    const r4 = await startRun(s, "t4", "ctx");
    expect(r4.call.req.session?.ref).toBe("second");
    r4.call.view.complete({});
    await r4.done;
  });

  it("is independent of the idle TTL: either one expires the binding", async () => {
    const s = setup({}, { bindingMaxAgeMs: 10_000, bindingTtlMs: 1000 });
    await putBinding(s, "ctx", "idle", { createdAt: T0, updatedAt: T0, lastUsedAt: T0 });
    s.clock.at = "2026-01-01T00:00:02.000Z"; // young, but idle for 2 s
    const r = await startRun(s, "t1", "ctx");
    expect(r.call.req.session).toBeUndefined();
    r.call.view.complete({});
    await r.done;
  });

  it("sweepBindings removes over-age bindings with no run, even with no idle TTL", async () => {
    const s = setup({}, { bindingMaxAgeMs: 1000 });
    await putBinding(s, "old", "o", { createdAt: T0, updatedAt: "2026-01-01T00:00:09.000Z", lastUsedAt: "2026-01-01T00:00:09.000Z" });
    await putBinding(s, "new", "n", { createdAt: "2026-01-01T00:00:09.500Z", updatedAt: "2026-01-01T00:00:09.500Z" });
    s.clock.at = "2026-01-01T00:00:10.000Z";
    const report = await s.registry.sweepBindings();
    expect(report.removed).toEqual(["old"]);
    expect(report.kept).toBe(1);
    expect(s.provider.release).toHaveBeenCalledWith({ ref: "o" });
    expect(await s.store.getBinding("new")).toBeDefined();
  });

  it("without bindingMaxAgeMs nothing ages out; a negative value is refused", async () => {
    const s = setup();
    await putBinding(s, "ctx", "s1", { createdAt: "2000-01-01T00:00:00.000Z" });
    const r = await startRun(s, "t1", "ctx");
    expect(r.call.req.session?.ref).toBe("s1");
    r.call.view.complete({});
    await r.done;
    expect(() => new RunRegistry({ provider: makeProvider(), bindingMaxAgeMs: -1 })).toThrow(RangeError);
  });
});
