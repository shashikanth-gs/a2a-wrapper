/**
 * @module runtime/run-handle
 *
 * The internal state of one run (one task). A `RunHandle` owns what the design
 * document calls the run: the terminal-claim state machine, the abort signal of
 * the current turn, the turn queue, the event stream attachment and the hooks of
 * everything parked on the run (pending interactions, queued and provider-held
 * messages).
 *
 * ### One terminal claim
 *
 * `active -> (finalizing | canceling | expiring) -> ended`. {@link RunHandle.claim}
 * is synchronous and succeeds once: whoever claims publishes the task's one and only
 * terminal event. `complete`, `fail`, `reject`, `cancel` and expiry all go through
 * it, so a completion racing a cancel cannot produce two terminal events.
 *
 * The handle's lifetime is the claim, not any `execute()` call: it is registered at
 * the first `execute` and dropped only after the terminal event is out and the
 * stream is settled, so a cancel that arrives while the task sits at
 * `input-required` (no `execute()` in flight) still finds it.
 *
 * `RunHandle` is runtime-internal. Providers see only {@link CoreTaskRun} views,
 * which route every call through the handle's gate (see `run-registry.ts`).
 */

import { CANCELED } from "../model/cancel.js";
import type {
  CoreCaller,
  CoreError,
  DeliveryResult,
  CoreMessage,
  CoreRequest,
  CoreResult,
  CoreTaskState,
  SessionRef,
} from "../model/index.js";
import type { ExecuteInit, PendingHook, RunPublisher } from "./types.js";

export type RunPhase = "active" | "finalizing" | "canceling" | "expiring" | "ended";
export type TerminalClaim = "finalizing" | "canceling" | "expiring";

/** Why a turn's signal was aborted. `expire` is a core-side stop of the whole run. */
export type StopReason = "cancel" | "interrupt" | "shutdown";

export type TurnState = "starting" | "running" | "ended" | "stopped";

let turnSeq = 0;

/** One turn of a run: its own signal, so an interrupt can stop one turn and the next gets a fresh one. */
export class RunTurn {
  /** Start order of this turn, process-wide and increasing: a bind from an older turn never overwrites a newer one's. */
  readonly seq = ++turnSeq;
  /** Which `provider.run` call of this turn is current (1, or 2 after a `session-not-found` retry); a view of an older call is dead. */
  attempt = 0;
  /** The session this turn started with came from the context's binding (so `session-not-found` may retry it). */
  resumed = false;
  /** The one `session-not-found` retry of this turn was used (or is in flight): there is no second one. */
  retried = false;
  /** What the provider reported with `session-not-found` (the failure to give when the retry cannot run). */
  lostError?: CoreError;
  /** The turn published something a replay would repeat (an event, an artifact, an ask): `session-not-found` can no longer retry it. */
  observable = false;
  /** Wakes the turn runner for the `session-not-found` retry. */
  retrySignal?: () => void;
  /** Who sent the message this turn runs (the owner of the context it binds), and the tenant. */
  caller?: CoreCaller;
  tenant?: string;
  readonly controller = new AbortController();
  state: TurnState = "starting";
  /** Session in use by this turn: the context's binding at start, replaced by `bind`. */
  session?: SessionRef;
  /** Text accumulated from `text` events, used when the provider returns without a result. */
  text = "";
  /** Settled when `provider.run` for this turn settled (or never started). */
  runSettled: Promise<void> = Promise.resolve();
  /** The provider request of this turn (absent for legacy runs). */
  request?: CoreRequest;
  /** Resolves with CANCELED when the turn is stopped (cancel, interrupt, shutdown). */
  readonly stopped: Promise<typeof CANCELED>;
  private wake!: () => void;

  /** The queued message this turn runs, so its record can move to `done` when the turn ends. */
  messageId?: string;

  constructor(readonly turnId: string) {
    this.stopped = new Promise<typeof CANCELED>((resolve) => {
      this.wake = () => resolve(CANCELED);
    });
  }

