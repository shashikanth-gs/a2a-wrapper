/**
 * Cumulative usage readings (#124 a): `run.reportUsage`, `RunObservability.recordCumulative`. Core diffs a provider's running
 * total against the baseline kept with the context's binding (first turn, second turn, restart, decrease, other series,
 * per model, lost baseline, concurrent turns) and the per-turn delta reaches `x-usage` and `urn:a2a-wrapper:usage:v1`
 * through the real SDK request handler.
 */

import { describe, it, expect } from "vitest";
import {
  InMemoryRunStore,
  RunObservability,
  USAGE_META_KEY,
  createProviderTestServer,
  usageFromMetadata,
  type CoreRequest,
  type CoreTaskRun,
  type CoreUsage,
  type ProviderExecutor,
} from "../../index.js";
import { makeInit, makeProvider, makePublisher, tick } from "./harness.js";
import { RunRegistry } from "../../index.js";

const CALL = { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, durationMs: 1, timeToFirstTokenMs: null, apiEndpoint: null, initiator: "t" } as const;

const reading = (costUsd: number, over: Partial<CoreUsage> = {}): CoreUsage => ({ scope: "cumulative", series: "S1", tokens: {}, costUsd, ...over });

/** A provider whose turns report the readings the test queues, binding session `S1` first. */
function scripted(queue: Array<{ reading: CoreUsage; ref?: string }>): ProviderExecutor {
  return {
    info: () => ({ id: "fake", displayName: "Fake", inputModes: ["text/plain"], outputModes: ["text/plain"] }),
    initialize: async () => {},
    shutdown: async () => {},
    async run(req: CoreRequest, run: CoreTaskRun) {
      const step = queue.shift()!;
      await run.bind({ ref: step.ref ?? "S1" });
      const obs = new RunObservability({ agentName: "A", backend: "fake", request: req, run });
      await obs.recordCumulative(CALL, step.reading);
      const done = await obs.finish();
      run.complete({ ...(done.usage ? { usage: done.usage } : {}), meta: done.meta });
    },
  };
}

/** The `x-usage` cost and core usage of the completed status of one stream. */
async function turn(server: ReturnType<typeof createProviderTestServer>, taskId: string, contextId = "ctx") {
  const { events, error } = await server.stream({ text: "go", contextId });
  expect(error).toBeUndefined();
  const meta = events
    .map((e) => e.payload?.value)
    .filter((v) => v?.status?.state !== undefined && v.metadata?.["x-usage"])
    .pop()?.metadata;
  const core = usageFromMetadata(meta);
  return { cost: meta?.["x-usage"]?.cost as number | null | undefined, core, meta };
}

