import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setOtelTracer,
  withSpan,
  resolveOtelEmissionPolicy,
  extractA2ATraceContext,
  instrumentExecutor,
  observeAgentEvent,
  runWithTaskOtelStore,
  applyUsageSummaryToActiveSpan,
  createExecutionObservability,
  type OtelTracerLike,
  type OtelSpanLike,
  type A2AExecutor,
  type UsageTelemetryData,
} from "../../index.js";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";

function fakeTracer() {
  const ended: string[] = [];
  const events: string[] = [];
  const attrs: Array<{ key: string; value: string | number | boolean }> = [];
  const spans: OtelSpanLike[] = [];
  const tracer: OtelTracerLike = {
    startSpan(name) {
      const span: OtelSpanLike = {
        setAttribute(key, value) {
          attrs.push({ key, value });
        },
        setStatus() {},
        recordException() {},
        addEvent(n) {
          events.push(n);
        },
        end() {
          ended.push(name);
        },
      };
      spans.push(span);
      return span;
    },
  };
  return { tracer, ended, events, spans, attrs };
}

describe("resolveOtelEmissionPolicy", () => {
  it("disables tool spans when backend copilot OTel is configured", () => {
    const p = resolveOtelEmissionPolicy({
      enabled: true,
      mirrorAgentEvents: true,
      backend: { copilot: { otlpEndpoint: "http://127.0.0.1:4318" } },
    });
    expect(p.enabled).toBe(true);
    expect(p.backendOtelOn).toBe(true);
    expect(p.emitToolSpans).toBe(false);
  });

  it("allows tool spans when backend OTel is off and mirror is on", () => {
    const p = resolveOtelEmissionPolicy({
      enabled: true,
      mirrorAgentEvents: true,
    });
    expect(p.emitToolSpans).toBe(true);
  });

  it("allows overlap only with explicit unsafe flag", () => {
    const p = resolveOtelEmissionPolicy({
      enabled: true,
      mirrorAgentEvents: true,
      emitOverlappingBackendSpans: true,
      backend: { claude: { enableTelemetry: true } },
    });
    expect(p.emitToolSpans).toBe(true);
    expect(p.emitGenAiUsageAttrs).toBe(true);
  });

  it("suppresses gen_ai.usage attrs on the task span when backend OTel is on", () => {
    const p = resolveOtelEmissionPolicy({
      enabled: true,
      backend: { copilot: { otlpEndpoint: "http://127.0.0.1:4318" } },
    });
    expect(p.emitGenAiUsageAttrs).toBe(false);
  });
});

