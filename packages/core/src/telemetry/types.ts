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
   * Hint that a backend runtime will export its own OTLP spans (Copilot CLI,
   * Claude Code subprocess, Codex, …). Used by the emission policy.
   */
  backend?: {
    copilot?: { otlpEndpoint?: string; exporterType?: string; propagateTraceContext?: boolean };
    claude?: { enableTelemetry?: boolean };
    codex?: Record<string, unknown>;
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
}

/**
 * Structural tracer surface — subset of `@opentelemetry/api` Tracer.
 * Hosts inject a real tracer; tests inject fakes. Keeps the API package optional.
 */
export interface OtelTracerLike {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
  ): OtelSpanLike;
}

export interface OtelSpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus?(status: { code: number; message?: string }): void;
  recordException?(exception: unknown): void;
  addEvent?(name: string, attributes?: Record<string, string | number | boolean>): void;
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

  return {
    enabled,
    backendOtelOn,
    emitToolSpans,
    annotateLifecycleOnTaskSpan: enabled,
  };
}
