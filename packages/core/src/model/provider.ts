/**
 * @module model/provider
 *
 * The contract a provider wrapper implements. Capabilities are the handlers
 * present plus the values returned; nothing says "this provider supports X"
 * (design decision D1).
 *
 * @see docs/design/core-data-model.md sections 3.7 and 3.8
 */

import type { CoreMessage, SteerOutcome } from "./message.js";
import type { PendingInteraction } from "./records.js";
import type { AbortOutcome, AbortReason, CoreRequest, CoreTaskRun, SessionRef, TaskRunInfo } from "./run.js";

/** Descriptive only; core never branches on it. */
export interface ProviderInfo {
  id: string;
  displayName: string;
  version?: string;
  /** Media types; feed the agent card. */
  inputModes: readonly string[];
  outputModes: readonly string[];
}

export interface ProviderExecutor {
  info(): ProviderInfo;
  initialize(): Promise<void>;
  /** Required: the backend call for one turn. */
  run(req: CoreRequest, run: CoreTaskRun): Promise<void>;
  /**
   * Fold a message into the running turn, or queue it natively. Absent: core
   * holds the message in its own lane (`queued`, `holder: "core"`) and runs it as
   * the next turn of the task.
   */
  steer?(run: CoreTaskRun, message: CoreMessage): Promise<SteerOutcome>;
  /**
   * Stop the running turn. Rejection or timeout counts as unconfirmed/discard.
   *
   * `reason` tells the provider what the stop is for. On `interrupt` the task
   * continues with the next turn, so the provider keeps its native queue. On
   * `cancel` the task is going away, so it must flush that queue. `shutdown` is
   * a core stop; treat it as `cancel` unless the provider can resume.
   */
  abort?(run: TaskRunInfo, reason: AbortReason): Promise<AbortOutcome>;
  /**
   * Stop backend work for a task the store thinks is active but that has no live
   * run (for example after a crash). Returns what the backend confirmed, like `abort`.
   */
  abortOrphan?(info: { taskId: string; contextId: string; session?: { ref: string } }): Promise<AbortOutcome>;
  /** After a restart, resume waiting on interactions that carry a `handle`. */
  reattach?(pending: readonly PendingInteraction[]): Promise<void>;
  /** Drop provider state for a discarded session. */
  release?(session: Pick<SessionRef, "ref">): Promise<void>;
  shutdown(): Promise<void>;
}
