/**
 * Span naming (design: docs/design/distributed-tracing.md, 8.4).
 *
 * `legacy` (default) keeps the names dashboards and queries already use:
 * `a2a.task.execute`, `a2a.mcp.tool {tool}`. `semconv` uses the OpenTelemetry
 * GenAI names: `invoke_agent {agent}` and `execute_tool {tool}`. Only the span
 * **name** changes; attributes (including `gen_ai.operation.name`) are the same
 * in both modes. The cancel span (`a2a.task.cancel`) has no GenAI equivalent
 * and is never renamed.
 *
 * @module telemetry/span-naming
 */

import type { OtelSpanNaming } from "./types.js";

export const SPAN_NAMING_MODES: readonly OtelSpanNaming[] = ["legacy", "semconv"];

export interface SpanNamingSource {
  spanNaming?: unknown;
}

/** Resolve the naming mode. Precedence: `A2A_OTEL_SPAN_NAMING` over `otel.spanNaming`. Invalid values warn and fall back to `legacy`. */
export function resolveSpanNaming(
  otel?: SpanNamingSource | null,
  env: Record<string, string | undefined> = process.env,
): OtelSpanNaming {
  const fromEnv = env["A2A_OTEL_SPAN_NAMING"]?.trim().toLowerCase();
  const candidate = fromEnv ? fromEnv : typeof otel?.spanNaming === "string" ? otel.spanNaming.trim().toLowerCase() : undefined;
  if (!candidate) return "legacy";
  if ((SPAN_NAMING_MODES as readonly string[]).includes(candidate)) return candidate as OtelSpanNaming;
  console.warn(
    `[a2a-wrapper/otel] ignoring invalid span naming "${candidate}" (expected ${SPAN_NAMING_MODES.join(" | ")})`,
  );
  return "legacy";
}

/** Name of the request span. */
export function requestSpanName(naming: OtelSpanNaming | undefined, agentName: string): string {
  return naming === "semconv" ? `invoke_agent ${agentName}` : "a2a.task.execute";
}

/** Name of a mirrored tool span. */
export function toolSpanName(naming: OtelSpanNaming | undefined, toolName: string): string {
  return naming === "semconv" ? `execute_tool ${toolName}` : `a2a.mcp.tool ${toolName}`;
}
