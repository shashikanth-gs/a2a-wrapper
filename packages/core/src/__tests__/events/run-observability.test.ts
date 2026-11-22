import { describe, it, expect, vi } from "vitest";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import { A2ATransport, agentEventToTrace } from "../../events/transport.js";
import type { AgentEvent, EventType } from "../../events/transport.js";
import {
  RunObservability,
  RunTransport,
  X_USAGE_KEY,
  createResponseStream,
  usageSummaryToCoreUsage,
} from "../../events/run-observability.js";
import { TRACE_EXTENSION_URI } from "../../server/agent-card.js";
import { toArtifactUpdate } from "../../a2a/adapter.js";
import type { CoreArtifact, CoreRequest } from "../../model/index.js";
import type { UsageCallRecord } from "../../events/usage.js";

function fakeRun() {
  const artifacts: CoreArtifact[] = [];
  return { artifacts, artifact: (a: CoreArtifact) => void artifacts.push(a) };
}

const request: Pick<CoreRequest, "taskId" | "contextId" | "correlation"> = {
  taskId: "task-1",
  contextId: "ctx-1",
  correlation: { eventId: "e", parentAgentId: "parent-agent", trace: { traceId: "trace-7" }, metadata: { tenant: "acme" } },
};

const call = (over: Partial<UsageCallRecord> = {}): UsageCallRecord => ({
  model: "m1",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  reasoningTokens: 3,
  durationMs: 100,
  timeToFirstTokenMs: null,
  cost: null,
  apiEndpoint: null,
  initiator: null,
  ...over,
});

function observability(over: Partial<ConstructorParameters<typeof RunObservability>[0]> = {}) {
  const run = fakeRun();
  const obs = new RunObservability({ agentName: "Test Agent", backend: "fake", request, run, ...over });
  return { run, obs };
}

const lifecycle = (run: ReturnType<typeof fakeRun>) =>
  run.artifacts.filter((a) => a.name === "trace.lifecycle").map((a) => (a.parts[0] as any).data);

describe("RunTransport is the bus transport on a run", () => {
  const event = (eventType: EventType, data: Record<string, unknown> = {}): AgentEvent => ({
    eventId: "e1",
    eventType,
    agentId: "agent-1",
    agentName: "Agent One",
    traceId: "trace-1",
    parentAgentId: "p1",
    timestamp: "2026-01-01T00:00:00.000Z",
    data,
    otelTraceId: "ot",
    otelSpanId: "os",
  });

  it("renders every mapped event type as the artifact A2ATransport publishes (name, extension, metadata, data)", async () => {
    for (const type of ["tool_call_start", "tool_call_end", "thinking", "decision", "agent_started", "agent_finished", "agent_error", "background_tasks"] as EventType[]) {
      const events: any[] = [];
      const bus = { publish: (e: any) => events.push(e) } as unknown as ExecutionEventBus;
      const e = event(type, { backend: "x", n: 1 });
      await new A2ATransport(bus, "task-1", "ctx-1").send(e);
      const run = fakeRun();
      await new RunTransport(run).send(e);

      const fromBus = events[0].data.artifact;
      const viaRun = toArtifactUpdate("task-1", "ctx-1", run.artifacts[0]);
      expect(viaRun.artifact?.name).toBe(fromBus.name);
      expect(viaRun.artifact?.extensions).toEqual(fromBus.extensions);
      expect(viaRun.artifact?.extensions).toEqual([TRACE_EXTENSION_URI]);
      expect(viaRun.artifact?.metadata).toEqual(fromBus.metadata);
      expect(viaRun.artifact?.parts[0].content).toEqual(fromBus.parts[0].content);
      expect(viaRun.artifact?.parts[0].metadata).toEqual(fromBus.parts[0].metadata);
      expect(viaRun.append).toBe(events[0].data.append);
      expect(viaRun.lastChunk).toBe(events[0].data.lastChunk);
      expect(viaRun.artifact?.artifactId).toMatch(new RegExp(`^${fromBus.name.replace(/\./g, "\\.")}-`));
    }
  });

  it("drops an event type with no trace key, like the bus transport (context_window)", async () => {
    const run = fakeRun();
    await new RunTransport(run).send(event("context_window", { currentTokens: 1 }));
    expect(run.artifacts).toEqual([]);
    expect(agentEventToTrace(event("context_window"))).toBeUndefined();
  });
});

