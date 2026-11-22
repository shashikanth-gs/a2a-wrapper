/**
 * Claude usage → core usage.
 *
 * What the Claude Agent SDK reports on a `result` message, and what each field means (verified against the CLI):
 *
 * - `usage`: tokens of THIS turn, main loop only (sub-agents excluded). A per-turn delta.
 * - `total_cost_usd`: CUMULATIVE for the whole session. It keeps growing across turns of a streaming query, continues from the
 *   transcript total when a new query resumes the session, and drops back when the session is reset (`/clear`).
 * - `modelUsage`: per model, including sub-agents and compaction, cumulative like `total_cost_usd`.
 *
 * The wrapper reports what the turn spent, never a running total: `x-usage` (tokens from `usage`, as it always was) carries the
 * cost of this turn, and core's usage key carries the per-model breakdown of this turn. The turn cost is the difference of two
 * readings of the same series (the Claude session id), taken with core's `usageDelta`, so nothing is counted twice when a task
 * spans several results or a context spans several tasks. The last cumulative reading is kept in the context binding's `meta`
 * (`usageTotals`), so the difference stays exact after a restart.
 */

import { usageDelta, type CoreUsage, type JsonObject, type ModelUsage, type UsageCallRecord } from "@a2a-wrapper/core";
import type { SDKMessageLike } from "./client-factory.js";

/** The cumulative reading kept with the session binding. */
export interface UsageTotals {
  costUsd: number | null;
  byModel?: Record<string, ModelUsage>;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `modelUsage` of a result as cumulative per-model counters. */
function modelTotals(raw: unknown): Record<string, ModelUsage> | undefined {
  if (!isObj(raw)) return undefined;
  const out: Record<string, ModelUsage> = {};
  for (const [model, u] of Object.entries(raw)) {
    if (!isObj(u)) continue;
    out[model] = {
      input: num(u.inputTokens),
      output: num(u.outputTokens),
      cacheRead: num(u.cacheReadInputTokens),
      cacheWrite: num(u.cacheCreationInputTokens),
      costUsd: typeof u.costUSD === "number" ? u.costUSD : null,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const reading = (series: string, t: UsageTotals): CoreUsage => ({
  scope: "cumulative",
  series,
  tokens: {},
  costUsd: t.costUsd,
  ...(t.byModel ? { byModel: t.byModel } : {}),
});

/** The reading stored with a binding, if it is for this session and well formed. */
export function totalsFromMeta(meta: JsonObject | undefined): UsageTotals | undefined {
  const t = meta?.usageTotals;
  if (!isObj(t)) return undefined;
  const byModel = isObj(t.byModel) ? (t.byModel as Record<string, ModelUsage>) : undefined;
  return { costUsd: typeof t.costUsd === "number" ? t.costUsd : null, ...(byModel ? { byModel } : {}) };
}

export interface ResultUsage {
  /** For the usage accumulator (`x-usage`): this turn's tokens and cost. */
  call: UsageCallRecord;
  /** This turn's per-model breakdown, from the difference of two `modelUsage` readings. */
  byModel: Record<string, ModelUsage> | undefined;
  /** The cumulative reading to keep for the next difference. */
  totals: UsageTotals;
}

/**
 * Usage of one success result.
 *
 * @param series the Claude session id: two readings belong together only within one session.
 * @param prev the previous cumulative reading of that session, when there is one.
 */
export function resultUsage(
  msg: SDKMessageLike,
  modelFallback: string | undefined,
  series: string,
  prev: UsageTotals | undefined,
): ResultUsage {
  const usage = isObj(msg.usage) ? msg.usage : {};
  const totals: UsageTotals = {
    costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
    ...(modelTotals(msg.modelUsage) ? { byModel: modelTotals(msg.modelUsage)! } : {}),
  };
  const delta = usageDelta(prev ? reading(series, prev) : undefined, reading(series, totals));
  const call: UsageCallRecord = {
    model: (typeof msg.model === "string" ? msg.model : undefined) || modelFallback || "",
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    reasoningTokens: 0,
    durationMs: num(msg.duration_ms),
    timeToFirstTokenMs: null,
    cost: delta.costUsd === undefined ? null : delta.costUsd,
    apiEndpoint: null,
    initiator: "claude",
  };
  return { call, byModel: delta.byModel as Record<string, ModelUsage> | undefined, totals };
}

/** Add `more` to `into` per model (a task that spans several results spent the sum of their turns). */
export function addByModel(into: Record<string, ModelUsage>, more: Record<string, ModelUsage> | undefined): void {
  if (!more) return;
  for (const [model, u] of Object.entries(more)) {
    const t = (into[model] ??= {});
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"] as const) {
      if (typeof u[k] === "number") t[k] = (t[k] ?? 0) + (u[k] as number);
    }
    if (typeof u.costUsd === "number") t.costUsd = (typeof t.costUsd === "number" ? t.costUsd : 0) + u.costUsd;
    else if (t.costUsd === undefined) t.costUsd = null;
  }
}
