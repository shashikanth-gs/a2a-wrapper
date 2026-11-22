/**
 * `run.bind` reports whether it was stored (#124 d): `"stored"` or `"dropped"`, never rejects, never throws for a view
 * that is no longer live, and a caller that ignores the result keeps compiling and working.
 */

import { describe, it, expect } from "vitest";
import { ANONYMOUS_CALLER, InMemoryRunStore, RunRegistry, type ContextBinding } from "../../index.js";
import { ContextBindings } from "../../runtime/bindings.js";
import { makeInit, makeProvider, makePublisher, tick } from "./harness.js";

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await tick();
}

const alice = { id: "alice", kind: "user" };
const bob = { id: "bob", kind: "user" };

function bindings(store = new InMemoryRunStore(), logs: string[] = []) {
  return new ContextBindings({
    store,
    log: { warn: (m) => void logs.push(m) },
    now: () => "2026-01-01T00:00:00.000Z",
    issuer: () => "fake@1",
    release: async () => {},
    authorize: () => true,
    busy: () => false,
  });
}

describe("bind result", () => {
  it("a live view resolves 'stored' once the binding is in the store", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    void registry.execute(makeInit("t1", "ctx", makePublisher()));
    await until(() => provider.runs.length === 1);
    await expect(provider.runs[0]!.view.bind({ ref: "S1" })).resolves.toBe("stored");
    expect((await store.getBinding("ctx"))?.session?.ref).toBe("S1");
  });

  it("a view that is not live resolves 'dropped' and never throws, even for arguments a live view would refuse", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    const done = registry.execute(makeInit("t1", "ctx", makePublisher()));
    await until(() => provider.runs.length === 1);
    const view = provider.runs[0]!.view;
    await registry.cancel("t1", ANONYMOUS_CALLER);
    await done;
    await expect(view.bind({ ref: "late" })).resolves.toBe("dropped");
    await expect(view.bind({ ref: "" })).resolves.toBe("dropped");
    expect(await store.getBinding("ctx")).toBeUndefined();
  });

  it("a live view still throws a TypeError for a bad argument (unchanged), synchronously", async () => {
    const provider = makeProvider();
    const registry = new RunRegistry({ provider, store: new InMemoryRunStore() });
    void registry.execute(makeInit("t1", "ctx", makePublisher()));
    await until(() => provider.runs.length === 1);
    expect(() => provider.runs[0]!.view.bind({ ref: "" })).toThrow(TypeError);
  });

  it("a caller that ignores the result (a void use) still stores the binding", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    void registry.execute(makeInit("t1", "ctx", makePublisher()));
    await until(() => provider.runs.length === 1);
    provider.runs[0]!.view.bind({ ref: "S1" }); // no await, no catch
    await registry.drain();
    expect((await store.getBinding("ctx"))?.session?.ref).toBe("S1");
  });

  it("'dropped' for a bind from a turn older than the one that bound last", async () => {
    const b = bindings();
    expect(await b.bind({ contextId: "c", caller: alice, session: { ref: "new" }, seq: 5 })).toBe("stored");
    expect(await b.bind({ contextId: "c", caller: alice, session: { ref: "old" }, seq: 4 })).toBe("dropped");
  });

  it("'dropped' for a context another caller owns", async () => {
    const b = bindings();
    await b.bind({ contextId: "c", caller: alice, session: { ref: "a" }, seq: 1 });
    expect(await b.bind({ contextId: "c", caller: bob, session: { ref: "b" }, seq: 2 })).toBe("dropped");
  });

  it("'dropped' (not a rejection) when the store fails", async () => {
    class Failing extends InMemoryRunStore {
      async putBinding(_b: ContextBinding): Promise<void> {
        throw new Error("disk full");
      }
    }
    const logs: string[] = [];
    const b = bindings(new Failing(), logs);
    await expect(b.bind({ contextId: "c", caller: alice, session: { ref: "a" }, seq: 1 })).resolves.toBe("dropped");
    expect(logs.join()).toContain("binding write failed");
  });
});