  /** Wait for `work`, but wake with CANCELED as soon as the turn is stopped. A later rejection is swallowed. */
  race<T>(work: Promise<T>): Promise<T | typeof CANCELED> {
    work.catch(() => {}); // an aborted backend usually rejects; that is not a failure
    return Promise.race([work, this.stopped]);
  }

  /** Abort the signal with `reason` and wake every `race`. Idempotent. */
  stop(reason?: StopReason): void {
    if (this.state === "ended") return;
    this.state = "stopped";
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    this.wake();
  }

  get live(): boolean {
    return this.state === "starting" || this.state === "running";
  }
}

/** How a turn ended, as the provider said it (or as core inferred it). */
export type TurnOutcome = (
  | { kind: "completed"; result: CoreResult }
  | { kind: "failed"; error: CoreError }
  | { kind: "rejected"; error: CoreError }
) & {
  /** The outcome was already published as non-terminal output because more turns follow, so the final status does not repeat it. */
  published?: boolean;
};

/** A message waiting to become the next turn of the task (core-queued). */
export interface QueuedTurn {
  messageId: string;
  message: CoreMessage;
  init: ExecuteInit;
  /** Settles when the queue record is written, so a turn never claims a record that is not there yet. */
  written?: Promise<unknown>;
}

/** A provider-held message (the provider returned `queued` with this handle). */
export interface HeldEntry {
  handle: string;
  messageId?: string;
}

export interface RunHandleInit {
  runId: string;
  taskId: string;
  contextId: string;
  owner: CoreCaller;
  publisher?: RunPublisher;
  /** Builds the publisher core-initiated events use while no `execute()` is attached (writes the A2A task store). */
  detached?: () => RunPublisher | undefined;
}

/**
 * @internal Runtime-internal mutable state. Not part of the public API: other
 * runtimes (interactions, steering) see a run only through `RunInteractionHandle`.
 */
export class RunHandle {
  readonly runId: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly owner: CoreCaller;

  phase: RunPhase = "active";
  /** The state the run ended in, once `ended`. */
  endedState?: CoreTaskState;
  /** The event stream currently attached (the latest `execute()`). */
  publisher?: RunPublisher;
  private readonly detachedFactory?: () => RunPublisher | undefined;
  /** The run is parked on a presented interaction (see {@link signalParked}). */
  parked = false;
  /**
   * A reply has claimed the right to open its stream with the Task snapshot for this park. One claim per park: a second
   * snapshot on the shared bus lands inside the first reply's stream and breaks it (see `RunRegistry.beginReply`).
   */
  replyAttaching = false;
  /** When the {@link replyAttaching} claim was taken (ms since epoch): a claim whose request never reached `execute()` goes stale. */
  replyClaimedAt = 0;
  /** Token of the current reply claim: only its holder may release or refresh it. */
  replyToken = 0;
  /** `steer` handlers in flight. While any is, the task cannot go terminal: the message may still need a turn. */
  steering = 0;
  /**
   * An `interrupt` with no follow-up content stopped the turn: the task waits in `input-required` (marked interrupted)
   * for the next message, holding its context lane. `parked` is set too, so the next message attaches like a reply.
   */
  interruptedPark = false;
  /** Expires an interrupted park nobody continued. */
  interruptTimer?: ReturnType<typeof setTimeout>;
  /**
   * Deliveries already decided for this run, by message id (and idempotency key): a duplicate gets the same answer and
   * never enqueues, steers or interrupts twice. A promise, so two concurrent duplicates agree.
   */
  readonly deliveries = new Map<string, Promise<DeliveryResult>>();
  /** Ordering key of the next core-queued record: monotonic per run (the live position shrinks as messages start). */
  queueSeq?: number;
  /** The turn in progress, or the last one. */
  turn?: RunTurn;
  /** Every turn of the run, in order. */
  readonly turns: RunTurn[] = [];
  /** How the last ended turn ended; the run finalizes with it once nothing else remains. */
  lastOutcome?: TurnOutcome;
  /** An `interrupt` is waiting for the provider's abort to settle before the next turn may start. */
  stopping = false;
  /** The in-flight `abort(info, "interrupt")`, so a cancel or expiry arriving meanwhile can wait for it. */
  aborting?: Promise<unknown>;
  /** The turn that interrupt is stopping. */
  abortTarget?: RunTurn;
  /** Has the first turn been admitted by the context lane? A run waiting in the lane has not started. */
  started = false;
  /** Number of `execute()` calls currently waiting on this run. */
  attachments = 0;
  /** An `interrupt` stopped the running turn and the run is waiting for the next one. */
  awaitingNextTurn = false;

