/**
 * @module model/message
 *
 * Messages, delivery intent and the outcomes of steering a running turn.
 *
 * @see docs/design/core-data-model.md section 3.4
 */

import type { CoreCaller, CorePart, Meta, Open } from "./primitives.js";

export interface CoreMessage {
  /** Returned to the caller at insertion. */
  id: string;
  role: "user" | "agent";
  parts: CorePart[];
  from: CoreCaller;
  /** Caller intent for a message sent to a running task. Default `"queue"` (D4). */
  delivery?: Open<"queue" | "steer" | "interrupt">;
  idempotencyKey?: string;
  /** ISO timestamp. */
  at: string;
  meta?: Meta;
}

/** What a provider's `steer` handler returns. */
export type SteerOutcome =
  | { state: "inserted" }
  | { state: "held" }
  | {
      state: "rejected";
      reason: Open<"no-active-turn" | "not-steerable" | "unsupported">;
      detail?: string;
    };

/** What core tells the caller after delivering a message to a running task. */
export type DeliveryResult = SteerOutcome | { state: "interrupted" };
