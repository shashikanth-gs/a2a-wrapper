/**
 * @module model/message
 *
 * Messages, delivery intent and the outcomes of steering a running turn.
 *
 * A task is a sequence of turns. A message to a task that is running is
 * delivered by the caller's `delivery` intent and always lands in the same
 * task: `steer` folds it into the running turn, `queue` and `interrupt` make it
 * the next turn of that task. The task goes terminal only when the last turn
 * ends and nothing is queued for it. A message with only a `contextId` starts a
 * new task in that context's lane.
 *
 * @see docs/design/core-data-model.md section 3.4
 */

import type { CoreCaller, CorePart, Meta, Open } from "./primitives.js";

export interface CoreMessage {
  /** Returned to the caller at insertion. */
  id: string;
  role: "user" | "agent";
  parts: readonly CorePart[];
  from: CoreCaller;
  /** Caller intent for a message sent to a running task. Default `"queue"` (D4). */
  delivery?: Open<"queue" | "steer" | "interrupt">;
  idempotencyKey?: string;
  /** ISO timestamp. */
  at: string;
  meta?: Meta;
}

/**
 * A message from the stored history of a task. A2A carries no sender identity
 * and no timestamp on stored messages, so both are unknown rather than guessed:
 * a past user message is never attributed to the current caller or stamped with
 * the time of the request.
 */
export type HistoryMessage = Omit<CoreMessage, "from" | "at"> & {
  from?: CoreCaller;
  at?: string;
};

/** What a provider's `steer` handler returns. */
export type SteerOutcome =
  | { state: "inserted" }
  /** The provider holds the message in its own queue; `handle` identifies it if the provider can. */
  | { state: "queued"; handle?: string }
  | {
      state: "rejected";
      reason: Open<"no-active-turn" | "not-steerable" | "unsupported">;
      detail?: string;
    };

/**
 * What core tells the caller after delivering a message to a running task.
 * Every variant names the task and the message, so a caller can correlate.
 */
export type DeliveryResult =
  | { state: "inserted"; taskId: string; messageId: string }
  | {
      state: "queued";
      taskId: string;
      messageId: string;
      /** Who holds the message: the provider's own queue, or core's per-context lane. */
      holder: "provider" | "core";
      /** 1-based position in the holder's queue, when known. */
      position?: number;
    }
  | { state: "interrupted"; taskId: string; messageId: string }
  | { state: "rejected"; taskId: string; messageId: string; reason: string; detail?: string };

/**
 * Turn a provider's {@link SteerOutcome} into the {@link DeliveryResult} core
 * reports. A provider that queued the message holds it (`holder: "provider"`).
 */
export function deliveryFromSteer(taskId: string, messageId: string, outcome: SteerOutcome): DeliveryResult {
  switch (outcome.state) {
    case "inserted":
      return { state: "inserted", taskId, messageId };
    case "queued":
      return { state: "queued", taskId, messageId, holder: "provider" };
    case "rejected":
    default: {
      const o = outcome as Extract<SteerOutcome, { state: "rejected" }>;
      return {
        state: "rejected",
        taskId,
        messageId,
        reason: typeof o.reason === "string" && o.reason ? o.reason : "unsupported",
        ...(o.detail ? { detail: o.detail } : {}),
      };
    }
  }
}
