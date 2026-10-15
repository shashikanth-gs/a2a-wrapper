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
  applyUsageCallToActiveSpan,
  createExecutionObservability,
  buildCopilotTelemetryOptions,
  shouldPropagateCopilotTraceContext,
  buildClaudeOtelEnv,
  mergeCodexOtelOverrides,
  getCorePackageVersion,
  buildTaskSpanAttributes,
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
  const linksSeen: number[] = [];
  let spanSeq = 0;
  const tracer: OtelTracerLike = {
    startSpan(name, options) {
      if (options?.attributes) {
        for (const [key, value] of Object.entries(options.attributes)) {
          attrs.push({ key, value });
        }
      }
      linksSeen.push(options?.links?.length ?? 0);
      spanSeq += 1;
      const id = spanSeq;
      const span: OtelSpanLike = {
        setAttribute(key, value) {
          attrs.push({ key, value });
        },
        setStatus() {},
        recordException() {},
        addEvent(n) {
          events.push(n);
        },
        spanContext() {
          return {
            traceId: `trace-${id}`,
            spanId: `span-${id}`,
            traceFlags: 1,
          };
        },
        end() {
          ended.push(name);
        },
      };
      spans.push(span);
      return span;
    },
  };
  return { tracer, ended, events, spans, attrs, linksSeen };
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

  it("defaults taskUsageRollup on and annotateUsageCalls off", () => {
    const p = resolveOtelEmissionPolicy({ enabled: true });
    expect(p.emitTaskUsageRollup).toBe(true);
    expect(p.annotateUsageCalls).toBe(false);
  });

  it("honors taskUsageRollup: false and annotateUsageCalls: true", () => {
    const off = resolveOtelEmissionPolicy({ enabled: true, taskUsageRollup: false });
    expect(off.emitTaskUsageRollup).toBe(false);
    const on = resolveOtelEmissionPolicy({ enabled: true, annotateUsageCalls: true });
    expect(on.annotateUsageCalls).toBe(true);
    const blocked = resolveOtelEmissionPolicy({
      enabled: true,
      annotateUsageCalls: true,
      backend: { claude: { enableTelemetry: true } },
    });
    // Per-call events only when wrapper is sole GenAI usage source.
    expect(blocked.annotateUsageCalls).toBe(false);
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
    expect(t.conversationId).toBe("ctx-1");
  });

  it("falls back to contextId", () => {
    const ctx = { taskId: "t1", contextId: "ctx-99", metadata: {} } as unknown as RequestContext;
    expect(extractA2ATraceContext(ctx).traceId).toBe("ctx-99");
    expect(extractA2ATraceContext(ctx).conversationId).toBe("ctx-99");
  });

  it("maps gateway conversation / session / passkey / spectrum ids", () => {
    const ctx = {
      taskId: "t1",
      contextId: "ctx-1",
      metadata: {
        conversation_id: "conv-gateway",
        session_id: "sess-ux",
        passkey: "pk-9",
        spectrum_id: "sp-1",
        ticket_id: "tkt-2",
      },
    } as unknown as RequestContext;
    const t = extractA2ATraceContext(ctx);
    expect(t.conversationId).toBe("conv-gateway");
    expect(t.sessionId).toBe("sess-ux");
    expect(t.gateway.passkey).toBe("pk-9");
    expect(t.gateway.spectrumId).toBe("sp-1");
    expect(t.gateway.ticketId).toBe("tkt-2");
  });
});

