/**
 * @module model/usage
 *
 * Usage as providers report it, in one shape.
 *
 * @see docs/design/core-data-model.md section 3.7
 */

export interface CoreUsage {
  /**
   * `delta`: tokens for this step only. `cumulative`: running total for the
   * turn or session. Core converts cumulative to delta, which fixes double
   * counting.
   */
  scope: "delta" | "cumulative";
  tokens: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    total?: number;
  };
  /** `null` when the provider does not report cost. */
  costUsd?: number | null;
  contextWindow?: { used?: number; limit?: number };
  model?: string;
}