describe("RunObservability lifecycle and usage", () => {
  it("start() emits agent_started with the backend; finish() emits agent_finished with the usage summary and returns x-usage", async () => {
    const { run, obs } = observability();
    await obs.start();
    obs.recordCall(call());
    obs.recordCall(call({ inputTokens: 1, outputTokens: 1, cost: 2 }));
    const done = await obs.finish();

    const [started, finished] = lifecycle(run);
    expect(started).toMatchObject({ state: "started", backend: "fake", agent_name: "Test Agent", trace_id: "trace-7", parent_agent_id: "parent-agent" });
    expect(finished).toMatchObject({ state: "finished", backend: "fake" });
    expect(finished.usage).toEqual(done.summary);
    expect(done.summary).toMatchObject({ llmCalls: 2, inputTokens: 11, outputTokens: 6, cost: 2, model: "m1" });
    expect(done.meta).toEqual({ [X_USAGE_KEY]: done.summary });
    // no trace.usage artifacts unless trackUsage is on
    expect(run.artifacts.filter((a) => a.name === "trace.usage")).toEqual([]);
  });

  it("an event carries the propagated metadata of the request and the trace ids", async () => {
    const { run, obs } = observability();
    await obs.start();
    expect(lifecycle(run)[0].propagated_metadata).toEqual({ tenant: "acme" });
  });

  it("trackUsage publishes one trace.usage artifact per call (the call record as data) and drops context_window on the A2A transport", async () => {
    const { run, obs } = observability({ trackUsage: true });
    const c = call({ model: "m2" });
    obs.recordCall(c);
    obs.setContextWindow({ currentTokens: 5, tokenLimit: 10, conversationTokens: null, systemTokens: null, toolDefinitionsTokens: null, messagesLength: null });
    const usage = run.artifacts.filter((a) => a.name === "trace.usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ extensions: [TRACE_EXTENSION_URI], lastChunk: true, append: false });
    expect((usage[0].parts[0] as any).data).toEqual(c);
    expect((usage[0].parts[0] as any).meta).toEqual({ mimeType: "application/json" });
    expect(usage[0].meta).toMatchObject({ traceType: "trace.usage" });
    const done = await obs.finish();
    expect(done.summary?.contextWindow?.currentTokens).toBe(5);
  });

  it("with no calls finish() still returns a zero summary; error() reports usage null", async () => {
    const a = observability();
    const done = await a.obs.finish();
    expect(done.summary).toMatchObject({ llmCalls: 0, cost: null, model: null });
    expect(done.usage?.tokens).toMatchObject({ input: 0, output: 0, total: 0 });

    const b = observability();
    await b.obs.error("boom");
    expect(lifecycle(b.run)[0]).toMatchObject({ state: "error", message: "boom", usage: null, backend: "fake" });

    const c = observability();
    c.obs.recordCall(call());
    await c.obs.error("late");
    expect(lifecycle(c.run)[0].usage.llmCalls).toBe(1);
  });

  it("emits exactly one terminal lifecycle event per turn", async () => {
    const { run, obs } = observability();
    await obs.finish();
    await obs.error("after");
    await obs.canceled();
    expect(lifecycle(run)).toHaveLength(1);
    expect(lifecycle(run)[0].state).toBe("finished");
  });

  it("canceled() reports Task canceled through agent_error", async () => {
    const { run, obs } = observability();
    await obs.canceled();
    expect(lifecycle(run)[0]).toMatchObject({ state: "error", message: "Task canceled" });
  });

  it("a slow collector never stalls the terminal event past terminalTimeoutMs", async () => {
    const warn = vi.fn();
    const { obs } = observability({
      events: { enabled: true, transport: "a2a" },
      customTransport: () => new Promise<void>(() => {}), // never settles
      terminalTimeoutMs: 30,
      warn,
    });
    const t0 = Date.now();
    await obs.finish();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("slow"), expect.anything());
  });

  it("events disabled: nothing is published", async () => {
    const { run, obs } = observability({ events: { enabled: false } });
    await obs.start();
    await obs.finish();
    expect(run.artifacts).toEqual([]);
  });

  it("a custom transport receives the events instead of the run", async () => {
    const seen: AgentEvent[] = [];
    const { run, obs } = observability({ customTransport: async (e) => void seen.push(e) });
    await obs.start();
    await obs.finish();
    expect(seen.map((e) => e.eventType)).toEqual(["agent_started", "agent_finished"]);
    expect(run.artifacts).toEqual([]);
  });
});