describe("run.reportUsage: cumulative readings become per-turn deltas", () => {
  it("first turn of a fresh series is the whole reading; the second turn is the difference (x-usage and the core usage key)", async () => {
    const q = [
      { reading: reading(0.5, { fresh: true, byModel: { m: { costUsd: 0.5, input: 10 } } }) },
      { reading: reading(0.8, { byModel: { m: { costUsd: 0.8, input: 25 } } }) },
    ];
    const server = createProviderTestServer(scripted(q));
    const t1 = await turn(server, "t1");
    expect(t1.cost).toBe(0.5);
    expect(t1.core?.scope).toBe("delta");
    expect(t1.core?.byModel?.m).toMatchObject({ costUsd: 0.5, input: 10 });
    const t2 = await turn(server, "t2");
    expect(t2.cost).toBe(0.3);
    expect(t2.core?.byModel?.m).toMatchObject({ costUsd: 0.3, input: 15 });
    expect(t2.meta[USAGE_META_KEY]).toBeDefined();
  });

  it("survives a restart: a new registry over the same store diffs against the persisted baseline", async () => {
    const store = new InMemoryRunStore();
    const first = createProviderTestServer(scripted([{ reading: reading(1, { fresh: true }) }]), { registry: { store } });
    expect((await turn(first, "t1")).cost).toBe(1);
    const second = createProviderTestServer(scripted([{ reading: reading(1.25) }]), { registry: { store } });
    expect((await turn(second, "t2")).cost).toBe(0.25);
    // the baseline lives with the binding in the store
    expect((await store.getBinding("ctx"))?.usageBaseline).toMatchObject({ series: "S1", costUsd: 1.25 });
  });

  it("a total that went down starts a new epoch: the reading is the delta, never a negative number", async () => {
    const server = createProviderTestServer(scripted([{ reading: reading(2, { fresh: true }) }, { reading: reading(0.4) }, { reading: reading(0.9) }]));
    await turn(server, "t1");
    expect((await turn(server, "t2")).cost).toBe(0.4);
    expect((await turn(server, "t3")).cost).toBe(0.5);
  });

  it("another series is a new total (the reading as it is), the baseline moves to it", async () => {
    const store = new InMemoryRunStore();
    const server = createProviderTestServer(
      scripted([
        { reading: reading(3, { fresh: true }) },
        { reading: reading(0.2, { series: "S2" }) },
        { reading: reading(0.5, { series: "S2" }) },
      ]),
      { registry: { store } },
    );
    await turn(server, "t1");
    expect((await turn(server, "t2")).cost).toBe(0.2);
    expect((await turn(server, "t3")).cost).toBe(0.3);
    expect((await store.getBinding("ctx"))?.usageBaseline?.series).toBe("S2");
  });

  it("per model: every model is diffed on its own and a decrease of one model starts its own epoch", async () => {
    const q = [
      { reading: reading(1, { fresh: true, byModel: { a: { costUsd: 0.6, input: 60 }, b: { costUsd: 0.4, input: 40 } } }) },
      { reading: reading(1.5, { byModel: { a: { costUsd: 0.7, input: 70 }, b: { costUsd: 0.1, input: 10 }, c: { costUsd: 0.7, input: 7 } } }) },
    ];
    const server = createProviderTestServer(scripted(q));
    await turn(server, "t1");
    const t2 = await turn(server, "t2");
    expect(t2.core?.byModel?.a).toMatchObject({ costUsd: 0.1, input: 10 });
    expect(t2.core?.byModel?.b).toMatchObject({ costUsd: 0.1, input: 10 }); // went down: the reading is the epoch's delta
    expect(t2.core?.byModel?.c).toMatchObject({ costUsd: 0.7, input: 7 }); // a model that is new in this reading
  });

  it("a lost baseline (a session that was bound and never read) reports NOTHING for a resumed total, and the next turn is exact", async () => {
    const store = new InMemoryRunStore();
    const server = createProviderTestServer(scripted([{ reading: reading(5) }, { reading: reading(5.5) }]), { registry: { store } });
    const lost = await turn(server, "t1"); // not fresh, no baseline
    expect(lost.cost).toBeNull(); // no cost claimed, not 5
    expect(lost.core?.costUsd).toBeNull();
    expect(lost.core?.byModel?.m?.costUsd).toBeNull();
    expect((await turn(server, "t2")).cost).toBe(0.5);
  });

  it("a lost baseline with a fresh series is the whole reading", async () => {
    const server = createProviderTestServer(scripted([{ reading: reading(5, { fresh: true }) }]));
    expect((await turn(server, "t1")).cost).toBe(5);
  });

  it("rebinding another session ref drops the baseline; the same ref keeps it", async () => {
    const store = new InMemoryRunStore();
    const q = [
      { reading: reading(1, { fresh: true }) },
      { reading: reading(1.5) }, // same ref S1: continues
      { reading: reading(9) }, // ref S9, same series name: the baseline is gone, so it is a lost baseline
    ];
    const server = createProviderTestServer(scripted(q), { registry: { store } });
    await turn(server, "t1");
    expect((await turn(server, "t2")).cost).toBe(0.5);
    q.unshift(); // keep the queue as is
    const server2 = createProviderTestServer(scripted([{ reading: reading(9), ref: "S9" }]), { registry: { store } });
    expect((await turn(server2, "t3")).cost).toBeNull();
    expect((await store.getBinding("ctx"))?.session?.ref).toBe("S9");
  });

  it("a delta reading is returned as it is and stores no baseline", async () => {
    const store = new InMemoryRunStore();
    const server = createProviderTestServer(scripted([{ reading: { scope: "delta", tokens: {}, costUsd: 0.7 } }]), { registry: { store } });
    expect((await turn(server, "t1")).cost).toBe(0.7);
    expect((await store.getBinding("ctx"))?.usageBaseline).toBeUndefined();
  });

  it("two turns of one context at the same time are serialized by the lane: the deltas add up to the total, none negative", async () => {
    const q = [{ reading: reading(1, { fresh: true }) }, { reading: reading(1.75) }];
    const server = createProviderTestServer(scripted(q));
    const [a, b] = await Promise.all([turn(server, "a"), turn(server, "b")]);
    expect([a.cost, b.cost].every((c) => typeof c === "number" && c >= 0)).toBe(true);
    expect(Math.round(((a.cost as number) + (b.cost as number)) * 100) / 100).toBe(1.75);
  });

  it("a view that is no longer live reports nothing and stores nothing", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    const registry = new RunRegistry({ provider, store });
    const done = registry.execute(makeInit("t1", "ctx", makePublisher()));
    for (let i = 0; i < 50 && provider.runs.length === 0; i++) await tick();
    const view = provider.runs[0]!.view;
    await view.bind({ ref: "S1" });
    await registry.cancel("t1", { id: "anonymous", kind: "anonymous" });
    await done;
    const late = await view.reportUsage(reading(7, { fresh: true }));
    expect(late.costUsd).toBeUndefined();
    expect((await store.getBinding("ctx"))?.usageBaseline).toBeUndefined();
  });
});