describe("withSpan", () => {
  afterEach(() => setOtelTracer(undefined));

  it("is a no-op without a tracer", async () => {
    setOtelTracer(undefined);
    await expect(withSpan("x", {}, async () => 7)).resolves.toBe(7);
  });

  it("ends the span on success and on throw", async () => {
    const { tracer, ended } = fakeTracer();
    setOtelTracer(tracer);
    await withSpan("op", { a: 1 }, async () => "ok");
    expect(ended).toEqual(["op"]);
    await expect(
      withSpan("boom", {}, async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(ended).toEqual(["op", "boom"]);
  });
});

describe("extractA2ATraceContext", () => {
  it("reads trace_id and parent_agent_id from metadata", () => {
    const ctx = {
      taskId: "t1",
      contextId: "ctx-1",
      metadata: { trace_id: "orch-1", parent_agent_id: "parent-a" },
    } as unknown as RequestContext;
    const t = extractA2ATraceContext(ctx);
    expect(t.traceId).toBe("orch-1");
    expect(t.parentAgentId).toBe("parent-a");
  });

  it("falls back to contextId", () => {
    const ctx = { taskId: "t1", contextId: "ctx-99", metadata: {} } as unknown as RequestContext;
    expect(extractA2ATraceContext(ctx).traceId).toBe("ctx-99");
  });
});

describe("instrumentExecutor", () => {
  afterEach(() => setOtelTracer(undefined));

  it("wraps execute in a2a.task.execute when otel.enabled", async () => {
    const { tracer, ended } = fakeTracer();
    setOtelTracer(tracer);
    let ran = false;
    const inner: A2AExecutor = {
      async initialize() {},
      async shutdown() {},
      async execute() {
        ran = true;
      },
    };
    const ex = instrumentExecutor(inner, {
      otel: { enabled: true },
      agentName: "Example Agent",
      wrapperName: "a2a-copilot",
    });
    await ex.execute(
      { taskId: "t1", contextId: "c1" } as unknown as RequestContext,
      {} as ExecutionEventBus,
    );
    expect(ran).toBe(true);
    expect(ended).toEqual(["a2a.task.execute"]);
  });
});

describe("observeAgentEvent de-dupe", () => {
  beforeEach(() => setOtelTracer(undefined));
  afterEach(() => setOtelTracer(undefined));

  it("does not open tool spans when backend OTel is on", async () => {
    const { tracer, ended } = fakeTracer();
    setOtelTracer(tracer);
    const policy = resolveOtelEmissionPolicy({
      enabled: true,
      mirrorAgentEvents: true,
      backend: { copilot: { otlpEndpoint: "http://localhost:4318" } },
    });
    await runWithTaskOtelStore(
      {
        policy,
        taskId: "t",
        contextId: "c",
        agentId: "a",
        agentName: "A",
        toolSpans: new Map(),
        span: tracer.startSpan("task"),
      },
      async () => {
        observeAgentEvent("tool_call_start", { tool: "Read", callId: "1" });
        observeAgentEvent("tool_call_end", { tool: "Read", callId: "1" });
      },
    );
    // only the manual task span from the test setup — no a2a.mcp.tool
    expect(ended.filter((n) => n.startsWith("a2a.mcp.tool"))).toHaveLength(0);
  });

  it("opens tool spans for Antigravity-style fallback when mirror is on", async () => {
    const { tracer, ended } = fakeTracer();
    setOtelTracer(tracer);
    const policy = resolveOtelEmissionPolicy({
      enabled: true,
      mirrorAgentEvents: true,
    });
    await runWithTaskOtelStore(
      {
        policy,
        taskId: "t",
        contextId: "c",
        agentId: "a",
        agentName: "A",
        toolSpans: new Map(),
        span: tracer.startSpan("task"),
      },
      async () => {
        observeAgentEvent("tool_call_start", { tool: "Bash", callId: "9" });
        observeAgentEvent("tool_call_end", { tool: "Bash", callId: "9" });
      },
    );
    expect(ended).toContain("a2a.mcp.tool Bash");
  });
});

const sampleUsage: UsageTelemetryData = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  durationMs: 100,
  llmCalls: 1,
  model: "gpt-4.1",
  cost: 0.01,
  calls: [],
};

describe("applyUsageSummaryToActiveSpan", () => {
  afterEach(() => setOtelTracer(undefined));

  it("sets a2a.task.usage.* but not gen_ai.usage.* when backend OTel is on", async () => {
    const { tracer, attrs } = fakeTracer();
    setOtelTracer(tracer);
    const policy = resolveOtelEmissionPolicy({
      enabled: true,
      backend: { copilot: { otlpEndpoint: "http://127.0.0.1:4318" } },
    });
    await runWithTaskOtelStore(
      {
        policy,
        taskId: "t",
        contextId: "c",
        agentId: "a",
        agentName: "A",
        toolSpans: new Map(),
        span: tracer.startSpan("task"),
      },
      async () => {
        applyUsageSummaryToActiveSpan(sampleUsage);
      },
    );
    expect(attrs.some((a) => a.key === "a2a.task.usage.input_tokens" && a.value === 10)).toBe(true);
    expect(attrs.some((a) => a.key === "gen_ai.usage.input_tokens")).toBe(false);
  });

  it("sets gen_ai.usage.* when wrapper is the sole OTel source", async () => {
    const { tracer, attrs } = fakeTracer();
    setOtelTracer(tracer);
    const policy = resolveOtelEmissionPolicy({ enabled: true });
    await runWithTaskOtelStore(
      {
        policy,
        taskId: "t",
        contextId: "c",
        agentId: "a",
        agentName: "A",
        toolSpans: new Map(),
        span: tracer.startSpan("task"),
      },
      async () => {
        applyUsageSummaryToActiveSpan(sampleUsage);
      },
    );
    expect(attrs.some((a) => a.key === "gen_ai.usage.input_tokens" && a.value === 10)).toBe(true);
    expect(attrs.some((a) => a.key === "gen_ai.usage.output_tokens" && a.value === 5)).toBe(true);
  });
});

describe("createExecutionObservability", () => {
  it("builds an emitter with orchestrator trace id and parent agent", () => {
    const bus = { publish: () => {} } as unknown as ExecutionEventBus;
    const ctx = {
      taskId: "t1",
      contextId: "c1",
      metadata: { trace_id: "orch-99", parent_agent_id: "parent-x" },
    } as unknown as RequestContext;
    const { emitter, agentId, traceContext } = createExecutionObservability({
      agentName: "My Agent",
      ctx,
      bus,
    });
    expect(agentId).toBe("my-agent");
    expect(traceContext.traceId).toBe("orch-99");
    expect(traceContext.parentAgentId).toBe("parent-x");
    expect(emitter.traceId).toBe("orch-99");
    expect(emitter.parentAgentId).toBe("parent-x");
  });
});
