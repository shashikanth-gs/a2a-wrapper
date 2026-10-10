/**
 * OpenTelemetry configuration and emission policy types.
 *
 * `@a2a-wrapper/core` only peers on `@opentelemetry/api` (optional).
 * Exporters / the SDK belong to the host application or wrapper CLI.
 *
 * @module telemetry/types
 */

/**
 * Optional OpenTelemetry settings on an agent config.
 *
 * When omitted or `enabled: false`, core instrumentation is a no-op unless a
 * host has already registered a tracer via {@link setOtelTracer}.
 */
export interface OtelConfig {
  /**
   * Master switch for wrapper-owned OTel instrumentation.
   * @default false
   */
  enabled?: boolean;

  /**
   * Service name resource attribute for wrapper spans.
   * @default derived from agent card / wrapper name
   */
  serviceName?: string;

  /**
   * Instrumentation scope name passed to `getTracer`.
   * @default "a2a-wrapper"
   */
  tracerName?: string;

  /**
   * When true, map `AgentEvent` tool calls into wrapper OTel child spans.
   * Defaults to false. Forced off when a backend OTel block is present unless
   * {@link emitOverlappingBackendSpans} is true.
   * @default false
   */
  mirrorAgentEvents?: boolean;

  /**
   * Unsafe escape hatch: allow wrapper tool/LLM spans even when backend OTel
   * is configured (duplicates Copilot/Claude tool spans in the collector).
   * @default false
   */
  emitOverlappingBackendSpans?: boolean;

  /**
   * Shared OTLP exporter hint for wrapper hosts and backend passthrough.
   * Backends inherit `endpoint` / `protocol` when their own fields are omitted.
   */
  exporter?: {
    /** e.g. `http://127.0.0.1:4318` */
    endpoint?: string;
    /** e.g. `http/protobuf` (preferred with Copilot) or `grpc` */
    protocol?: string;
  };

  /**
   * Backend runtime OTel passthrough (Hook F). Presence of a configured
   * backend block turns on de-dupe (no wrapper tool / gen_ai.usage duplicate).
   */
  backend?: {
    copilot?: {
      otlpEndpoint?: string;
      exporterType?: string;
      otlpProtocol?: "http/json" | "http/protobuf";
      sourceName?: string;
      captureContent?: boolean;
      filePath?: string;
      /** @default true when Copilot OTel is configured */
      propagateTraceContext?: boolean;
    };
    claude?: {
      enableTelemetry?: boolean;
      otlpEndpoint?: string;
      otlpProtocol?: string;
      /** @default true when Claude telemetry is enabled */
      propagateTraceContext?: boolean;
    };
    /** Merged into Codex `configOverrides.otel` (CLI `[otel]` shape). */
    codex?: Record<string, unknown>;
    /**
     * OpenCode server-side experimental flag. The wrapper does not start
     * OpenCode's exporter; set this so de-dupe policy matches your server.
     */
    opencode?: { openTelemetry?: boolean };
  };
}

/**
 * Policy computed once per task for deciding what the wrapper may emit to OTLP.
 */
export interface OtelEmissionPolicy {
  /** Wrapper instrumentation active for this task. */
  enabled: boolean;
  /** Backend is expected to export overlapping tool/LLM spans. */
  backendOtelOn: boolean;
  /** Wrapper may open tool child spans from AgentEvents. */
  emitToolSpans: boolean;
  /** Annotate the active task span with lifecycle AgentEvents. */
  annotateLifecycleOnTaskSpan: boolean;
  /**
   * Set GenAI-standard `gen_ai.usage.*` on the wrapper task span.
   *
   * Off when backend OTel is on — Copilot/Claude/Codex already put tokens on
   * their LLM spans; duplicating `gen_ai.usage.*` on the parent would make
   * naive SUM queries double-count. Task rollups use `a2a.task.usage.*`
   * instead (see {@link applyUsageSummaryToActiveSpan}).
   */
  emitGenAiUsageAttrs: boolean;
}

/**
 * Structural tracer surface — subset of `@opentelemetry/api` Tracer.
 * Hosts inject a real tracer; tests inject fakes. Keeps the API package optional.
 */
/** Minimal span context for span links (continue/retry across traces). */
export interface OtelSpanContextLike {
  traceId: string;
  spanId: string;
  traceFlags?: number;
}

export interface OtelSpanLinkLike {
  context: OtelSpanContextLike;
  attributes?: Record<string, string | number | boolean>;
}

export interface OtelTracerLike {
  startSpan(
    name: string,
    options?: {
      attributes?: Record<string, string | number | boolean>;
      links?: OtelSpanLinkLike[];
    },
  ): OtelSpanLike;
}

export interface OtelSpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus?(status: { code: number; message?: string }): void;
  recordException?(exception: unknown): void;
  addEvent?(name: string, attributes?: Record<string, string | number | boolean>): void;
  spanContext?(): OtelSpanContextLike;
  end(): void;
}

/** W3C trace context carrier for backend passthrough (Copilot / Claude env). */
export interface W3cTraceContext {
  traceparent?: string;
  tracestate?: string;
}

/**
 * Build an emission policy from config.
 */
export function resolveOtelEmissionPolicy(otel?: OtelConfig | null): OtelEmissionPolicy {
  const enabled = Boolean(otel?.enabled);
  const backend = otel?.backend;
  const backendOtelOn = Boolean(
    backend?.copilot?.otlpEndpoint ||
      backend?.copilot?.exporterType ||
      backend?.claude?.enableTelemetry ||
      (backend?.codex && Object.keys(backend.codex).length > 0) ||
      backend?.opencode?.openTelemetry,
  );
  const mirror = otel?.mirrorAgentEvents ?? false;
  const overlap = otel?.emitOverlappingBackendSpans === true;
  const emitToolSpans = enabled && mirror && (!backendOtelOn || overlap);
  const emitGenAiUsageAttrs = enabled && (!backendOtelOn || overlap);

  return {
    enabled,
    backendOtelOn,
    emitToolSpans,
    annotateLifecycleOnTaskSpan: enabled,
    emitGenAiUsageAttrs,
  };
}
