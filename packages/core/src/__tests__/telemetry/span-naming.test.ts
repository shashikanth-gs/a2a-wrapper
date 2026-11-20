/** `otel.spanNaming`: legacy (default) vs OpenTelemetry GenAI names. */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import {
  setOtelTracer,
  instrumentExecutor,
  resolveSpanNaming,
  requestSpanName,
  toolSpanName,
  resolveOtelEmissionPolicy,
  runWithTaskOtelStore,
  observeAgentEvent,
  type A2AExecutor,
  type OtelTracerLike,
  type OtelSpanLike,
} from "../../index.js";

afterEach(() => {
  setOtelTracer(undefined);
  delete process.env["A2A_OTEL_SPAN_NAMING"];
  vi.restoreAllMocks();
});

function fakeTracer() {
  const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
  const tracer: OtelTracerLike = {
    startSpan(name, options) {
      spans.push({ name, attributes: { ...(options?.attributes ?? {}) } });
      const span: OtelSpanLike = { setAttribute() {}, end() {}, spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }) };
      return span;
    },
  };
  return { tracer, spans };
}

let seq = 0;
const ctx = (): RequestContext =>
  ({ taskId: `naming-${++seq}`, contextId: "c", userMessage: { messageId: "m", role: 1, parts: [] }, task: undefined, context: { state: new Map() } }) as unknown as RequestContext;
const executor: A2AExecutor = { initialize: async () => {}, shutdown: async () => {}, execute: async () => {} };

async function run(otel: Record<string, unknown>) {
  const { tracer, spans } = fakeTracer();
  setOtelTracer(tracer);
  await instrumentExecutor(executor, { otel: { enabled: true, ...otel } as never, agentName: "My Agent" }).execute(ctx(), {} as ExecutionEventBus);
  return spans;
}

describe("resolveSpanNaming", () => {
  it("defaults to legacy", () => {
    expect(resolveSpanNaming({}, {})).toBe("legacy");
    expect(resolveSpanNaming(undefined, {})).toBe("legacy");
  });
  it("reads the JSON value and the environment overrides it", () => {
    expect(resolveSpanNaming({ spanNaming: "semconv" }, {})).toBe("semconv");
    expect(resolveSpanNaming({ spanNaming: "semconv" }, { A2A_OTEL_SPAN_NAMING: "LEGACY" })).toBe("legacy");
    expect(resolveSpanNaming({}, { A2A_OTEL_SPAN_NAMING: " semconv " })).toBe("semconv");
  });
  it("warns and falls back to legacy for an invalid value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveSpanNaming({ spanNaming: "weird" }, {})).toBe("legacy");
    expect(warn).toHaveBeenCalled();
  });
});

describe("name builders", () => {
  it("legacy and semconv", () => {
    expect(requestSpanName("legacy", "My Agent")).toBe("a2a.task.execute");
    expect(requestSpanName(undefined, "My Agent")).toBe("a2a.task.execute");
    expect(requestSpanName("semconv", "My Agent")).toBe("invoke_agent My Agent");
    expect(toolSpanName("legacy", "search")).toBe("a2a.mcp.tool search");
    expect(toolSpanName("semconv", "search")).toBe("execute_tool search");
  });
});

describe("request span", () => {
  it("default name is unchanged", async () => {
    expect((await run({})).map((s) => s.name)).toEqual(["a2a.task.execute"]);
  });
  it("semconv renames the request span", async () => {
    expect((await run({ spanNaming: "semconv" })).map((s) => s.name)).toEqual(["invoke_agent My Agent"]);
  });
  it("only the name changes: attributes are identical in both modes", async () => {
    const strip = (a: Record<string, unknown>) => Object.fromEntries(Object.entries(a).filter(([k]) => !/task\.id|message/.test(k)));
    const [legacy] = await run({});
    const [semconv] = await run({ spanNaming: "semconv" });
    expect(strip(semconv!.attributes)).toEqual(strip(legacy!.attributes));
    expect(semconv!.attributes["gen_ai.operation.name"]).toBe("invoke_agent");
  });
  it("A2A_OTEL_SPAN_NAMING selects it without config", async () => {
    process.env["A2A_OTEL_SPAN_NAMING"] = "semconv";
    expect((await run({})).map((s) => s.name)).toEqual(["invoke_agent My Agent"]);
  });
  it("the cancel span is never renamed", async () => {
    const { tracer, spans } = fakeTracer();
    setOtelTracer(tracer);
    const cancellable: A2AExecutor = { ...executor, cancelTask: async () => {} };
    await instrumentExecutor(cancellable, { otel: { enabled: true, spanNaming: "semconv" } as never, agentName: "A" }).cancelTask!("t", {} as ExecutionEventBus);
    expect(spans.map((s) => s.name)).toEqual(["a2a.task.cancel"]);
  });
});

describe("mirrored tool spans", () => {
  async function toolSpanNames(spanNaming?: string) {
    const { tracer, spans } = fakeTracer();
    setOtelTracer(tracer);
    const policy = resolveOtelEmissionPolicy({ enabled: true, mirrorAgentEvents: true, ...(spanNaming ? { spanNaming } : {}) } as never);
    const store = { span: tracer.startSpan("task", {}), policy, taskId: "t", contextId: "c", agentId: "a", agentName: "A", toolSpans: new Map() };
    await runWithTaskOtelStore(store as never, async () => observeAgentEvent("tool_call_start", { tool: "search" }));
    return spans.slice(1).map((s) => s.name);
  }
  it("legacy", async () => expect(await toolSpanNames()).toEqual(["a2a.mcp.tool search"]));
  it("semconv", async () => expect(await toolSpanNames("semconv")).toEqual(["execute_tool search"]));
});
