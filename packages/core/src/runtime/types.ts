/**
 * @module runtime/types
 *
 * Shared types of the run runtime. SDK-free: the runtime talks to an A2A event
 * bus only through {@link RunPublisher}, which `a2a/` implements.
 */

import type {
  CoreArtifact,
  CoreCaller,
  CoreError,
  CoreEvent,
  CoreInteraction,
  CoreInteractionRequest,
  CorePart,
  CoreInteractionResult,
  CoreMessage,
  CoreRequest,
  DeliveryResult,
  AskOptions,
  CoreTaskState,
  CoreUsage,
  Meta,
  PendingInteraction,
  SessionRef,
} from "../model/index.js";
import type { BindingValidationReport } from "./bindings.js";
import type { RunStore } from "./run-store.js";

/**
 * What the interactions and steering runtimes may see and do on a run. The
 * runtime-internal `RunHandle` satisfies it; depend on this, not on the class.
 */
export interface RunInteractionHandle {
  readonly runId: string;
  readonly taskId: string;
  readonly contextId: string;
  /** The task owner (who started the run). */
  readonly owner: CoreCaller;
  /** The event stream currently attached. */
  readonly publisher?: RunPublisher;
  /**
   * Where core-initiated events go: the attached stream while an `execute()` is attached, else
   * the detached publisher (writes the A2A task store, since nothing consumes the bus then; for
   * example a timer that expires an interaction while the run is parked). Never use `publisher`
   * for those.
   */
  readonly sink: RunPublisher | undefined;
  /** Is the run parked on a presented interaction? Set by {@link signalParked}, cleared by {@link signalResumed}. */
  readonly parked: boolean;
  /** The reply's attachment takes over: later events go to `p`. Call before resuming the run. */
  setPublisher(p: RunPublisher): void;
  /** Register something parked on the run; it is settled `canceled` inside a cancel's claim. Returns the unregister function. */
  registerPending(hook: PendingHook): () => void;
  /**
   * The run is parked on an interaction: an `execute()` waiting on it may return (now, or when it
   * starts waiting: the flag stays set until {@link signalResumed}).
   */
  signalParked(): void;
  /** The presented interaction was resolved and the run continues; clear the parked flag. Synchronous, before the ask promise resolves. */
  signalResumed(): void;
}

/** Default upper bound on how long core waits for a provider's abort, abortOrphan or release. */
export const DEFAULT_ABORT_TIMEOUT_MS = 5_000;

