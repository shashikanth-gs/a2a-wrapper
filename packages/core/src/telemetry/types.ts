/**
 * OpenTelemetry configuration and emission policy types.
 *
 * `@a2a-wrapper/core` only peers on `@opentelemetry/api` (optional).
 * Exporters / the SDK belong to the host application or wrapper CLI.
 *
 * @module telemetry/types
 */

/**
 * Common wrapper-level OTel settings — shared by every `a2a-*` package.
 *
 * These are **not** provider-specific. Put only Hook F / vendor knobs under
 * {@link OtelConfig.backend} (and each wrapper's schema only exposes *its*
 * backend key — see {@link OtelCopilotConfig}, {@link OtelClaudeConfig}, …).
 */
export interface OtelCommonConfig {
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
   * Stamp per-request usage rollups (`a2a.task.usage.*`, and `gen_ai.usage.*`
   * when the wrapper is the sole OTel source) via
   * {@link applyUsageSummaryToActiveSpan}.
   *
   * Default `true` when `enabled`. Sideband `x-usage` is unaffected.
   * Set `false` only to debug de-dupe / cardinality — rarely needed because
   * the whole bridge is already a no-op when `enabled` is false.
   * @default true
   */
  taskUsageRollup?: boolean;

  /**
   * Emit per-LLM-call span **events** (`a2a.llm.call`) on the task span when
   * the wrapper is the sole OTel token source. Off by default (noisy).
   * @default false
   */
  annotateUsageCalls?: boolean;

  /**
   * Shared OTLP exporter hint for wrapper hosts and backend passthrough.
   * Backends inherit `endpoint` / `protocol` when their own fields are omitted.
   */
  exporter?: {
    /** e.g. `http://127.0.0.1:6006` (Phoenix) or `http://127.0.0.1:4318` */
    endpoint?: string;
    /**
     * OTLP encoding for CLI bootstrap.
     * - `http/protobuf` (default) — `@opentelemetry/exporter-trace-otlp-proto`
     *   (Phoenix accepts only protobuf over HTTP)
     * - `http/json` — `@opentelemetry/exporter-trace-otlp-http`
     */
    protocol?: string;
  };
}

/** Copilot CLI OTel knobs (only meaningful on `a2a-copilot`). */
export interface OtelCopilotBackendConfig {
  otlpEndpoint?: string;
  exporterType?: string;
  otlpProtocol?: "http/json" | "http/protobuf";
  sourceName?: string;
  captureContent?: boolean;
  filePath?: string;
  /** @default true when Copilot OTel is configured */
  propagateTraceContext?: boolean;
}

/** Claude Code subprocess OTel knobs (only meaningful on `a2a-claude`). */
export interface OtelClaudeBackendConfig {
  enableTelemetry?: boolean;
  otlpEndpoint?: string;
  otlpProtocol?: string;
  /** @default true when Claude telemetry is enabled */
  propagateTraceContext?: boolean;
}

/** Codex CLI `[otel]` overrides (only meaningful on `a2a-codex`). */
export type OtelCodexBackendConfig = Record<string, unknown>;

/**
 * OpenCode server-side experimental flag (only meaningful on `a2a-opencode`).
 * The wrapper does not start OpenCode's exporter; set this so de-dupe policy
 * matches your server.
 */
export interface OtelOpenCodeBackendConfig {
  openTelemetry?: boolean;
}

/**
 * Full OTel config accepted by core helpers (all backend keys optional).
 *
 * Prefer the per-wrapper aliases in agent configs / JSON Schema so editors
 * only surface the backend that package actually implements:
 * {@link OtelCopilotConfig}, {@link OtelClaudeConfig}, {@link OtelCodexConfig},
 * {@link OtelOpenCodeConfig}, {@link OtelAntigravityConfig}.
 */
export interface OtelConfig extends OtelCommonConfig {
  /**
   * Backend runtime OTel passthrough (Hook F). Only the key matching the
   * running wrapper is read. Presence of a configured backend block turns on
   * de-dupe (no wrapper tool / gen_ai.usage duplicate).
   */
  backend?: {
    copilot?: OtelCopilotBackendConfig;
    claude?: OtelClaudeBackendConfig;
    codex?: OtelCodexBackendConfig;
    opencode?: OtelOpenCodeBackendConfig;
  };
}

/** `a2a-copilot` agent `otel` — common + Copilot Hook F only. */
export type OtelCopilotConfig = OtelCommonConfig & {
  backend?: { copilot?: OtelCopilotBackendConfig };
};

/** `a2a-claude` agent `otel` — common + Claude Hook F only. */
export type OtelClaudeConfig = OtelCommonConfig & {
  backend?: { claude?: OtelClaudeBackendConfig };
};

/** `a2a-codex` agent `otel` — common + Codex Hook F only. */
export type OtelCodexConfig = OtelCommonConfig & {
  backend?: { codex?: OtelCodexBackendConfig };
};

/** `a2a-opencode` agent `otel` — common + OpenCode Hook F only. */
export type OtelOpenCodeConfig = OtelCommonConfig & {
  backend?: { opencode?: OtelOpenCodeBackendConfig };
};

/**
 * `a2a-antigravity` agent `otel` — common settings only (no Hook F backend
 * passthrough yet).
 */
export type OtelAntigravityConfig = OtelCommonConfig;

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
  /**
   * Apply task-level usage rollups on the active span
   * (`a2a.task.usage.*` ± `gen_ai.usage.*`).
   */
  emitTaskUsageRollup: boolean;
  /** Emit per-call `a2a.llm.call` span events (wrapper-only token source). */
  annotateUsageCalls: boolean;
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
  const emitTaskUsageRollup = enabled && otel?.taskUsageRollup !== false;
  const annotateUsageCalls =
    enabled && otel?.annotateUsageCalls === true && emitGenAiUsageAttrs;

  return {
    enabled,
    backendOtelOn,
    emitToolSpans,
    annotateLifecycleOnTaskSpan: enabled,
    emitGenAiUsageAttrs,
    emitTaskUsageRollup,
    annotateUsageCalls,
  };
}
