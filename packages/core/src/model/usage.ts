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
  /**
   * `cumulative` only. This reading is the FIRST of its series: the running total started inside the turn being reported
   * (a brand-new provider session), so with no stored previous reading the reading itself is the delta. Without it, a
   * `cumulative` reading that core has no previous reading for (a lost baseline: the process died between the session
   * being bound and its first reading, the binding was replaced) cannot be told apart from a resumed total, and core
   * reports no usage for it rather than the whole running total (see `CoreTaskRun.reportUsage`).
   */
  fresh?: boolean;
  tokens: UsageCounters;
  /** `null` when the provider does not report cost. */
  costUsd?: number | null;
  contextWindow?: { used?: number; limit?: number };
  /**
   * The model of a single-model reading. A provider that reports an aggregate
   * over several models MUST leave this unset and use `byModel`; setting it on an
   * aggregate would attribute everything to one model.
   */
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

/**
 * Add `more` to `into`, per model (a turn that spans several readings spent the sum of their deltas). Counters add; the
 * cost adds when both are numbers, and stays `null` (not reported) only when no reading carried one.
 */
export function addModelUsage(into: Record<string, ModelUsage>, more: Readonly<Record<string, ModelUsage>> | undefined): void {
  if (!more) return;
  for (const [model, u] of Object.entries(more)) {
    const t = Object.hasOwn(into, model) ? into[model]! : (into[model] = {});
    for (const k of COUNTER_KEYS) {
      if (isNum(u[k])) t[k] = (t[k] ?? 0) + (u[k] as number);
    }
    if (isNum(u.costUsd)) t.costUsd = roundCost((isNum(t.costUsd) ? t.costUsd : 0) + u.costUsd);
    else if (t.costUsd === undefined) t.costUsd = null;
  }
}

/**
 * The reading core keeps as the baseline of a cumulative series: the counters, cost and per-model totals, nothing
 * point-in-time (`contextWindow`). JSON-safe, so it survives a `RunStore`.
 */
export function usageBaselineOf(reading: CoreUsage): CoreUsage {
  const out: CoreUsage = { scope: "cumulative", tokens: { ...reading.tokens } };
  if (reading.series !== undefined) out.series = reading.series;
  if (reading.costUsd !== undefined) out.costUsd = reading.costUsd;
  if (reading.model !== undefined) out.model = reading.model;
  if (reading.byModel) out.byModel = Object.fromEntries(Object.entries(reading.byModel).map(([k, v]) => [k, { ...v }]));
  return out;
}

/** What core reports for a cumulative reading it has no previous reading of and cannot treat as a fresh series: nothing spent is claimed. */
export function unknownUsageDelta(reading: CoreUsage): CoreUsage {
  const out: CoreUsage = { scope: "delta", tokens: {} };
  if (reading.contextWindow) out.contextWindow = { ...reading.contextWindow };
  if (reading.model) out.model = reading.model;
  return out;
}

/**
 * Fold a new cumulative reading into the baseline of the same series without letting a DEGENERATE value erase what is known.
 *
 * A value of the reading is degenerate, and ignored (the baseline's value stands), when it is absent, `null`, not a finite number,
 * or `0` while the baseline's value for the same counter, cost or model is greater than 0: a crash or a startup error result may
 * carry zeroed or missing totals, and diffing the next real reading against "nothing" would report the whole session total. A
 * model the reading does not list keeps its baseline entry. `usable` is `false` when no value of the reading survived: such a
 * reading reports nothing and must not replace the baseline.
 *
 * Not degenerate, and therefore an epoch (`usageDelta`): a drop to a smaller NON-ZERO value (a genuine reset such as `/clear`
 * lands as a new epoch on its first real reading; a rounding-level decrease restarts the epoch too, which is harmless for
 * monotonic totals because the reading is the new total anyway). A reset that restarts from exactly zero is only seen once a
 * reading is below the old total.
 */
export function mergeUsageReading(baseline: CoreUsage | undefined, reading: CoreUsage): { merged: CoreUsage; usable: boolean } {
  let usable = false;
  const pick = (next: unknown, prev: unknown): number | undefined => {
    if (isNum(next) && !(next === 0 && isNum(prev) && prev > 0)) {
      usable = true;
      return next;
    }
    return isNum(prev) ? prev : undefined;
  };
  const group = (next: ModelUsage | undefined, prev: ModelUsage | undefined): ModelUsage => {
    const out: ModelUsage = {};
    for (const k of COUNTER_KEYS) {
      const v = pick(next?.[k], prev?.[k]);
      if (v !== undefined) out[k] = v;
    }
    const c = pick(next?.costUsd, prev?.costUsd);
    if (c !== undefined) out.costUsd = c;
    return out;
  };
  const top = group({ ...reading.tokens, costUsd: reading.costUsd }, baseline ? { ...baseline.tokens, costUsd: baseline.costUsd } : undefined);
  const { costUsd, ...tokens } = top;
  const merged: CoreUsage = { scope: "cumulative", tokens };
  if (reading.series !== undefined) merged.series = reading.series;
  if (costUsd !== undefined) merged.costUsd = costUsd;
  else if (reading.costUsd === null && baseline?.costUsd === undefined) merged.costUsd = null;
  if (reading.model !== undefined) merged.model = reading.model;
  const models = new Set([...Object.keys(reading.byModel ?? {}), ...Object.keys(baseline?.byModel ?? {})]);
  if (models.size > 0) {
    const byModel: Record<string, ModelUsage> = {};
    for (const m of models) {
      const next = reading.byModel && Object.hasOwn(reading.byModel, m) ? reading.byModel[m] : undefined;
      const prev = baseline?.byModel && Object.hasOwn(baseline.byModel, m) ? baseline.byModel[m] : undefined;
      byModel[m] = group(next, prev);
    }
    merged.byModel = byModel;
  }
  return { merged, usable };
}
