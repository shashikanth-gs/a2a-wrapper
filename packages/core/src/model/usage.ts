/**
 * @module model/usage
 *
 * Usage as providers report it, in one shape, and the pure arithmetic that
 * turns a running total into deltas.
 *
 * @see docs/design/core-data-model.md section 3.7
 */

/** Token counters. Every field is optional: a provider reports what it has. */
export interface UsageCounters {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
}

/** Counters and cost for one model. */
export type ModelUsage = UsageCounters & { costUsd?: number | null };

export interface CoreUsage {
  /**
   * `delta`: tokens for this step only. `cumulative`: a running total, see
   * `series`. Core converts cumulative to delta with {@link usageDelta}.
   */
  scope: "delta" | "cumulative";
  /**
   * Identity of the running total (a `cumulative` report). Two reports belong
   * to the same total only when their `series` is equal. A provider picks a
   * series per thing that accumulates, for example one per provider session, so
   * a new session starts a new total instead of looking like a decrease. Absent:
   * a single anonymous series.
   */
  series?: string;
  tokens: UsageCounters;
  /** `null` when the provider does not report cost. */
  costUsd?: number | null;
  contextWindow?: { used?: number; limit?: number };
  model?: string;
  /** Per-model breakdown, when the provider reports one. Same scope and series as the rest. */
  byModel?: Readonly<Record<string, ModelUsage>>;
}

const COUNTER_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"] as const;

const roundCost = (n: number) => Math.round(n * 1e9) / 1e9;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Delta of one (series, model) group. `prev` and `next` are two readings of the
 * same running total. If any counter or the cost went DOWN, the total was reset
 * (a `/clear`, a restart that does not resume): a new epoch starts and the
 * delta is the new reading as it is, never a negative number.
 */
function groupDelta(prev: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  const nextCost = next.costUsd;
  const decreased =
    prev !== undefined &&
    (COUNTER_KEYS.some((k) => isNum(prev[k]) && isNum(next[k]) && (next[k] as number) < (prev[k] as number)) ||
      (isNum(prev.costUsd) && isNum(nextCost) && nextCost < prev.costUsd));
  const base = prev === undefined || decreased ? undefined : prev;

  const out: ModelUsage = {};
  for (const k of COUNTER_KEYS) {
    const n = next[k];
    if (!isNum(n)) continue;
    const p = base?.[k];
    out[k] = isNum(p) ? n - p : n;
  }
  if (nextCost === null) out.costUsd = null;
  else if (isNum(nextCost)) {
    const pc = base?.costUsd;
    out.costUsd = isNum(pc) ? roundCost(nextCost - pc) : nextCost;
  }
  return out;
}

/**
 * Convert a usage reading to a delta.
 *
 * - `next.scope === "delta"`: returned as is (passthrough); `prev` is ignored.
 * - `cumulative`: compared with `prev`, the previous reading of the SAME series.
 *   No `prev`, or a different `series`, means the total is new and the reading
 *   is the delta. Otherwise each (series, model) group is diffed on its own: the
 *   top-level counters (keyed by `model`) and every `byModel` entry. A counter
 *   that went down starts a new epoch for its group (the delta is the new
 *   reading), so a reset, such as Claude's `total_cost_usd` after `/clear`, never
 *   yields a negative delta. A resume that keeps the same series and continues
 *   the totals yields the plain difference.
 *
 * `contextWindow` is a point-in-time reading and is passed through from `next`.
 * The result has scope `delta` and no `series`.
 */
export function usageDelta(prev: CoreUsage | undefined, next: CoreUsage): CoreUsage {
  if (next.scope === "delta") return next;

  const sameSeries = prev !== undefined && prev.scope === "cumulative" && prev.series === next.series;
  const sameModel = sameSeries && prev!.model === next.model;
  const top = groupDelta(sameModel ? { ...prev!.tokens, costUsd: prev!.costUsd } : undefined, {
    ...next.tokens,
    costUsd: next.costUsd,
  });
  const { costUsd, ...tokens } = top;

  const out: CoreUsage = { scope: "delta", tokens };
  if (costUsd !== undefined) out.costUsd = costUsd;
  if (next.contextWindow) out.contextWindow = { ...next.contextWindow };
  if (next.model) out.model = next.model;
  if (next.byModel) {
    const byModel: Record<string, ModelUsage> = {};
    for (const [model, reading] of Object.entries(next.byModel)) {
      const before = sameSeries && prev!.byModel && Object.hasOwn(prev!.byModel, model) ? prev!.byModel[model] : undefined;
      byModel[model] = groupDelta(before, reading);
    }
    out.byModel = byModel;
  }
  return out;
}
