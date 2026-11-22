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
import type { AbortOutcome, AbortReason, CoreRequest, CoreTaskRun, OrphanInfo, SessionRef, TaskRunInfo } from "./run.js";

/** Descriptive only; core never branches on it. */
export interface ProviderInfo {
  id: string;
  displayName: string;
  version?: string;
  /**
   * The format of the session references this provider persists with `run.bind`. Core stamps it on every binding
   * (issuer = `<id>@<sessionFormat ?? "1">`) and compares it for equality when the binding is read back. It is NOT the
   * package version: a deploy that bumps `version` keeps every conversation. Change it only when a stored `ref` or `meta`
   * of the old shape cannot be resumed by the new code; core then drops the old bindings without replaying them and
   * WITHOUT calling `release` (the old format may still own those sessions).
   */
  sessionFormat?: string;
  /** Media types; feed the agent card. */
  inputModes: readonly string[];
  outputModes: readonly string[];
}

/** What core hands to {@link ProviderExecutor.reattach}: the restored runs, by task. */
export interface ReattachRuns {
  /** The restored run's view, or `undefined` when core did not restore that task. */
  view(taskId: string): CoreTaskRun | undefined;
}

/** What {@link ProviderExecutor.probeSession} answers. */
export type SessionProbe = "alive" | "gone" | "unknown";

export interface ProviderExecutor {
  info(): ProviderInfo;
  initialize(): Promise<void>;
  /** Required: the backend call for one turn. */
  run(req: CoreRequest, run: CoreTaskRun): Promise<void>;
  /**
   * Fold a message into the running turn, or queue it natively. A native queue
   * must be reported (`queued`, with a `handle` if it can) and later announced
   * with `run.beginHeldTurn(handle)` or `run.dropHeld(handle)`. Absent: core
   * holds the message in its own lane (`queued`, `holder: "core"`) and runs it as
   * the next turn of the task.
   */
  steer?(run: CoreTaskRun, message: CoreMessage): Promise<SteerOutcome>;
  /**
   * Stop the running turn. Rejection or timeout counts as unconfirmed/discard.
   *
   * `reason` tells the provider what the stop is for. The rule for steers the
   * provider holds (`SteerOutcome.queued`): on `interrupt` they are REQUEUED into
   * core (`run.settleSteer(handle, "requeue")`, after taking them out of the
   * native queue), because a native queue that the next prompt also drains
   * would run them inside the next turn, where their output cannot be told
   * apart; on `cancel` the task is going away, so they are cancelled and dropped
   * (`run.dropHeld`). A provider whose native queue is private to the stopped
   * process may let it die with the process. `shutdown` is a core stop; treat it
   * as `cancel` unless the provider can resume.
   */
  abort?(run: TaskRunInfo, reason: AbortReason): Promise<AbortOutcome>;
  /**
   * Stop backend work for a task the store thinks is active but that has no live
   * run (for example after a crash). Returns what the backend confirmed, like `abort`.
   */
  abortOrphan?(info: OrphanInfo): Promise<AbortOutcome>;
  /**
   * After a restart, resume waiting on interactions that carry a `handle`. Core has
   * restored them (same id, `seq` and reply code, presented or queued, timers re-armed) and
   * re-created a live run for each task; `runs.view(taskId)` is that run's view. The provider
   * calls `view.ask(request, { handle })` again for each pending interaction it re-attached:
   * core matches the handle, returns the restored interaction's promise (no new record) and the
   * provider continues the turn it had parked. A provider that does not implement `reattach`
   * (or rejects) gets its interrupted tasks failed with "server restarted".
   */
  reattach?(pending: readonly PendingInteraction[], runs: ReattachRuns): Promise<void>;
  /** Drop provider state for a discarded session. */
  release?(session: Pick<SessionRef, "ref">): Promise<void>;
  /**
   * Optional liveness check of a persisted session, used by core's start-up validation (`validateBindingsOnStart`).
   * `"gone"`: the backend does not have it any more (core deletes the binding). `"alive"` and `"unknown"` keep it; a
   * provider without this method, a rejection and a timeout all count as `"unknown"`: the first resume decides, and a
   * session the backend cannot resume is reported with `SESSION_NOT_FOUND` (core then forgets it and retries once).
   * Must not change the session.
   */
  probeSession?(session: SessionRef): Promise<SessionProbe>;
  shutdown(): Promise<void>;
}
