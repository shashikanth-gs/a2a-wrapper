/**
 * Hook F helpers — map `otel.backend.*` config into vendor SDK knobs.
 *
 * Core stays free of vendor SDK imports. Wrappers call these and pass the
 * result into CopilotClient / Claude query env / Codex configOverrides.
 *
 * @module telemetry/backend-passthrough
 */

import { getW3cTraceContext } from "./context.js";
import type { OtelConfig, W3cTraceContext } from "./types.js";

/** Shared OTLP endpoint from `otel.exporter` or a backend-specific override. */
export function resolveOtlpEndpoint(
  otel: OtelConfig | null | undefined,
  backendEndpoint?: string,
): string | undefined {
  return backendEndpoint || otel?.exporter?.endpoint || undefined;
}

/**
 * Copilot SDK `telemetry` block. Returns `undefined` when Copilot backend
 * OTel is not configured (do not pass an empty object — that can still flip CLI flags).
 */
export function buildCopilotTelemetryOptions(
  otel?: OtelConfig | null,
): {
  otlpEndpoint?: string;
  exporterType?: string;
  otlpProtocol?: "http/json" | "http/protobuf";
  sourceName?: string;
  captureContent?: boolean;
} | undefined {
  const c = otel?.backend?.copilot;
  if (!c) return undefined;
  const otlpEndpoint = resolveOtlpEndpoint(otel, c.otlpEndpoint);
  if (!otlpEndpoint && !c.exporterType && !c.filePath) return undefined;

  const out: {
    otlpEndpoint?: string;
    exporterType?: string;
    otlpProtocol?: "http/json" | "http/protobuf";
    sourceName?: string;
    captureContent?: boolean;
    filePath?: string;
  } = {};
  if (otlpEndpoint) out.otlpEndpoint = otlpEndpoint;
  if (c.exporterType) out.exporterType = c.exporterType;
  else if (otlpEndpoint) out.exporterType = "otlp-http";
  if (c.otlpProtocol === "http/json" || c.otlpProtocol === "http/protobuf") {
    out.otlpProtocol = c.otlpProtocol;
  } else if (otlpEndpoint) {
    out.otlpProtocol = "http/protobuf";
  }
  if (c.sourceName) out.sourceName = c.sourceName;
  else if (otel?.serviceName) out.sourceName = otel.serviceName;
  if (c.captureContent === true) out.captureContent = true;
  if (c.filePath) out.filePath = c.filePath;
  return out;
}

/**
 * Whether Copilot should receive `onGetTraceContext` (parent-link into the
 * active wrapper span). Default true when Copilot backend OTel is configured.
 */
export function shouldPropagateCopilotTraceContext(otel?: OtelConfig | null): boolean {
  const c = otel?.backend?.copilot;
  if (!c) return false;
  if (c.propagateTraceContext === false) return false;
  return Boolean(c.otlpEndpoint || c.exporterType || c.filePath || otel?.exporter?.endpoint);
}

/** Provider for CopilotClientOptions.onGetTraceContext. */
export function createCopilotTraceContextProvider(): () => W3cTraceContext {
  return () => getW3cTraceContext();
}

/**
 * Env vars for the Claude Code subprocess when `otel.backend.claude` is on.
 * Merges into (or creates) the query `env` map. Includes ambient `process.env`
 * keys already present in `base` when provided.
 *
 * `TRACEPARENT` / `TRACESTATE` are taken from the **current** active span
 * (call this inside `a2a.task.execute`).
 */
export function buildClaudeOtelEnv(
  otel: OtelConfig | null | undefined,
  base?: Record<string, string>,
): Record<string, string> | undefined {
  const c = otel?.backend?.claude;
  if (!c?.enableTelemetry) return base;

  const env: Record<string, string> = { ...(base ?? {}) };
  env["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1";

  const endpoint = resolveOtlpEndpoint(otel, c.otlpEndpoint);
  if (endpoint) {
    env["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint;
    env["OTEL_EXPORTER_OTLP_PROTOCOL"] =
      c.otlpProtocol ?? otel?.exporter?.protocol ?? "http/protobuf";
  }
  if (otel?.serviceName) env["OTEL_SERVICE_NAME"] = otel.serviceName;

  if (c.propagateTraceContext !== false) {
    const w3c = getW3cTraceContext();
    if (w3c.traceparent) env["TRACEPARENT"] = w3c.traceparent;
    if (w3c.tracestate) env["TRACESTATE"] = w3c.tracestate;
  }

  return env;
}

/**
 * Merge Codex `[otel]`-shaped overrides from `otel.backend.codex` into an
 * existing `configOverrides` object.
 */
export function mergeCodexOtelOverrides(
  otel: OtelConfig | null | undefined,
  configOverrides?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const c = otel?.backend?.codex;
  if (!c || Object.keys(c).length === 0) {
    return configOverrides && Object.keys(configOverrides).length > 0
      ? { ...configOverrides }
      : undefined;
  }

  const endpoint = resolveOtlpEndpoint(otel, typeof c.endpoint === "string" ? c.endpoint : undefined);
  const otelBlock: Record<string, unknown> = {
    ...(typeof c === "object" ? c : {}),
  };
  if (endpoint && otelBlock.endpoint === undefined) {
    otelBlock.endpoint = endpoint;
  }
  // Codex defaults exporter to "none"; if operator enabled backend.codex, prefer otlp.
  if (otelBlock.exporter === undefined && endpoint) {
    otelBlock.exporter = "otlp";
  }

  return {
    ...(configOverrides ?? {}),
    otel: {
      ...((configOverrides?.otel as Record<string, unknown>) ?? {}),
      ...otelBlock,
    },
  };
}

/** Whether OpenCode server-side experimental OTel should be considered on (de-dupe). */
export function isOpenCodeBackendOtelEnabled(otel?: OtelConfig | null): boolean {
  return Boolean(otel?.backend?.opencode?.openTelemetry);
}