describe("wrapper package identity attrs", () => {
  it("stamps core + sdk versions on task spans", () => {
    const attrs = buildTaskSpanAttributes({
      taskId: "t",
      contextId: "c",
      agentName: "Example",
      wrapperName: "a2a-claude",
      wrapperVersion: "0.4.1",
    });
    expect(attrs["a2a.wrapper.core.version"]).toBe(getCorePackageVersion());
    expect(attrs["a2a.wrapper.sdk"]).toBe("a2a-claude");
    expect(attrs["a2a.wrapper.sdk.version"]).toBe("0.4.1");
    expect(attrs["a2a.wrapper.name"]).toBe("a2a-claude");
    expect(attrs["a2a.wrapper.version"]).toBe("0.4.1");
    expect(getCorePackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("instrumentExecutor", () => {
  afterEach(() => setOtelTracer(undefined));

  it("wraps execute in a2a.task.execute when otel.enabled", async () => {
    const { tracer, ended, attrs } = fakeTracer();
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
      wrapperVersion: "1.8.2",
    });
    await ex.execute(
      {
        taskId: `t-single-${Date.now()}`,
        contextId: "c1",
        userMessage: { messageId: "m-1" },
      } as unknown as RequestContext,
      {} as ExecutionEventBus,
    );
    expect(ran).toBe(true);
    expect(ended).toEqual(["a2a.task.execute"]);
    expect(attrs.some((a) => a.key === "a2a.wrapper.sdk" && a.value === "a2a-copilot")).toBe(true);
    expect(attrs.some((a) => a.key === "a2a.wrapper.sdk.version" && a.value === "1.8.2")).toBe(true);
    expect(attrs.some((a) => a.key === "a2a.wrapper.core.version")).toBe(true);
  });

  it("marks continue vs retry on re-entry (still one span per request)", async () => {
    const { tracer, ended, attrs, linksSeen } = fakeTracer();
    setOtelTracer(tracer);
    const inner: A2AExecutor = {
      async initialize() {},
      async shutdown() {},
      async execute() {},
    };
    const ex = instrumentExecutor(inner, {
      otel: { enabled: true },
      agentName: "Example Agent",
    });
    const taskId = `t-reentry-${Date.now()}-${Math.random()}`;
    const bus = {} as ExecutionEventBus;

    await ex.execute(
      { taskId, contextId: "conv-1", userMessage: { messageId: "m1" } } as unknown as RequestContext,
      bus,
    );
    await ex.execute(
      {
        taskId,
        contextId: "conv-1",
        task: { id: taskId },
        userMessage: { messageId: "m2" },
      } as unknown as RequestContext,
      bus,
    );
    await ex.execute(
      { taskId, contextId: "conv-1", userMessage: { messageId: "m3" } } as unknown as RequestContext,
      bus,
    );

    expect(ended).toEqual(["a2a.task.execute", "a2a.task.execute", "a2a.task.execute"]);
    const kinds = attrs.filter((a) => a.key === "a2a.task.invocation_kind").map((a) => a.value);
    expect(kinds).toEqual(["new", "continue", "retry"]);
    expect(attrs.some((a) => a.key === "a2a.message.id" && a.value === "m2")).toBe(true);
    expect(attrs.some((a) => a.key === "gen_ai.conversation.id" && a.value === "conv-1")).toBe(true);
    // First attempt: no link; continue/retry link to prior span context.
    expect(linksSeen).toEqual([0, 1, 1]);
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

  it("skips rollup attrs when taskUsageRollup is false", async () => {
    const { tracer, attrs } = fakeTracer();
    setOtelTracer(tracer);
    const policy = resolveOtelEmissionPolicy({ enabled: true, taskUsageRollup: false });
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
    expect(attrs.some((a) => a.key.startsWith("a2a.task.usage."))).toBe(false);
  });

  it("emits a2a.llm.call events only when annotateUsageCalls is on", async () => {
    const { tracer, events } = fakeTracer();
    setOtelTracer(tracer);
    const off = resolveOtelEmissionPolicy({ enabled: true });
    await runWithTaskOtelStore(
      {
        policy: off,
        taskId: "t",
        contextId: "c",
        agentId: "a",
        agentName: "A",
        toolSpans: new Map(),
        span: tracer.startSpan("task"),
      },
      async () => {
        applyUsageCallToActiveSpan({
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          durationMs: 1,
          timeToFirstTokenMs: null,
          cost: null,
          apiEndpoint: null,
          initiator: "claude",
        });
      },
    );
    expect(events).not.toContain("a2a.llm.call");

    const on = resolveOtelEmissionPolicy({ enabled: true, annotateUsageCalls: true });
    await runWithTaskOtelStore(
      {
        policy: on,
        taskId: "t",
        contextId: "c",
        agentId: "a",
        agentName: "A",
        toolSpans: new Map(),
        span: tracer.startSpan("task2"),
      },
      async () => {
        applyUsageCallToActiveSpan({
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          durationMs: 1,
          timeToFirstTokenMs: null,
          cost: null,
          apiEndpoint: null,
          initiator: "claude",
        });
      },
    );
    expect(events).toContain("a2a.llm.call");
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

describe("Hook F backend passthrough helpers", () => {
  it("builds Copilot telemetry from backend.copilot + shared exporter", () => {
    const t = buildCopilotTelemetryOptions({
      enabled: true,
      exporter: { endpoint: "http://127.0.0.1:4318" },
      backend: { copilot: { propagateTraceContext: true } },
    });
    expect(t?.otlpEndpoint).toBe("http://127.0.0.1:4318");
    expect(t?.exporterType).toBe("otlp-http");
    expect(shouldPropagateCopilotTraceContext({
      backend: { copilot: { otlpEndpoint: "http://x:4318" } },
    })).toBe(true);
  });

  it("returns undefined Copilot telemetry when backend.copilot is absent", () => {
    expect(buildCopilotTelemetryOptions({ enabled: true })).toBeUndefined();
    expect(shouldPropagateCopilotTraceContext({ enabled: true })).toBe(false);
  });

  it("merges Claude OTel env when enableTelemetry is set", () => {
    const env = buildClaudeOtelEnv(
      {
        enabled: true,
        serviceName: "a2a-claude",
        exporter: { endpoint: "http://127.0.0.1:4318", protocol: "http/protobuf" },
        backend: { claude: { enableTelemetry: true } },
      },
      { KEEP: "1" },
    );
    expect(env?.["CLAUDE_CODE_ENABLE_TELEMETRY"]).toBe("1");
    expect(env?.["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe("http://127.0.0.1:4318");
    expect(env?.["KEEP"]).toBe("1");
  });

  it("merges Codex otel overrides under configOverrides.otel", () => {
    const merged = mergeCodexOtelOverrides(
      {
        exporter: { endpoint: "http://127.0.0.1:4318" },
        backend: { codex: { environment: "test" } },
      },
      { model: "o3" },
    );
    expect(merged?.model).toBe("o3");
    expect((merged?.otel as Record<string, unknown>).endpoint).toBe("http://127.0.0.1:4318");
    expect((merged?.otel as Record<string, unknown>).exporter).toBe("otlp");
    expect((merged?.otel as Record<string, unknown>).environment).toBe("test");
  });
});
