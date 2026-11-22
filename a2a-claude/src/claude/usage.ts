/**
 * Claude usage → core usage.
 *
 * What the Claude Agent SDK reports on a `result` message, and what each field means (verified against the CLI):
 *
 * - `usage`: tokens of THIS turn, main loop only (sub-agents excluded). A per-turn delta. These are the tokens of `x-usage`.
 * - `total_cost_usd`: CUMULATIVE for the whole session. It keeps growing across turns of a streaming query, continues from the
 *   transcript total when a new query resumes the session, and drops back when the session is reset (`/clear`).
 * - `modelUsage`: per model, including sub-agents and compaction, cumulative like `total_cost_usd`. Its token counts are
 *   therefore NOT the same measure as `usage` (they include sub-agents and compaction); they are the per-model breakdown of the
 *   core usage key, and `x-usage` tokens stay the main loop's.
 *
 * The wrapper reports what the turn spent, never a running total. It hands core the cumulative reading (cost and `modelUsage`,
 * series = the Claude session id) and core diffs it against the previous reading of that session, kept with the context binding
 * (`run.reportUsage`, `RunObservability.recordCumulative`), so nothing is counted twice when a task spans several results or a
 * context spans several tasks, also after a restart.
 */

import type { CoreUsage, ModelUsage, UsageCallRecord } from "@a2a-wrapper/core";
import type { SDKMessageLike } from "./client-factory.js";

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

export interface ResultUsage {
  /** For the usage accumulator (`x-usage`): this result's main-loop tokens. The cost is the delta core reports. */
  call: Omit<UsageCallRecord, "cost">;
  /** The cumulative reading to hand to core. */
  reading: CoreUsage;
}

/**
 * Usage of one `result` message, success or error (an `error_max_turns` or `error_max_budget_usd` result carries
 * `total_cost_usd` too, and what it cost belongs to that task).
 *
 * @param series the Claude session id: two readings belong together only within one session.
 * @param fresh this is the first reading of a session this turn created (a resume continues a total this process never saw, so
 *   it is not fresh): with no baseline core then reports the whole reading, else nothing (see `CoreTaskRun.reportUsage`).
 */
export function resultUsage(msg: SDKMessageLike, modelFallback: string | undefined, series: string, fresh: boolean): ResultUsage {
  const usage = isObj(msg.usage) ? msg.usage : {};
  const byModel = modelTotals(msg.modelUsage);
  const reading: CoreUsage = {
    scope: "cumulative",
    series,
    ...(fresh ? { fresh: true } : {}),
    tokens: {},
    costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
    ...(byModel ? { byModel } : {}),
  };
  const call: Omit<UsageCallRecord, "cost"> = {
    model: (typeof msg.model === "string" ? msg.model : undefined) || modelFallback || "",
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    reasoningTokens: 0,
    durationMs: num(msg.duration_ms),
    timeToFirstTokenMs: null,
    apiEndpoint: null,
    initiator: "claude",
  };
  return { call, reading };
}
