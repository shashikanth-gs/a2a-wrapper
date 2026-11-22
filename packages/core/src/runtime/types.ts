/**
 * @module runtime/types
 *
 * Shared types of the run runtime. SDK-free: the runtime talks to an A2A event
 * bus only through {@link RunPublisher}, which `a2a/` implements.
 */

import type {
  CoreArtifact,
  CoreCaller,
  CoreEvent,
  CoreInteractionRequest,
  CoreInteractionResult,
  CoreMessage,
  CoreRequest,
  AskOptions,
  CoreTaskState,
  CoreUsage,
  Meta,
  SessionRef,
} from "../model/index.js";

/**
 * What the interactions and steering runtimes may see and do on a run. The
 * runtime-internal `RunHandle` satisfies it; depend on this, not on the class.
 */
export interface RunInteractionHandle {
  readonly runId: string;
  readonly taskId: string;
  readonly contextId: string;
  /** The event stream currently attached. */
  readonly publisher?: RunPublisher;
  /** Register something parked on the run; it is settled `canceled` inside a cancel's claim. Returns the unregister function. */
  registerPending(hook: PendingHook): () => void;
  /** The run is parked on an interaction: an `execute()` waiting on it may return. */
  signalParked(): void;
}

/** Default upper bound on how long core waits for a provider's abort, abortOrphan or release. */
export const DEFAULT_ABORT_TIMEOUT_MS = 5_000;

/** What the runtime says on a task's event stream. Implemented over the SDK event bus by `a2a/`. */
export interface RunPublisher {
  /** A task status. `text` becomes the status message. */
  status(update: { state: CoreTaskState; text?: string; metadata?: Meta; usage?: CoreUsage }): void;
  /** A non-terminal provider event (text delta, tool, usage, ...). */
  event(event: CoreEvent): void;
  /** An artifact (a streamed chunk or a final one). */
  artifact(artifact: CoreArtifact): void;
  /** Close the stream. Called once the terminal status is out. */
  finished(): void;
}

/** What an action is done to, for {@link Authorizer}. */
export interface AuthTarget {
  taskId: string;
  contextId: string;
  /** The task owner as recorded on the RunRecord, when known. */
  ownerId?: string;
}

/**
 * The single choke point for "may this caller do this to this task" (design
 * decision 3). v1 is {@link allowAll}. Replace it with one function; nothing else
 * changes, and every cancel and interrupt already records `by`.
 */
export type Authorizer = (
  by: CoreCaller,
  action: "cancel" | "interrupt" | (string & {}),
  target: AuthTarget,
) => boolean | Promise<boolean>;

/** The v1 policy: everybody may do everything. */
export const allowAll: Authorizer = () => true;

/** The ids a request builder needs to know to build a {@link CoreRequest}. */
export interface RequestIds {
  runId: string;
  turnId: string;
  /** The persisted provider session of the context, if it has one. */
  session?: SessionRef;
}

/** One execution request as the A2A layer hands it to the registry. */
export interface ExecuteInit {
  taskId: string;
  contextId: string;
  caller: CoreCaller;
  /** The event stream of this attachment (one per SDK `execute()` call). */
  publisher: RunPublisher;
  /** Builds the provider request once the ids and the context's session are known. */
  request(ids: RequestIds): CoreRequest;
  /** The incoming message, kept in the queue record when this request has to wait. */
  message?: CoreMessage;
}

/** How an `execute()` ended, for the A2A layer: what to do with the SDK call. */
export type ExecuteOutcome =
  /** The run reached its terminal event; `execute()` may return. */
  | "ended"
  /** The run is parked on an interaction (`input-required`); `execute()` may return, the run lives on. */
  | "parked"
  /** The task already had a running turn: this request is queued as its next turn. Nothing ran. */
  | "queued"
  /** The request was a reply to a pending interaction and was consumed by it. */
  | "reply";

/**
 * The seam for the interactions runtime (issue #108). The registry never builds
 * `run.ask` itself: it routes `ask` here and tells the runtime when to settle.
 */
export interface InteractionRuntime {
  /** Handle `run.ask` of a live turn. The runtime registers its pending asks with the handle. */
  ask(handle: RunInteractionHandle,request: CoreInteractionRequest, options?: AskOptions): Promise<CoreInteractionResult>;
  /**
   * A new `execute()` arrived for a task with a live run. Resolve `true` when it is
   * the reply to a pending interaction (it is consumed here and must not start a turn).
   */
  handleReply?(handle: RunInteractionHandle,init: ExecuteInit): boolean | Promise<boolean>;
}

/** A pending interaction (or anything else parked on the run) that must be settled when the run is canceled. */
export interface PendingHook {
  /** Settle it as canceled. Synchronous, called inside the cancel's claim, before any await. */
  cancel(): void;
}

/** A minimal logger. */
export interface RuntimeLogger {
  debug?(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

/** Why a `cancel` did or did not claim the task. */
export type CancelOutcome =
  | { claimed: true; runId: string }
  | {
      claimed: false;
      reason:
        | "unknown-task"
        | "denied"
        /** Already canceled: idempotent no-op. */
        | "already-canceled"
        /** Ended as completed, failed or rejected: not cancelable. */
        | "already-terminal"
        /** Completing, failing or expiring right now: not cancelable. */
        | "terminal-in-progress"
        /** Another cancel got there first. */
        | "already-canceling";
    };

/** Resolution of {@link RunRegistry.interrupt}. */
export type InterruptOutcome =
  | { interrupted: true }
  | { interrupted: false; reason: "unknown-task" | "denied" | "not-running" | "terminal" };

/** The info the orphan paths hand to `abortOrphan`, plus where it came from. */
export type OrphanSource = "store-cancel" | "sweep" | "cancel-no-handle";

/** What the startup sweep did to one record. */
export interface SweepEntry {
  taskId: string;
  runId: string;
  action:
    | "orphan-aborted"
    | "task-failed"
    | "turn-failed-queue-continued"
    | "skipped-interrupted"
    | "skipped-unknown-state"
    | "skipped-live";
  abort?: { stopped: string; session: string };
  queued: { replayed: string[]; dropped: string[]; unknown: string[] };
}

/** Result of {@link RunRegistry.sweep}. */
export interface SweepReport {
  entries: SweepEntry[];
}
