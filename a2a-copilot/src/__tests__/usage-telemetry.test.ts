/**
 * Integration tests: LLM usage telemetry through the provider and the real request handler.
 *
 *   10.1  streaming + trackUsage:true  -> K trace.usage artifacts
 *   10.2  streaming + trackUsage:false -> 0 trace.usage artifacts
 *   10.3  final completed event has the correct metadata["x-usage"] structure
 *   10.4  metadata["x-usage"] absent on failed / canceled events
 *   10.5  non-streaming mode emits the same metadata["x-usage"] shape as streaming
 *   10.6  (new) the same totals travel as core usage metadata, per model
 *
 * Strategy: a faked Copilot session fires `assistant.usage` events; what is asserted is what an A2A client receives.
 */

import { describe, it, expect } from "vitest";
import { stateName } from "@a2a-wrapper/core";
import { ManualClient, ManualSession } from "./helpers/manual-session.js";
import { runTask, usagePayload, xUsageOf } from "./helpers/run-task.js";
import { CopilotProvider } from "../copilot/provider.js";
import { createProviderTestServer, summarizeEvent } from "@a2a-wrapper/core";
import { makeConfig } from "./helpers/config.js";

const traceUsage = (summary: ReturnType<typeof Array.prototype.slice>) =>
  (summary as any[]).filter((e) => e.k === "artifact" && e.name === "trace.usage");

describe("10.1 streaming mode, trackUsage:true emits K trace.usage artifacts", () => {
  it("emits exactly K trace.usage artifacts when K assistant.usage events fire", async () => {
    const K = 3;
    const { summary } = await runTask({
      streaming: true,
      trackUsage: true,
      usage: Array.from({ length: K }, (_, i) => usagePayload({ inputTokens: (i + 1) * 10 })),
    });
    expect(traceUsage(summary)).toHaveLength(K);
    // each carries the call record as a JSON data part
    expect(traceUsage(summary)[0].parts[0].data).toMatchObject({ model: "gpt-4", inputTokens: 10, durationMs: 200 });
    expect(traceUsage(summary)[0].extensions).toEqual(["urn:x-a2a:trace:v1"]);
  });

  it("emits 0 trace.usage artifacts when no assistant.usage events fire", async () => {
    const { summary } = await runTask({ streaming: true, trackUsage: true, usage: [] });
    expect(traceUsage(summary)).toHaveLength(0);
  });
});

describe("10.2 streaming mode, trackUsage:false emits 0 trace.usage artifacts", () => {
  it("emits no trace.usage artifacts regardless of K assistant.usage events", async () => {
    const { summary } = await runTask({
      streaming: true,
      trackUsage: false,
      usage: [usagePayload({ inputTokens: 100 }), usagePayload({ inputTokens: 200 })],
    });
    expect(traceUsage(summary)).toHaveLength(0);
  });

  it("emits no trace.usage artifacts when trackUsage is absent from config", async () => {
    const { summary } = await runTask({ streaming: true, usage: [usagePayload()], features: { trackUsage: undefined } });
    expect(traceUsage(summary)).toHaveLength(0);
  });
});

