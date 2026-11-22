/**
 * The turn ordinal (#124 b): `CoreRequest.turn` is 1-based per TASK, counts the turns a queued message, an interrupt or a
 * held message start, is persisted on the run record (`turnCount`) and keeps counting after a restart.
 */

import { describe, it, expect } from "vitest";
import { ANONYMOUS_CALLER, InMemoryRunStore, RunRegistry, newRecordHeader, turnArtifactId, type RunRecord } from "../../index.js";
import { makeInit, makeMessage, makeProvider, makePublisher, requestFor, tick } from "./harness.js";

async function until(cond: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

const by = { ...ANONYMOUS_CALLER };

describe("CoreRequest.turn", () => {
  it("is 1 for the first turn and counts the turns a queued message and an interrupt start", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    const done = registry.execute(makeInit("t1", "ctx", makePublisher()));
    await until(() => provider.runs.length === 1);
    expect(provider.runs[0]!.req.turn).toBe(1);

    const queued = makeMessage("queue", "second");
    await registry.deliver("t1", queued, by, requestFor("t1", queued));
    provider.runs[0]!.view.complete({ text: "one" });
    await until(() => provider.runs.length === 2);
    expect(provider.runs[1]!.req.turn).toBe(2);
    expect(provider.runs[1]!.req.runId).toBe(provider.runs[0]!.req.runId); // same task, same run, another turn

    const interrupting = makeMessage("interrupt", "third");
    await registry.deliver("t1", interrupting, by, requestFor("t1", interrupting));
    await until(() => provider.runs.length === 3);
    expect(provider.runs[2]!.req.turn).toBe(3);
    provider.runs[2]!.view.complete({ text: "three" });
    await done;
  });

  it("a held message that begins its own turn takes the next ordinal", async () => {
    const provider = makeProvider({ steer: () => ({ state: "queued", handle: "h1" }) });
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    const done = registry.execute(makeInit("t1", "ctx", makePublisher()));
    await until(() => provider.runs.length === 1);
    const steer = makeMessage("steer", "held");
    await registry.deliver("t1", steer, by, requestFor("t1", steer));
    const heldView = provider.runs[0]!.view.beginHeldTurn("h1");
    provider.runs[0]!.view.complete({ text: "first" });
    heldView.complete({ text: "second" });
    await done;
    // the held turn is the second turn of the task: its record says so
    await registry.drain();
    expect((await store.getRun("t1"))?.turnCount).toBe(2);
  });

  it("is persisted on the run record per turn", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    const done = registry.execute(makeInit("t1", "ctx", makePublisher()));
    await until(() => provider.runs.length === 1);
    await registry.drain();
    expect((await store.getRun("t1"))?.turnCount).toBe(1);
    const m = makeMessage("queue", "again");
    await registry.deliver("t1", m, by, requestFor("t1", m));
    provider.runs[0]!.view.complete({ text: "one" });
    await until(() => provider.runs.length === 2);
    await registry.drain();
    expect((await store.getRun("t1"))?.turnCount).toBe(2);
    provider.runs[1]!.view.complete({ text: "two" });
    await done;
  });

  it("keeps counting after a restart: a record of an earlier run of the task that never ended continues the ordinal", async () => {
    const store = new InMemoryRunStore();
    const rec: RunRecord = {
      ...newRecordHeader({ id: "anonymous", kind: "anonymous" }, "t"),
      runId: "run-before-restart",
      taskId: "t1",
      contextId: "ctx",
      turnId: "turn-3",
      state: "working",
      startedAt: "t",
      turnCount: 3,
    };
    await store.putRun(rec);
    const provider = makeProvider();
    const registry = new RunRegistry({ provider, store });
    void registry.execute(makeInit("t1", "ctx", makePublisher()));
    await until(() => provider.runs.length === 1);
    expect(provider.runs[0]!.req.turn).toBe(4);
    await registry.drain();
    expect((await store.getRun("t1"))?.turnCount).toBe(4);
  });

  it("keeps counting after a restart that adopts the run (an interrupted task re-attached by the provider)", async () => {
    const owner = { id: "anonymous", kind: "anonymous" };
    const store = new InMemoryRunStore();
    await store.putRun({
      ...newRecordHeader(owner, "t"),
      runId: "run-1",
      taskId: "t1",
      contextId: "ctx",
      turnId: "turn-2",
      state: "input-required",
      startedAt: "t",
      turnCount: 2,
    });
    await store.putPending({
      ...newRecordHeader(owner, "t"),
      interaction: { kind: "permission", id: "i1", title: "Run?", replyCode: "AB23", options: [{ id: "once", label: "Yes", kind: "allow_once" }] },
      taskId: "t1",
      contextId: "ctx",
      runId: "run-1",
      seq: 1,
      state: "presented",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      handle: "h-1",
    } as never);
    const provider = makeProvider();
    (provider as any).reattach = async (pending: any[], runs: any) => {
      void runs.view(pending[0].taskId).ask({ kind: "permission", title: "x", options: [{ id: "once", label: "Yes", kind: "allow_once" }] }, { handle: pending[0].handle });
    };
    const registry = new RunRegistry({ provider, store, interactionPolicy: { mode: "ask" } });
    await registry.sweep();
    const m = makeMessage("queue", "after the restart");
    await registry.deliver("t1", m, by, requestFor("t1", m));
    registry.viewFor("t1")!.complete({ text: "the adopted turn (2) is done" });
    await until(() => provider.runs.length === 1);
    expect(provider.runs[0]!.req.turn).toBe(3);
  });

  it("turnArtifactId builds ids that differ per turn", () => {
    expect(turnArtifactId("response", "t1", 1)).toBe("response-t1-1");
    expect(turnArtifactId("response", "t1", 2)).not.toBe(turnArtifactId("response", "t1", 1));
  });
});
