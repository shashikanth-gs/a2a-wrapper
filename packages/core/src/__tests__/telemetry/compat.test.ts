/**
 * Opt-in platform compat attributes (`otel.compat`): Langfuse and Phoenix
 * (OpenInference). Standard attributes must be identical with and without them.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import {
  setOtelTracer,
  instrumentExecutor,
  resolveCompat,
  compatRequestAttributes,
  compatToolAttributes,
  resolveOtelEmissionPolicy,
  runWithTaskOtelStore,
  observeAgentEvent,
  type A2AExecutor,
  type OtelTracerLike,
  type OtelSpanLike,
} from "../../index.js";

afterEach(() => {
  setOtelTracer(undefined);
  delete process.env["A2A_OTEL_COMPAT"];
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
function ctx(meta: Record<string, unknown> = {}): RequestContext {
  return {
    taskId: `compat-task-${++seq}`,
    contextId: "ctx",
    userMessage: { messageId: "m", role: 1, parts: [], metadata: meta },
    task: undefined,
    context: { state: new Map() },
  } as unknown as RequestContext;
}
const executor: A2AExecutor = { initialize: async () => {}, shutdown: async () => {}, execute: async () => {} };

async function requestAttrs(otel: Record<string, unknown>, meta: Record<string, unknown> = {}) {
  const { tracer, spans } = fakeTracer();
  setOtelTracer(tracer);
  await instrumentExecutor(executor, { otel: { enabled: true, ...otel } as never, agentName: "My Agent" }).execute(ctx(meta), {} as ExecutionEventBus);
  return spans.find((s) => s.name === "a2a.task.execute")!.attributes;
}

const PLATFORM_KEYS = /^(langfuse\.|openinference\.|graph\.node\.|agent\.name$|tool\.name$)/;

describe("resolveCompat", () => {
  it("defaults to none", () => {
    expect(resolveCompat({}, {})).toEqual([]);
    expect(resolveCompat(undefined, {})).toEqual([]);
  });
  it("reads the JSON list, deduplicated and case-insensitive", () => {
    expect(resolveCompat({ compat: ["langfuse", "OpenInference", "langfuse"] }, {})).toEqual(["langfuse", "openinference"]);
  });
  it("environment overrides JSON; 'none' clears", () => {
    expect(resolveCompat({ compat: ["langfuse"] }, { A2A_OTEL_COMPAT: "openinference" })).toEqual(["openinference"]);
    expect(resolveCompat({ compat: ["langfuse"] }, { A2A_OTEL_COMPAT: "none" })).toEqual([]);
    expect(resolveCompat({ compat: ["langfuse"] }, { A2A_OTEL_COMPAT: "" })).toEqual(["langfuse"]);
    expect(resolveCompat({}, { A2A_OTEL_COMPAT: "langfuse, openinference" })).toEqual(["langfuse", "openinference"]);
  });
  it("warns about and skips unknown names", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveCompat({ compat: ["langfuse", "datadog", 7 as never] }, {})).toEqual(["langfuse"]);
    expect(warn).toHaveBeenCalled();
  });
  it("tolerates a non-array value", () => {
    expect(resolveCompat({ compat: "langfuse" as never }, {})).toEqual([]);
  });
});

describe("attribute builders", () => {
  const info = { agentId: "my-agent", agentName: "My Agent" };
  it("adds nothing when no mode is selected", () => {
    expect(compatRequestAttributes([], info)).toEqual({});
    expect(compatRequestAttributes(undefined, info)).toEqual({});
    expect(compatToolAttributes([], "t")).toEqual({});
  });
  it("langfuse: observation type only", () => {
    expect(compatRequestAttributes(["langfuse"], info)).toEqual({ "langfuse.observation.type": "agent" });
    expect(compatToolAttributes(["langfuse"], "t")).toEqual({ "langfuse.observation.type": "tool" });
  });
  it("openinference: AGENT kind, agent.name, graph node (no parent edge without a parent)", () => {
    expect(compatRequestAttributes(["openinference"], info)).toEqual({
      "openinference.span.kind": "AGENT", "agent.name": "My Agent", "graph.node.id": "my-agent", "graph.node.name": "My Agent",
    });
  });
  it("openinference: adds the parent edge only when a parent agent is known", () => {
    expect(compatRequestAttributes(["openinference"], { ...info, parentAgentId: "orchestrator" })["graph.node.parent_id"]).toBe("orchestrator");
    expect(compatRequestAttributes(["openinference"], { ...info, parentAgentId: null })).not.toHaveProperty("graph.node.parent_id");
  });
  it("openinference tool span", () => {
    expect(compatToolAttributes(["openinference"], "search")).toEqual({ "openinference.span.kind": "TOOL", "tool.name": "search" });
  });
  it("both modes combine without clobbering each other", () => {
    const a = compatRequestAttributes(["langfuse", "openinference"], info);
    expect(a["langfuse.observation.type"]).toBe("agent");
    expect(a["openinference.span.kind"]).toBe("AGENT");
  });
  it("never emits content or token attributes", () => {
    const keys = Object.keys(compatRequestAttributes(["langfuse", "openinference"], { ...info, parentAgentId: "p" })).concat(
      Object.keys(compatToolAttributes(["langfuse", "openinference"], "t")),
    );
    for (const k of keys) expect(k).not.toMatch(/input|output|token_count|llm\./);
  });
});

describe("request span", () => {
  it("with no compat the attribute set is unchanged (nothing platform-specific appears)", async () => {
    const attrs = await requestAttrs({}, { parent_agent_id: "orchestrator" });
    expect(Object.keys(attrs).filter((k) => PLATFORM_KEYS.test(k))).toEqual([]);
  });

  it("standard attributes are identical with and without compat", async () => {
    const without = await requestAttrs({}, { parent_agent_id: "p" });
    const withBoth = await requestAttrs({ compat: ["langfuse", "openinference"] }, { parent_agent_id: "p" });
    const stripped = Object.fromEntries(Object.entries(withBoth).filter(([k]) => !PLATFORM_KEYS.test(k)));
    // task ids differ per call; compare the keys and the stable values
    expect(Object.keys(stripped).sort()).toEqual(Object.keys(without).sort());
    for (const k of Object.keys(without)) if (!/task\.id|message/.test(k)) expect(stripped[k]).toEqual(without[k]);
  });

  it("langfuse typing and openinference graph attributes land on the request span", async () => {
    const attrs = await requestAttrs({ compat: ["langfuse", "openinference"] }, { parent_agent_id: "orchestrator" });
    expect(attrs).toMatchObject({
      "langfuse.observation.type": "agent",
      "openinference.span.kind": "AGENT",
      "agent.name": "My Agent",
      "graph.node.id": "my-agent",
      "graph.node.name": "My Agent",
      "graph.node.parent_id": "orchestrator",
    });
  });

  it("no parent edge for a root agent", async () => {
    const attrs = await requestAttrs({ compat: ["openinference"] });
    expect(attrs).not.toHaveProperty("graph.node.parent_id");
  });

  it("A2A_OTEL_COMPAT enables it without config", async () => {
    process.env["A2A_OTEL_COMPAT"] = "langfuse";
    // policy is resolved per instrumentExecutor call, so set the env first
    expect(await requestAttrs({})).toMatchObject({ "langfuse.observation.type": "agent" });
  });

  it("does nothing when OTel is disabled", () => {
    expect(resolveOtelEmissionPolicy({ enabled: false, compat: ["langfuse"] } as never).compat).toEqual([]);
  });
});

describe("mirrored tool spans", () => {
  async function toolAttrs(compat: string[] | undefined) {
    const { tracer, spans } = fakeTracer();
    setOtelTracer(tracer);
    const policy = resolveOtelEmissionPolicy({ enabled: true, mirrorAgentEvents: true, ...(compat ? { compat } : {}) } as never);
    const span = tracer.startSpan("task", {});
    const store = { span, policy, taskId: "t", contextId: "c", agentId: "a", agentName: "A", toolSpans: new Map() };
    await runWithTaskOtelStore(store as never, async () => observeAgentEvent("tool_call_start", { tool: "search" }));
    return spans.find((s) => s.name.startsWith("a2a.mcp.tool"))!.attributes;
  }

  it("types the tool span for both platforms", async () => {
    expect(await toolAttrs(["langfuse", "openinference"])).toMatchObject({
      "langfuse.observation.type": "tool", "openinference.span.kind": "TOOL", "tool.name": "search", "gen_ai.tool.name": "search",
    });
  });
  it("adds nothing without compat", async () => {
    const attrs = await toolAttrs(undefined);
    expect(Object.keys(attrs).filter((k) => PLATFORM_KEYS.test(k))).toEqual([]);
    expect(attrs["gen_ai.tool.name"]).toBe("search");
  });
});