describe("usageSummaryToCoreUsage", () => {
  it("sums counters, keeps a null cost null, and breaks usage down by model", () => {
    const { obs } = observability();
    obs.recordCall(call({ model: "a", inputTokens: 4, outputTokens: 1, cost: 1.5 }));
    obs.recordCall(call({ model: "b", inputTokens: 6, outputTokens: 2, cost: null }));
    obs.setContextWindow({ currentTokens: 7, tokenLimit: 100, conversationTokens: null, systemTokens: null, toolDefinitionsTokens: null, messagesLength: null });
    const u = usageSummaryToCoreUsage(obs.accumulator.summary());
    expect(u.scope).toBe("delta");
    expect(u.model).toBeUndefined(); // an aggregate leaves model unset
    expect(u.tokens).toMatchObject({ input: 10, output: 3, total: 13, cacheRead: 4, cacheWrite: 2, reasoning: 6 });
    expect(u.costUsd).toBe(1.5);
    expect(u.contextWindow).toEqual({ used: 7, limit: 100 });
    expect(u.byModel).toMatchObject({ a: { input: 4, costUsd: 1.5 }, b: { input: 6, costUsd: null } });
  });

  it("no calls: zero counters, null cost, no per-model entries", () => {
    const { obs } = observability();
    const u = usageSummaryToCoreUsage(obs.accumulator.summary());
    expect(u.costUsd).toBeNull();
    expect(u.byModel).toBeUndefined();
  });
});

describe("createResponseStream", () => {
  it("chunks: every delta appends to one `response-<uuid>` artifact and the last chunk carries the full text", () => {
    const run = fakeRun();
    const s = createResponseStream(run, { chunks: true });
    s.delta("Hel");
    s.delta("");
    s.delta("lo");
    s.finish("Hello");
    expect(run.artifacts.map((a) => [a.name, a.append, a.lastChunk, (a.parts[0] as any).text])).toEqual([
      ["response", true, false, "Hel"],
      ["response", true, false, "lo"],
      ["response", true, true, "Hello"],
    ]);
    expect(new Set(run.artifacts.map((a) => a.id)).size).toBe(1);
    expect(run.artifacts[0].id).toMatch(/^response-/);
  });

  it("a wrapper may name the artifact id", () => {
    const run = fakeRun();
    const s = createResponseStream(run, { chunks: true, id: "response-t1-2" });
    s.delta("x");
    s.finish("x");
    expect(s.id).toBe("response-t1-2");
    expect(run.artifacts.map((a) => a.id)).toEqual(["response-t1-2", "response-t1-2"]);
  });

  it("no chunks: nothing until finish, then one buffered artifact", () => {
    const run = fakeRun();
    const s = createResponseStream(run, { chunks: false });
    s.delta("ignored");
    expect(run.artifacts).toEqual([]);
    s.finish("Hello");
    expect(run.artifacts).toHaveLength(1);
    expect(run.artifacts[0]).toMatchObject({ name: "response", append: false, lastChunk: true });
    expect(run.artifacts[0].id).toMatch(/^response-/);
  });

  it("structured data is an additive JSON data part after the text; arrays and scalars are ignored", () => {
    const run = fakeRun();
    createResponseStream(run, { chunks: false }).finish("t", { a: 1 });
    expect(run.artifacts[0].parts).toEqual([
      { kind: "text", text: "t" },
      { kind: "data", data: { a: 1 }, meta: { mimeType: "application/json" } },
    ]);
    const r2 = fakeRun();
    createResponseStream(r2, { chunks: false }).finish("t", [1]);
    expect(r2.artifacts[0].parts).toHaveLength(1);
  });
});