  /** Core-queued messages, in order: the next turns of this task. */
  readonly queue: QueuedTurn[] = [];
  /** Provider-held messages not yet begun or dropped. */
  readonly held = new Map<string, HeldEntry>();
  private readonly pending = new Set<PendingHook>();
  private waiters: Array<(o: "ended" | "parked") => void> = [];

  constructor(init: RunHandleInit) {
    this.runId = init.runId;
    this.taskId = init.taskId;
    this.contextId = init.contextId;
    this.owner = init.owner;
    this.publisher = init.publisher;
    this.detachedFactory = init.detached;
  }

  /**
   * The last `execute()` attached to the run returned at a park, so nothing consumes the event
   * bus any more (the SDK updates the task store only from events a request consumes).
   */
  consumerGone = false;

  /**
   * Where core-initiated and provider events go: the attached stream, or, once the last
   * attachment left at a park and until a reply attaches again, the detached publisher, which
   * writes the task store directly.
   */
  get sink(): RunPublisher | undefined {
    if (!this.consumerGone || !this.detachedFactory) return this.publisher;
    return this.detachedFactory() ?? this.publisher;
  }

  /** An `execute()` attached: its stream is the one events go to now. */
  setPublisher(p: RunPublisher): void {
    this.publisher = p;
    this.consumerGone = false;
  }

  /** True once a cancel claimed the run (or it ended canceled). */
  get canceled(): boolean {
    return this.phase === "canceling" || (this.phase === "ended" && this.endedState === "canceled");
  }

  /**
   * Claim the right to publish this run's terminal event. Synchronous; succeeds
   * only from `active`. The claimant must call {@link end} after publishing.
   */
  claim(kind: TerminalClaim): boolean {
    if (this.phase !== "active") return false;
    this.phase = kind;
    return true;
  }

  /** The terminal event is out and the stream settled. */
  end(state: CoreTaskState): void {
    this.phase = "ended";
    this.endedState = state;
    this.notify("ended");
  }

  /** Is there more work for this task after the running turn: queued messages or provider-held ones? */
  hasMoreWork(): boolean {
    return this.queue.length > 0 || this.held.size > 0;
  }

  /** Register something parked on the run (a pending interaction). Returns its unregister function. */
  registerPending(hook: PendingHook): () => void {
    this.pending.add(hook);
    return () => {
      this.pending.delete(hook);
    };
  }

  /** Settle every pending hook as canceled. Idempotent, synchronous. */
  settlePending(): number {
    const hooks = [...this.pending];
    this.pending.clear();
    for (const h of hooks) {
      try {
        h.cancel();
      } catch {
        /* a hook must not break a cancel */
      }
    }
    return hooks.length;
  }

  /**
   * The run is parked on an interaction: an `execute()` waiting on it may return. The flag
   * stays set, so an `execute()` that starts waiting later (a reply that re-parks the run
   * before its attachment began to wait) returns at once too.
   */
  signalParked(): void {
    this.parked = true;
    this.replyAttaching = false;
    this.notify("parked");
  }

  /** The parked interaction was resolved; the run continues. */
  signalResumed(): void {
    this.parked = false;
    this.replyAttaching = false;
  }

  /** Resolve at the next boundary: the run ended, or it is parked on an interaction. */
  waitBoundary(): Promise<"ended" | "parked"> {
    if (this.phase === "ended") return Promise.resolve("ended");
    if (this.parked) return Promise.resolve("parked");
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private notify(outcome: "ended" | "parked"): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f(outcome);
  }
}
