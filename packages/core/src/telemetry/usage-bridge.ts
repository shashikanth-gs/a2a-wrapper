/**
 * Hook E — map accumulated LLM usage onto the active wrapper task span.
 *
 * Anti-duplication (same idea as tool spans):
 * - Sideband `trace.usage` / `metadata["x-usage"]` is unchanged (not OTLP).
 * - Wrapper never opens a second LLM span for usage.
 * - Wrapper never emits token **metrics** here (backends already may).
 * - When backend OTel is on: only `a2a.task.usage.*` rollup on `a2a.task.execute`
 *   (A2A task total). Do **not** set `gen_ai.usage.*` on the parent — those
 *   live on backend LLM spans; summing both would double-count.
 * - When backend OTel is off: also set `gen_ai.usage.*` on the task span so
 *   collectors still see tokens without a vendor exporter.
 *
 * @module telemetry/usage-bridge
 */

import type { UsageCallRecord, UsageTelemetryData } from "../events/usage.js";
import { getTaskOtelStore } from "./context.js";
import type { OtelSpanLike } from "./types.js";

function setNum(span: OtelSpanLike, key: string, value: number): void {
  span.setAttribute(key, value);
}

/**
 * Apply a task-level usage summary to the active `a2a.task.execute` span.
 * No-op when OTel is disabled or there is no active task span.
 */
export function applyUsageSummaryToActiveSpan(summary: UsageTelemetryData): void {
  const store = getTaskOtelStore();
  if (!store?.policy.enabled || !store.span) return;

  const span = store.span;
  // A2A-owned task rollup — safe alongside backend GenAI spans.
  setNum(span, "a2a.task.usage.input_tokens", summary.inputTokens);
  setNum(span, "a2a.task.usage.output_tokens", summary.outputTokens);
  setNum(span, "a2a.task.usage.cache_read_tokens", summary.cacheReadTokens);
  setNum(span, "a2a.task.usage.cache_write_tokens", summary.cacheWriteTokens);
  setNum(span, "a2a.task.usage.reasoning_tokens", summary.reasoningTokens);
  setNum(span, "a2a.task.usage.llm_calls", summary.llmCalls);
  setNum(span, "a2a.task.usage.duration_ms", summary.durationMs);
  if (summary.cost !== null) setNum(span, "a2a.task.usage.cost", summary.cost);
  if (summary.model) span.setAttribute("a2a.task.usage.model", summary.model);

  // GenAI attrs only when the wrapper is the sole OTel token source.
  if (store.policy.emitGenAiUsageAttrs) {
    setNum(span, "gen_ai.usage.input_tokens", summary.inputTokens);
    setNum(span, "gen_ai.usage.output_tokens", summary.outputTokens);
    if (summary.cacheReadTokens > 0) {
      setNum(span, "gen_ai.usage.cache_read_input_tokens", summary.cacheReadTokens);
    }
    if (summary.cacheWriteTokens > 0) {
      setNum(span, "gen_ai.usage.cache_creation_input_tokens", summary.cacheWriteTokens);
    }
    if (summary.reasoningTokens > 0) {
      setNum(span, "gen_ai.usage.reasoning_tokens", summary.reasoningTokens);
    }
    if (summary.model) span.setAttribute("gen_ai.request.model", summary.model);
  }
}

/**
 * Optional per-call annotation as a span **event** on the task span.
 *
 * Skipped when backend OTel is on (per-call tokens belong on vendor LLM spans).
 * Does not create child spans.
 */
export function applyUsageCallToActiveSpan(call: UsageCallRecord): void {
  const store = getTaskOtelStore();
  if (!store?.policy.enabled || !store.span) return;
  if (!store.policy.emitGenAiUsageAttrs) return;
  if (!store.span.addEvent) return;

  store.span.addEvent("a2a.llm.call", {
    "gen_ai.request.model": call.model,
    "gen_ai.usage.input_tokens": call.inputTokens,
    "gen_ai.usage.output_tokens": call.outputTokens,
    "a2a.llm.call.duration_ms": call.durationMs,
  });
}