describe("RunObservability.usageNow", () => {
  it("is what finish reports (x-usage and the core usage with the per-model deltas), without closing the lifecycle", async () => {
    const reportUsage = async (r: CoreUsage): Promise<CoreUsage> => ({ scope: "delta", tokens: {}, costUsd: (r.costUsd ?? 0) / 2, byModel: { m: { costUsd: (r.costUsd ?? 0) / 2, input: 5 } } });
    const events: string[] = [];
    const obs = new RunObservability({
      agentName: "A",
      backend: "fake",
      request: { taskId: "t", contextId: "c", correlation: { eventId: "e", metadata: {} } },
      run: { artifact: (a) => void events.push(a.name ?? ""), reportUsage },
    });
    await obs.recordCumulative(CALL, reading(1));
    const now = obs.usageNow();
    expect(now.summary?.cost).toBe(0.5);
    expect(now.usage?.byModel?.m).toMatchObject({ costUsd: 0.5, input: 5 });
    expect(events).not.toContain("trace.lifecycle"); // nothing closed
    const done = await obs.finish();
    expect(done.summary?.cost).toBe(0.5);
    expect(done.usage?.byModel?.m).toMatchObject({ costUsd: 0.5, input: 5 });
  });
});

describe("a degenerate reading never becomes the baseline", () => {
  const nul: CoreUsage = { scope: "cumulative", series: "S1", tokens: {}, costUsd: null };
  const empty: CoreUsage = { scope: "cumulative", series: "S1", tokens: {} };

  it("a reading with no cost between two real ones reports nothing and the next turn is the difference, not the whole total", async () => {
    const server = createProviderTestServer(scripted([{ reading: reading(1, { fresh: true }) }, { reading: nul }, { reading: reading(2) }]));
    expect((await turn(server, "t1")).cost).toBe(1);
    expect((await turn(server, "t2")).cost).toBeNull(); // nothing claimed
    expect((await turn(server, "t3")).cost).toBe(1);
    // and an absent cost behaves the same
    const server2 = createProviderTestServer(scripted([{ reading: reading(1, { fresh: true }) }, { reading: empty }, { reading: reading(2) }]));
    await turn(server2, "t1");
    await turn(server2, "t2");
    expect((await turn(server2, "t3")).cost).toBe(1);
  });

  it("a zeroed reading (a crash or startup-error result) does not replace a non-zero baseline", async () => {
    const server = createProviderTestServer(scripted([{ reading: reading(1, { fresh: true, byModel: { m: { costUsd: 1, input: 5 } } }) }, { reading: reading(0, { byModel: { m: { costUsd: 0, input: 0 } } }) }, { reading: reading(2) }]));
    await turn(server, "t1");
    expect((await turn(server, "t2")).cost).toBeNull();
    expect((await turn(server, "t3")).cost).toBe(1);
  });

  it("a model the reading leaves out keeps its baseline entry, and a missing field keeps the old value", async () => {
    const server = createProviderTestServer(
      scripted([
        { reading: reading(1, { fresh: true, byModel: { a: { costUsd: 0.6, input: 6 }, b: { costUsd: 0.4, input: 4 } } }) },
        { reading: reading(1.5, { byModel: { a: { costUsd: 0.9, input: 9 } } }) }, // b not listed
        { reading: reading(2, { byModel: { a: { costUsd: 1, input: 10 }, b: { costUsd: 0.5, input: 5 } } }) },
      ]),
    );
    await turn(server, "t1");
    await turn(server, "t2");
    const t3 = await turn(server, "t3");
    expect(t3.core?.byModel?.b).toMatchObject({ costUsd: 0.1, input: 1 }); // not reported in full
  });

  it("a genuine reset (/clear) is not degenerate: a smaller non-zero total is a new epoch on its first real reading", async () => {
    const server = createProviderTestServer(scripted([{ reading: reading(2, { fresh: true }) }, { reading: reading(0.4) }, { reading: reading(0.9) }]));
    await turn(server, "t1");
    expect((await turn(server, "t2")).cost).toBe(0.4);
    expect((await turn(server, "t3")).cost).toBe(0.5);
  });

  it("a degenerate reading with a lost baseline stores nothing: the next real reading is not reported in full either", async () => {
    const store = new InMemoryRunStore();
    const server = createProviderTestServer(scripted([{ reading: nul }, { reading: reading(5) }, { reading: reading(5.5) }]), { registry: { store } });
    await turn(server, "t1");
    expect((await store.getBinding("ctx"))?.usageBaseline).toBeUndefined();
    expect((await turn(server, "t2")).cost).toBeNull(); // still a lost baseline: nothing claimed, stored now
    expect((await turn(server, "t3")).cost).toBe(0.5);
  });
});
