/**
 * OpenCode usage: one completed assistant message is one LLM call, with its own tokens and cost (a per-call figure, never a
 * running total), so each call is recorded as a delta and no cumulative bookkeeping is needed.
 */

import type { UsageCallRecord } from "@a2a-wrapper/core";

/**
 * Build a usage record from a completed assistant message. OpenCode reports one assistant message per LLM call: 1.x on
 * `message.updated`, 2.x via `session.step.ended` (translated to the same shape by the 2.x client). `cost` is OpenCode's own
 * figure for the call (0 for free models); it is `null` only when the message carries none.
 */
export function usageRecordFromMessage(info: Record<string, unknown>): UsageCallRecord | null {
  const tokens = info.tokens as Record<string, unknown> | undefined;
  const time = info.time as Record<string, unknown> | undefined;
  if (!tokens || typeof time?.completed !== "number") return null;
  const cache = (tokens.cache as Record<string, unknown> | undefined) ?? {};
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const provider = typeof info.providerID === "string" ? info.providerID : "";
  const model = typeof info.modelID === "string" ? info.modelID : "";
  const created = typeof time.created === "number" ? time.created : undefined;
  return {
    model: provider && model ? `${provider}/${model}` : model,
    inputTokens: num(tokens.input),
    outputTokens: num(tokens.output),
    cacheReadTokens: num(cache.read),
    cacheWriteTokens: num(cache.write),
    reasoningTokens: num(tokens.reasoning),
    durationMs: created !== undefined ? Math.max(0, time.completed - created) : 0,
    timeToFirstTokenMs: null,
    cost: typeof info.cost === "number" && Number.isFinite(info.cost) ? info.cost : null,
    apiEndpoint: null,
    initiator: null,
  };
}
