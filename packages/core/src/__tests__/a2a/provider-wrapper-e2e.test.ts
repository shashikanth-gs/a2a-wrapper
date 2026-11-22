/**
 * What a wrapper built on the provider contract publishes, through the REAL SDK `DefaultRequestHandler`, against what a
 * bus-based wrapper publishes today (`publishStatus`, `publishLastChunkMarker`, `AgentEventEmitter` over `A2ATransport`):
 * the same artifacts (name, flags, extension, parts), the same `x-usage`, the same lifecycle trace. This is the
 * parity the wrapper migration depends on (design doc 3.14).
 */

import { describe, it, expect } from "vitest";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import {
  AgentEventEmitter,
  A2ATransport,
  LlmUsageAccumulator,
  RunObservability,
  createProviderTestServer,
  createResponseStream,
  publishFinalArtifact,
  publishLastChunkMarker,
  publishStatus,
  publishStreamingChunk,
  publishTask,
  publishTraceArtifact,
  summarizeEvent,
  summarizeTask,
  type CoreRequest,
  type CoreTaskRun,
  type ProviderExecutor,
  type UsageCallRecord,
} from "../../index.js";

const call = (over: Partial<UsageCallRecord> = {}): UsageCallRecord => ({
  model: "m1",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  durationMs: 7,
  timeToFirstTokenMs: null,
  cost: null,
  apiEndpoint: null,
  initiator: null,
  ...over,
});

interface Script {
  chunks: boolean;
  trackUsage: boolean;
}

/** The sequence a bus-based wrapper publishes for one successful turn that streams text and records two calls. */
async function legacy(bus: ExecutionEventBus, ids: { taskId: string; contextId: string }, s: Script): Promise<void> {
  const { taskId, contextId } = ids;
  const emitter = new AgentEventEmitter({
    agentId: "test-agent",
    agentName: "Test Agent",
    traceId: contextId,
    transport: new A2ATransport(bus, taskId, contextId),
  });
  const acc = new LlmUsageAccumulator();
  publishTask(bus, taskId, contextId);
  publishStatus(bus, taskId, contextId, "submitted");
  publishStatus(bus, taskId, contextId, "working", "Processing request...");
  await emitter.emit("agent_started", { backend: "fake" });
  publishStatus(bus, taskId, contextId, "working", "Executing tool...");
  for (const c of [call(), call({ inputTokens: 1, cost: 0.5 })]) {
    acc.record(c);
    if (s.trackUsage) publishTraceArtifact(bus, taskId, contextId, "trace.usage", c as unknown as Record<string, unknown>);
  }
  const id = "response-x";
  if (s.chunks) {
    publishStreamingChunk(bus, taskId, contextId, id, "Hello ");
    publishStreamingChunk(bus, taskId, contextId, id, "world");
    publishLastChunkMarker(bus, taskId, contextId, id, "Hello world");
  } else {
    publishFinalArtifact(bus, taskId, contextId, "Hello world");
  }
  const summary = acc.summary();
  await emitter.emit("agent_finished", { backend: "fake", usage: summary });
  publishStatus(bus, taskId, contextId, "completed", undefined, true, { "x-usage": summary });
}

function provider(s: Script): ProviderExecutor {
  return {
    info: () => ({ id: "fake", displayName: "Fake", inputModes: ["text/plain"], outputModes: ["text/plain"] }),
    initialize: async () => {},
    shutdown: async () => {},
    async run(req: CoreRequest, run: CoreTaskRun) {
      const obs = new RunObservability({ agentName: "Test Agent", backend: "fake", request: req, run, trackUsage: s.trackUsage });
      run.progress("Processing request...");
      await obs.start();
      run.progress("Executing tool...");
      obs.recordCall(call());
      obs.recordCall(call({ inputTokens: 1, cost: 0.5 }));
      const response = createResponseStream(run, { chunks: s.chunks });
      response.delta("Hello ");
      response.delta("world");
      response.finish("Hello world");
      const done = await obs.finish();
      run.complete({ ...(done.usage ? { usage: done.usage } : {}), meta: done.meta });
    },
  };
}

/** Normalise what varies per run: nothing in the summaries is an id or a timestamp; the summary of x-usage is exact. */
async function bothWays(s: Script) {
  const bus = { events: [] as any[], publish(e: any) { this.events.push(e); }, finished() {} };
  await legacy(bus as unknown as ExecutionEventBus, { taskId: "t", contextId: "c" }, s);
  const old = bus.events.map(summarizeEvent);

  const server = createProviderTestServer(provider(s));
  const { events, error } = await server.stream({ text: "hi", contextId: "c" });
  expect(error).toBeUndefined();
  return { old, fresh: events.map(summarizeEvent), server };
}

describe("provider wrapper output equals bus wrapper output", () => {
  for (const chunks of [false, true]) {
    for (const trackUsage of [false, true]) {
      it(`chunks=${chunks} trackUsage=${trackUsage}: same events in the same order (the redundant 'submitted' status is the one difference)`, async () => {
        const { old, fresh } = await bothWays({ chunks, trackUsage });
        const withoutSubmitted = old.filter((e) => !(e.k === "status" && e.state === "submitted"));
        // random ids differ per run; everything else must match exactly
        const noIds = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === "event_id" ? "<id>" : x)));
        const stripNew = (list: any[]) =>
          list.map((e) => {
            if (e.k !== "status") return noIds(e);
            // the provider path additionally carries the core usage key next to x-usage on the completed status
            const { metaKeys, ...rest } = e;
            return noIds({ ...rest, metaKeys: metaKeys.filter((k: string) => k !== "urn:a2a-wrapper:usage:v1") });
          });
        expect(stripNew(fresh)).toEqual(stripNew(withoutSubmitted));
        // the completed status has both: the legacy x-usage and core's usage key
        const completed = fresh.at(-1)!;
        expect(completed).toMatchObject({ k: "status", state: "completed" });
        expect((completed as any).metaKeys).toEqual(["urn:a2a-wrapper:usage:v1", "x-usage"]);
        expect((completed as any).usage.llmCalls).toBe(2);
      });
    }
  }

  it("a blocking send returns the completed task with the response artifact", async () => {
    const server = createProviderTestServer(provider({ chunks: false, trackUsage: false }));
    const task = summarizeTask(await server.send({ text: "hi" }));
    expect(task.state).toBe("completed");
    expect(task.artifacts.find((a) => a.name === "response")?.text).toBe("Hello world");
  });
});