/** What the runtime says on a task's event stream. Implemented over the SDK event bus by `a2a/`. */
export interface RunPublisher {
  /** A task status. `text` becomes the status message. */
  status(update: { state: CoreTaskState; text?: string; metadata?: Meta; usage?: CoreUsage }): void;
  /**
   * Park the task on an interaction: `input-required` (`auth-required` for an auth interaction)
   * with the text rendering and the structured interaction payload as the status message.
   * `hint` is prepended to the text (a re-prompt after a reply that could not be used).
   */
  interaction(interaction: CoreInteraction, options?: { hint?: string }): void;
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
  action: "cancel" | "interrupt" | "answer" | "steer" | "queue" | (string & {}),
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
  /** The tenant of the call (the SDK call context's), when there is one. A context binding belongs to one caller in one tenant. */
  tenant?: string;
  /** The event stream of this attachment (one per SDK `execute()` call). */
  publisher: RunPublisher;
  /** Builds the provider request once the ids and the context's session are known. */
  request(ids: RequestIds): CoreRequest;
  /** The incoming message, kept in the queue record when this request has to wait. Its `delivery` says what to do with it. */
  message?: CoreMessage;
  /**
   * May this request carry the run's event stream when the message resumes the run (a reply, an `interrupt` of a
   * parked task, a message that continues an interrupted task)? Default `true`. The A2A layer sets `false` for a
   * request that has a private ack-only stream (a message to a working task, design doc 3.12): the registry then
   * never attaches its publisher to the run and never waits for the run on its behalf.
   */
  carriesStream?: boolean;
  /**
   * Called synchronously, exactly once, with what core did with a message that arrived for a LIVE task, before the
   * request waits or returns and before any event of a resumed run. `resumed` is true when this request now carries
   * the run's stream. The A2A layer renders it to the caller (design doc 3.12).
   */
  onDelivery?(result: DeliveryResult, info: { resumed: boolean }): void;
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
  | "reply"
  /**
   * The message was delivered by its `delivery` and nothing queued: `steer` inserted or rejected, an `interrupt`
   * that stopped a turn, a rejection. The `DeliveryResult` went to `onDelivery`.
   */
  | "delivered";

/**
 * The seam for the interactions runtime (issue #108). The registry never builds
 * `run.ask` itself: it routes `ask` here and tells the runtime when to settle.
 */
export interface InteractionRuntime {
  /** Called once by the registry that owns this runtime, before anything else. */
  bind?(host: InteractionHost): void;
  /** Handle `run.ask` of a live turn. The runtime registers its pending asks with the handle. */
  ask(handle: RunInteractionHandle, request: CoreInteractionRequest, options?: AskOptions): Promise<CoreInteractionResult>;
  /**
   * A new `execute()` arrived for a task with a live run. Resolve `true` when it is
   * the reply to a pending interaction (it is consumed here and must not start a turn).
   * Must never throw.
   */
  handleReply?(
    handle: RunInteractionHandle,
    init: ExecuteInit,
    options?: HandleReplyOptions,
  ): boolean | Promise<boolean>;
  /**
   * The restart sweep re-created a live run for a task whose interactions carry a provider
   * handle: put these (still open) records back in front of the run. Their asks are answered
   * when the provider calls `run.ask(request, { handle })` again.
   */
  restore?(handle: RunInteractionHandle, records: readonly PendingInteraction[]): void;
  /**
   * The A2A task store is about to persist `parts` as message `messageId` of the task's history. `isNew` is true for the
   * message the SDK just appended (the last one): only such a message can be a reply that arrived while an interaction was
   * presented; older ones are hidden only if they were already recognised. When it answers a secret question of the
   * presented interaction, return the parts to store instead (the answers removed); else `undefined`. Must not mutate `parts`.
   */
  redactReply?(
    target: { taskId: string; handle?: RunInteractionHandle },
    messageId: string,
    parts: readonly CorePart[],
    isNew: boolean,
  ): Promise<readonly CorePart[] | undefined>;
}

/** How the registry asks the interactions runtime to treat a message that may be a reply. */
export interface HandleReplyOptions {
  /**
   * Re-publish the presented interaction with a hint when the message cannot be used as a reply (the default, today's
   * behaviour for a message with no `delivery`). `false` for an explicit `delivery: "queue"`: a message that is not a
   * reply is then NOT consumed (resolve `false`), so the registry queues it behind the interaction.
   */
  reprompt?: boolean;
  /**
   * Can this request carry the run's stream? When `false` and an interaction is presented the message cannot be a reply
   * to it (its stream is private): resolve `false` without touching the run.
   */
  carriesStream?: boolean;
}

/** What the registry gives its interactions runtime. */
export interface InteractionHost {
  readonly store: RunStore;
  readonly log: RuntimeLogger;
  now(): string;
  newId(): string;
  /** End the run because an interaction expired (the third terminal claim). */
  expire(taskId: string, error: CoreError, state?: "failed" | "canceled"): Promise<boolean>;
  /** Move the task's RunRecord to `state` (`input-required` while parked, `working` after). */
  setRunState(taskId: string, state: CoreTaskState): void;
  /** The single authorization choke point (design decision 3). */
  authorize(by: CoreCaller, action: string, target: AuthTarget): boolean | Promise<boolean>;
  /** Keep a background write so `registry.drain()` waits for it. */
  track<T>(p: Promise<T>): Promise<T>;
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
    /** An interrupted task whose pending interactions a provider re-attached (`reattach`). */
    | "interrupted-reattached"
    /** An interrupted task that could not be re-attached: failed with "server restarted", its pending interactions expired. */
    | "interrupted-failed"
    | "skipped-unknown-state"
    | "skipped-live";
  abort?: { stopped: string; session: string };
  queued: { replayed: string[]; dropped: string[]; unknown: string[] };
}

/** Result of {@link RunRegistry.sweep}. */
export interface SweepReport {
  entries: SweepEntry[];
  /** What the start-up binding validation did; only when `validateBindingsOnStart` is set. */
  bindings?: BindingValidationReport;
}
