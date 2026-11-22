/**
 * `run.settleSteer(handle, "requeue")` (#124 c): a provider-held steer that would be lost (an interrupt ends the backend
 * process and its native queue) moves into core's queue and runs as the next turn.
 */

import { describe, it, expect } from "vitest";
import { ANONYMOUS_CALLER, InMemoryRunStore, RunRegistry } from "../../index.js";
import { makeInit, makeMessage, makeProvider, makePublisher, requestFor, tick } from "./harness.js";

async function until(cond: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

const by = { ...ANONYMOUS_CALLER };
const textOf = (req: { input: readonly { kind: string; text?: string }[] }) => req.input.map((p) => p.text ?? "").join("");

/** A running task whose provider holds every steer under the handle `held-<message id>`. */
async function setup(over: Partial<ConstructorParameters<typeof RunRegistry>[0]> = {}) {
  const provider = makeProvider({ steer: (_v, m) => ({ state: "queued", handle: `held-${m.id}` }) });
  const store = new InMemoryRunStore();
  const registry = new RunRegistry({ provider, store, ...over });
  const publisher = makePublisher();
  const done = registry.execute(makeInit("t1", "ctx", publisher));
  await until(() => provider.runs.length === 1);
  const steer = async (text: string) => {
    const m = makeMessage("steer", text);
    const r = await registry.deliver("t1", m, by, requestFor("t1", m));
    expect(r).toMatchObject({ state: "queued", holder: "provider" });
    return m;
  };
  return { provider, store, registry, publisher, done, steer };
}

describe("settleSteer(handle, 'requeue')", () => {
  it("moves the held message into core's queue: record queued/core, the task stays open and runs it as the next turn", async () => {
    const s = await setup();
    const m = await s.steer("do this next");
    const view = s.provider.runs[0]!.view;
    view.settleSteer(`held-${m.id}`, "requeue");
    await s.registry.drain();
    const [rec] = await s.store.listQueued("t1");
    expect(rec).toMatchObject({ holder: "core", state: "queued" });
    expect(rec!.handle).toBeUndefined();
    expect(rec!.position).toBeDefined();

    view.complete({ text: "first turn" });
    await until(() => s.provider.runs.length === 2);
    expect(textOf(s.provider.runs[1]!.req)).toBe("do this next");
    expect(s.provider.runs[1]!.req.turn).toBe(2);
    expect(s.provider.runs[1]!.req.runId).toBe(s.provider.runs[0]!.req.runId);
    expect(s.publisher.terminal()).toHaveLength(0); // the task is not terminal while the message waits
    s.provider.runs[1]!.view.complete({ text: "second turn" });
    await s.done;
    await s.registry.drain();
    expect(s.publisher.terminal()).toHaveLength(1);
    expect((await s.store.listQueued("t1"))[0]).toMatchObject({ state: "done" });
  });

  it("ahead of what was queued after it: the held message was sent first", async () => {
    const s = await setup();
    const held = await s.steer("sent first");
    const later = makeMessage("queue", "sent second");
    await s.registry.deliver("t1", later, by, requestFor("t1", later));
    s.provider.runs[0]!.view.settleSteer(`held-${held.id}`, "requeue");
    s.provider.runs[0]!.view.complete({ text: "one" });
    await until(() => s.provider.runs.length === 2);
    expect(textOf(s.provider.runs[1]!.req)).toBe("sent first");
    s.provider.runs[1]!.view.complete({ text: "two" });
    await until(() => s.provider.runs.length === 3);
    expect(textOf(s.provider.runs[2]!.req)).toBe("sent second");
    s.provider.runs[2]!.view.complete({ text: "three" });
    await s.done;
  });

  it("is idempotent by message id: a second call, or an unknown handle, changes nothing", async () => {
    const s = await setup();
    const m = await s.steer("once");
    const view = s.provider.runs[0]!.view;
    view.settleSteer(`held-${m.id}`, "requeue");
    view.settleSteer(`held-${m.id}`, "requeue");
    view.settleSteer("no-such-handle", "requeue");
    view.complete({ text: "one" });
    await until(() => s.provider.runs.length === 2);
    s.provider.runs[1]!.view.complete({ text: "two" });
    await s.done;
    expect(s.provider.runs).toHaveLength(2); // the message ran once
    expect(await s.store.listQueued("t1")).toHaveLength(1);
  });

  it("needs no turn to be running: requeued while the last turn already ended, the held message starts at once", async () => {
    const s = await setup();
    const m = await s.steer("late");
    const view = s.provider.runs[0]!.view;
    view.complete({ text: "one" }); // the task waits for the held message
    await tick();
    expect(s.publisher.terminal()).toHaveLength(0);
    view.settleSteer(`held-${m.id}`, "requeue");
    await until(() => s.provider.runs.length === 2);
    expect(textOf(s.provider.runs[1]!.req)).toBe("late");
    s.provider.runs[1]!.view.complete({ text: "two" });
    await s.done;
  });

  it("is silent after a cancel: nothing runs and nothing throws", async () => {
    const s = await setup();
    const m = await s.steer("never");
    const view = s.provider.runs[0]!.view;
    await s.registry.cancel("t1", by);
    await s.done;
    expect(() => view.settleSteer(`held-${m.id}`, "requeue")).not.toThrow();
    await s.registry.drain();
    expect(s.provider.runs).toHaveLength(1);
    expect((await s.store.listQueued("t1"))[0]).toMatchObject({ state: "dropped" });
  });

  it("survives a restart: the record is a core-queued message that the start-up sweep replays", async () => {
    const s = await setup();
    const m = await s.steer("replay me");
    s.provider.runs[0]!.view.settleSteer(`held-${m.id}`, "requeue");
    await s.registry.drain();
    // the process dies here; a new registry over the same store sweeps
    const replayed: string[] = [];
    const next = new RunRegistry({ provider: makeProvider(), store: s.store });
    const report = await next.sweep({ replay: async (rec) => void replayed.push(rec.message.id) });
    expect(replayed).toEqual([m.id]);
    expect(report.entries[0]!.queued.replayed).toEqual([m.id]);
  });
});