describe('10.3 final completed event has correct metadata["x-usage"] structure', () => {
  it("final completed event has state:completed and a valid x-usage object", async () => {
    const { summary } = await runTask({ streaming: true, usage: [usagePayload({ inputTokens: 150, outputTokens: 75, cost: 0 })] });
    const finalCompleted = summary.find((e) => e.k === "status" && e.state === "completed");
    expect(finalCompleted).toBeDefined();

    const xUsage = xUsageOf(summary);
    expect(xUsage).toBeDefined();
    expect(typeof xUsage.llmCalls).toBe("number");
    expect(xUsage.llmCalls).toBeGreaterThanOrEqual(0);
    expect(typeof xUsage.inputTokens).toBe("number");
    expect(xUsage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(typeof xUsage.outputTokens).toBe("number");
    expect(xUsage.outputTokens).toBeGreaterThanOrEqual(0);
    // cost must be null or a finite number >= 0
    if (xUsage.cost !== null) {
      expect(typeof xUsage.cost).toBe("number");
      expect(Number.isFinite(xUsage.cost)).toBe(true);
      expect(xUsage.cost).toBeGreaterThanOrEqual(0);
    }
    expect(Array.isArray(xUsage.calls)).toBe(true);
  });

  it("x-usage reflects accumulated token counts from all usage events", async () => {
    const { summary } = await runTask({
      streaming: true,
      usage: [
        usagePayload({ inputTokens: 100, outputTokens: 50, cost: 0.01 }),
        usagePayload({ inputTokens: 200, outputTokens: 80, cost: 0.02 }),
      ],
    });
    const xUsage = xUsageOf(summary);
    expect(xUsage.llmCalls).toBe(2);
    expect(xUsage.inputTokens).toBe(300);
    expect(xUsage.outputTokens).toBe(130);
    expect(xUsage.cost).toBeCloseTo(0.03, 5);
  });

  it("x-usage is present and valid even when zero LLM calls were made", async () => {
    const { summary } = await runTask({ streaming: true, usage: [] });
    const xUsage = xUsageOf(summary);
    expect(xUsage.llmCalls).toBe(0);
    expect(xUsage.inputTokens).toBe(0);
    expect(xUsage.cost).toBeNull();
    expect(xUsage.calls).toEqual([]);
  });
});

describe('10.4 metadata["x-usage"] absent on failed, canceled events', () => {
  it("failed terminal event has no metadata[x-usage]", async () => {
    const { summary } = await runTask({ streaming: true, failCreate: new Error("forced session failure") });
    const failed = summary.filter((e) => e.k === "status" && e.state === "failed") as Array<{ metaKeys: string[]; usage?: unknown }>;
    expect(failed.length).toBeGreaterThanOrEqual(1);
    for (const e of failed) {
      expect(e.metaKeys).not.toContain("x-usage");
      expect(e.usage).toBeUndefined();
    }
  });

  it("canceled event has no metadata[x-usage]", async () => {
    const session = new ManualSession();
    const provider = new CopilotProvider(makeConfig({ streaming: true }), { clientFactory: () => new ManualClient([session]) as never });
    const server = createProviderTestServer(provider);
    const live = server.startStream({ text: "hello", contextId: "c" });
    await new Promise((r) => setTimeout(r, 20));
    const taskId = (live.events[0] as any).payload.value.id as string;
    await server.cancel(taskId);
    const { events } = await live.done;

    const canceled = events.map(summarizeEvent).filter((e) => e.k === "status" && e.state === "canceled") as Array<{ metaKeys: string[] }>;
    expect(canceled.length).toBeGreaterThanOrEqual(1);
    for (const e of canceled) expect(e.metaKeys).not.toContain("x-usage");
  });

  it("only the final completed event carries x-usage; working / submitted events do not", async () => {
    const { summary } = await runTask({ streaming: true, usage: [usagePayload()] });
    for (const e of summary) {
      if (e.k === "status" && e.state !== "completed") expect(e.metaKeys).not.toContain("x-usage");
    }
  });
});

describe('10.5 non-streaming mode emits same metadata["x-usage"] shape as streaming', () => {
  it("non-streaming: final completed event has the same x-usage structure as streaming", async () => {
    const payload = usagePayload({ inputTokens: 100, outputTokens: 50, cost: 0 });
    const s = xUsageOf((await runTask({ streaming: true, usage: [payload] })).summary);
    const ns = xUsageOf((await runTask({ streaming: false, usage: [payload] })).summary);

    expect(s).toBeDefined();
    expect(ns).toBeDefined();
    expect(Object.keys(ns).sort()).toEqual(Object.keys(s).sort());
    expect(ns.llmCalls).toBe(s.llmCalls);
    expect(ns.inputTokens).toBe(s.inputTokens);
    expect(ns.outputTokens).toBe(s.outputTokens);
    expect(ns.cost).toBe(s.cost);
    expect(ns.calls).toHaveLength(s.calls.length);
  });

  it("non-streaming: x-usage present even with zero usage events (zero-call task)", async () => {
    const xUsage = xUsageOf((await runTask({ streaming: false, usage: [] })).summary);
    expect(xUsage.llmCalls).toBe(0);
    expect(xUsage.cost).toBeNull();
  });

  it("non-streaming: x-usage accumulates multiple usage events correctly", async () => {
    const xUsage = xUsageOf(
      (
        await runTask({
          streaming: false,
          usage: [usagePayload({ inputTokens: 50, outputTokens: 20, cost: null }), usagePayload({ inputTokens: 75, outputTokens: 30, cost: 0.005 })],
        })
      ).summary,
    );
    expect(xUsage.llmCalls).toBe(2);
    expect(xUsage.inputTokens).toBe(125);
    expect(xUsage.outputTokens).toBe(50);
    // First call cost:null, second cost:0.005 -> sum of non-null = 0.005
    expect(xUsage.cost).toBeCloseTo(0.005, 6);
  });

  it("non-streaming: unsubscribes usage handlers after sendAndWait completes", async () => {
    const r = await runTask({ streaming: false, usage: [usagePayload({ inputTokens: 42 })] });
    // After the task, another usage event must not be picked up (the listener was removed)
    expect(r.session.listenerCount("assistant.usage")).toBe(0);
    r.session.emit("assistant.usage", usagePayload({ inputTokens: 9999 }));
    const xUsage = xUsageOf(r.summary);
    expect(xUsage.inputTokens).toBe(42);
    expect(xUsage.llmCalls).toBe(1);
  });
});

describe("10.6 the same totals travel as core usage metadata", () => {
  it("the completed status carries urn:a2a-wrapper:usage:v1 next to x-usage, with a per-model breakdown", async () => {
    const r = await runTask({
      streaming: true,
      usage: [
        usagePayload({ model: "a", inputTokens: 100, outputTokens: 50, cost: 1 }),
        usagePayload({ model: "b", inputTokens: 20, outputTokens: 10, cost: null }),
      ],
    });
    const done = r.events.find((e: any) => e.payload.$case === "statusUpdate" && stateName(e.payload.value.status.state) === "completed");
    const meta = done.payload.value.metadata;
    expect(Object.keys(meta).sort()).toEqual(["urn:a2a-wrapper:usage:v1", "x-usage"]);
    const core = meta["urn:a2a-wrapper:usage:v1"];
    expect(core).toMatchObject({ scope: "delta", tokens: { input: 120, output: 60, total: 180 }, costUsd: 1 });
    expect(core.byModel).toMatchObject({ a: { input: 100, costUsd: 1 }, b: { input: 20, costUsd: null } });
    expect(core.model).toBeUndefined(); // an aggregate over models leaves `model` unset
  });
});
