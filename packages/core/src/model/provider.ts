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
import type { AbortOutcome, CoreRequest, CoreTaskRun, SessionRef, TaskRunInfo } from "./run.js";

/** Descriptive only; core never branches on it. */
export interface ProviderInfo {
  id: string;
  displayName: string;
  version?: string;
  /** Media types; feed the agent card. */
  inputModes: string[];
  outputModes: string[];
}

export interface ProviderExecutor {
  info(): ProviderInfo;
  initialize(): Promise<void>;
  /** Required: the backend call for one turn. */
  run(req: CoreRequest, run: CoreTaskRun): Promise<void>;
  /** Fold a message into the running turn. Absent: core answers `held`. */
  steer?(run: CoreTaskRun, message: CoreMessage): Promise<SteerOutcome>;
  /** Stop the running turn. Rejection or timeout counts as unconfirmed/discard. */
  abort?(run: TaskRunInfo): Promise<AbortOutcome>;
  /** Stop backend work for a task the store thinks is active but that has no live run. */
  abortOrphan?(info: { taskId: string; contextId: string; session?: { ref: string } }): Promise<void>;
  /** After a restart, resume waiting on interactions that carry a `handle`. */
  reattach?(pending: PendingInteraction[]): Promise<void>;
  /** Drop provider state for a discarded session. */
  release?(session: Pick<SessionRef, "ref">): Promise<void>;
  shutdown(): Promise<void>;
}
