/**
 * @module runtime/run-registry
 *
 * The core-owned run runtime: one {@link RunHandle} per task, the context lanes,
 * and the single cancel entry point. Evolution of `TaskRunRegistry`, which stays as
 * a shim over the same handle (see `executor/task-runs.ts`).
 *
 * ### cancel(taskId, by): the choke point
 *
 * 1. `authorize(by, "cancel", task)` (allow-all in v1; one replaceable function).
 * 2. SYNCHRONOUS claim of the run's terminal state. Already canceled: idempotent
 *    no-op. Ended otherwise, or completing: no-op (the SDK reports "not
 *    cancelable"). A second cancel: no-op.
 * 3. Settle what hangs on the run before any await: pending interactions are
 *    answered `canceled`, core-queued and provider-held messages are dropped
 *    (and their records say why).
 * 4. Persist `RunRecord.state = canceled` and publish exactly ONE `canceled`
 *    status, then close the stream, before awaiting anything. The SDK tears the
 *    bus down when `execute()` returns, so a terminal event published after a slow
 *    abort would be lost.
 * 5. Abort the turn's signal (reason `cancel`) and wake every `race`.
 * 6. Run `provider.abort(info, "cancel")` in the BACKGROUND with a timeout. The
 *    `tasks/cancel` call does not wait for it. The outcome is applied when it
 *    settles: `session: "discard"` clears the context binding and calls
 *    `provider.release`; a rejection or timeout is `ABORT_FAILED_OUTCOME`. The
 *    next turn of the same context waits (lane gate) for that, so a session is
 *    never reused while the backend may still be stopping.
 *
 * ### Orphans
 *
 * A run that is active in the store but has no live handle (the process
 * restarted) can only be stopped through `abortOrphan`. {@link RunRegistry.handleStoreCancel}
 * is what the `TaskStore` wrapper calls when the SDK writes `CANCELED` itself
 * (SDK 1.3 does that, without calling the executor, when a task has no event bus),
 * and {@link RunRegistry.sweep} is the startup pass.
 *
 * @see docs/design/core-data-model.md sections 3.2, 3.4, 3.5, 3.6
 */

import { randomUUID } from "node:crypto";
import { CANCELED } from "../model/cancel.js";
import {
  ABORT_FAILED_OUTCOME,
  classifyState,
  isOpenInteractionState,
  newRecordHeader,
  SESSION_NOT_FOUND,
  type AbortOutcome,
  type AbortReason,
  type AskOptions,
  type CoreArtifact,
  type CoreCaller,
  type CoreError,
  type CoreEvent,
  type CorePart,
  type CoreInteractionRequest,
  type CoreInteractionResult,
  type CoreMessage,
  type CoreResult,
  type CoreTaskRun,
  type BindResult,
  type CoreTaskState,
  type CoreUsage,
  type DeliveryKind,
  type DeliveryResult,
  type Meta,
  type OrphanInfo,
  type PendingInteraction,
  type ProviderExecutor,
  type QueuedMessageRecord,
  type RunRecord,
  type SessionProbe,
  type SessionRef,
  type SteerOutcome,
  type TaskRunInfo,
  deliveryFromSteer,
  messageHasContent,
  unknownUsageDelta,
  resolveDelivery,
  type ResolvedDelivery,
} from "../model/index.js";
import {
  assertBindable,
  ContextBindings,
  type BindingSweepReport,
  type BindingValidationReport,
} from "./bindings.js";
import { InteractionsRuntime } from "./interactions.js";
import type { InteractionPolicy } from "./interaction-policy.js";
import { RunHandle, RunTurn, type QueuedTurn, type TurnOutcome } from "./run-handle.js";
import { InMemoryRunStore, type RunStore } from "./run-store.js";
import {
  allowAll,
  DEFAULT_ABORT_TIMEOUT_MS,
  type Authorizer,
  type CancelOutcome,
  type ExecuteInit,
  type ExecuteOutcome,
  type InteractionRuntime,
  type InterruptOutcome,
  type RunInteractionHandle,
  type RunPublisher,
  type RuntimeLogger,
  type SweepEntry,
  type SweepReport,
} from "./types.js";

const NOOP_LOGGER: RuntimeLogger = { warn() {} };
const MAX_TOMBSTONES = 1000;
const TERMINAL_WRITE_ATTEMPTS = 3;
/** Concurrent `abortOrphan` calls during the startup sweep. */
const SWEEP_CONCURRENCY = 4;
/** A reply claim whose request never reached `execute()` (the SDK failed in between) is stale after this long. */
const REPLY_CLAIM_TTL_MS = 15_000;
/** Default bound for a provider's `steer` handler. A timeout is ambiguous (the provider may have taken the message). */
const DEFAULT_STEER_TIMEOUT_MS = 30_000;
/** How long an interrupted task (an `interrupt` with no follow-up message) waits for the next message. */
export const DEFAULT_INTERRUPTED_TIMEOUT_MS = 10 * 60_000;

/** A publisher that says nothing: the stream of a request that has no stream of its own to carry the run. */
const SILENT_PUBLISHER: RunPublisher = {
  status() {},
  interaction() {},
  event() {},
  artifact() {},
  finished() {},
};

/** What one delivery decided. */
interface DeliveryDecision {
  result: DeliveryResult;
  /** This request now carries the run's event stream (it resumed a parked or interrupted run). */
  resumed: boolean;
  /**
   * Remember the answer for duplicates of this message id. A rejection that changed nothing is not remembered (the
   * caller may retry); an ambiguous one (the provider's `steer` failed or timed out) is, so a retry cannot double-deliver.
   */
  cache: boolean;
}

/** Builds the publisher for a task when the caller (the SDK's `cancelTask`) only has a bus. */
export type PublisherFactory = (ids: { taskId: string; contextId: string }) => RunPublisher;

/**
 * Builds the publisher core uses for a run nobody is consuming (parked at `input-required`): one
 * that writes the A2A task store directly. See `RunInteractionHandle.sink`.
 */
export type DetachedPublisherFactory = (info: {
  taskId: string;
  contextId: string;
  owner: { id: string; kind: string };
  /** The registry's per-task publisher bookkeeping, so every publisher of a run agrees on which artifacts were started. */
  publisherState: Map<string, Set<string>>;
}) => RunPublisher | undefined;

export interface RunRegistryOptions {
  provider: ProviderExecutor;
  /** Default: a new {@link InMemoryRunStore}. */
  store?: RunStore;
  /** Default: {@link allowAll}. */
  authorize?: Authorizer;
  /**
   * The interactions runtime (issue #108). Default: core's own {@link InteractionsRuntime} over
   * `interactionPolicy`.
   */
  interactions?: InteractionRuntime;
  /**
   * Interaction policy of the default runtime (3.9). Default `mode: "auto"`: core asks nobody and
   * `run.ask` answers `unavailable`, which is today's behaviour. `mode: "ask"` is the opt-in.
   */
  interactionPolicy?: Partial<InteractionPolicy>;
  /** See {@link DetachedPublisherFactory}; the server factory sets it, or call {@link RunRegistry.setDetachedPublisher}. */
  detached?: DetachedPublisherFactory;
  /** Upper bound for `abort` / `abortOrphan` / `release` / `probeSession`. Default {@link DEFAULT_ABORT_TIMEOUT_MS}. */
  abortTimeoutMs?: number;
  /**
   * How long a reply claim nobody refreshes stays held before it may be taken over (a wedge breaker only: the holder refreshes
   * it every third of this while its request lives). Default 15 seconds.
   */
  replyClaimTtlMs?: number;
  /**
   * Upper bound for the provider's `steer` handler. Default 30 seconds. A steer that times out is AMBIGUOUS (the provider
   * may have taken the message): it is answered `rejected` / `steer-failed` and remembered by message id, so a caller that
   * wants to resend deliberately must use a NEW message id.
   */
  steerTimeoutMs?: number;
  /**
   * How long a task that an `interrupt` with no follow-up message left in `input-required` waits for its next message
   * before it fails with `timeout` (it holds its context lane meanwhile). Default {@link DEFAULT_INTERRUPTED_TIMEOUT_MS};
   * `0` waits forever.
   */
  interruptedTimeoutMs?: number;
  /** Clock, ISO string. */
  now?: () => string;
  /** Id source. Default `crypto.randomUUID`. */
  newId?: () => string;
  logger?: RuntimeLogger;
  /**
   * Issuer stored with a bound session and compared for equality when it is read back. Default
   * `<provider id>@<ProviderInfo.sessionFormat ?? "1">`. A binding with another issuer is dropped, never replayed and never released.
   */
  issuer?: string;
  /**
   * How long a context binding may sit unused before it expires (milliseconds, measured from its last bind or resume).
   * An expired binding is deleted and released when its context next resumes, and removed by {@link RunRegistry.sweepBindings}.
   * Default: bindings never expire.
   */
  bindingTtlMs?: number;
  /**
   * Hard maximum age of a context binding in milliseconds, measured from when the bound session was bound (`createdAt`) and
   * NOT extended by use: a conversation used all the time is still reset when its session reaches this age. An over-age
   * binding is deleted and released when its context next resumes (the turn starts fresh) and removed by
   * {@link RunRegistry.sweepBindings}. Independent of `bindingTtlMs` (idle expiry); both may be set. Default: none.
   */
  bindingMaxAgeMs?: number;
  /**
   * At the end of {@link RunRegistry.sweep}, ask the provider (`probeSession`, when it has one) whether each stored
   * binding still resolves and delete the ones it reports `gone`. Default `false`: the first resume attempt decides
   * (`SESSION_NOT_FOUND`).
   */
  validateBindingsOnStart?: boolean;
}

/** Options of {@link RunRegistry.sweep}. */
export interface SweepOptions {
  /**
   * Start the next turn from a core-queued message that is still `queued`. The
   * registry has already claimed it (`queued -> running`, compare-and-set). Without
   * it a swept task cannot continue its queue, so it is failed and the queue dropped.
   */
  replay?: (record: QueuedMessageRecord) => Promise<void>;
  /** Tell the A2A task store that the sweep ended a task, so a client sees it. */
  endTask?: (info: {
    taskId: string;
    contextId: string;
    state: "failed";
    reason: string;
    /** The task owner and tenant from the run record, for owner-scoped task stores. */
    owner: { id: string; kind: string };
    tenant?: string;
  }) => Promise<void>;
}

/** One context's lane: turns of a context run one at a time. */
class ContextLane {
  private running?: RunHandle;
  private readonly waiting: Array<{ handle: RunHandle; start: () => void }> = [];

  get idle(): boolean {
    return !this.running && this.waiting.length === 0;
  }

  admit(handle: RunHandle, start: () => void): void {
    if (!this.running) {
      this.running = handle;
      start();
    } else {
      this.waiting.push({ handle, start });
    }
  }

  /** Drop a handle that is still waiting for the lane. */
  remove(handle: RunHandle): boolean {
    const i = this.waiting.findIndex((w) => w.handle === handle);
    if (i < 0) return false;
    this.waiting.splice(i, 1);
    return true;
  }

  release(handle: RunHandle): void {
    if (this.running !== handle) return;
    this.running = undefined;
    const next = this.waiting.shift();
    if (next) {
      this.running = next.handle;
      next.start();
    }
  }
}

function causeMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class RunRegistry {
  readonly provider: ProviderExecutor;
  readonly store: RunStore;

  private readonly handles = new Map<string, RunHandle>();
  private readonly lanes = new Map<string, ContextLane>();
  /** Tasks whose terminal event is out but whose record write is still in flight. */
  private readonly settling = new Set<string>();
  /** Terminal state of recently ended runs whose terminal record write has not succeeded yet (bounded). */
  private readonly tombstones = new Map<string, { runId: string; state: string }>();
  /** Runs of which an orphan abort was already started (runId). */
  private readonly orphanClaims = new Set<string>();
  private readonly chains = new Map<string, Promise<void>>();
  private replyTokenSeq = 0;
  private readonly background = new Set<Promise<unknown>>();
  /**
   * Per-task bookkeeping the A2A publishers share (which streamed artifacts already have their first chunk, so a reply's new
   * publisher appends instead of replacing). Scoped to this registry, dropped when the run ends and at shutdown.
   */
  readonly publisherState = new Map<string, Set<string>>();
  private readonly settledListeners: Array<(info: { taskId: string; contextId: string }) => void> = [];

  private readonly authorize: Authorizer;
  private readonly interactions: InteractionRuntime;
  private detachedFactory?: DetachedPublisherFactory;
  private readonly abortTimeoutMs: number;
  private readonly steerTimeoutMs: number;
  private readonly replyClaimTtlMs: number;
  private readonly interruptedTimeoutMs: number;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly log: RuntimeLogger;
  private readonly issuerOverride?: string;
  private readonly bindings: ContextBindings;
  private readonly validateBindingsOnStart: boolean;

  constructor(options: RunRegistryOptions) {
    this.provider = options.provider;
    this.store = options.store ?? new InMemoryRunStore();
    this.authorize = options.authorize ?? allowAll;
    this.interactions = options.interactions ?? new InteractionsRuntime({ policy: options.interactionPolicy });
    this.detachedFactory = options.detached;
    this.abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
    this.replyClaimTtlMs = options.replyClaimTtlMs ?? REPLY_CLAIM_TTL_MS;
    this.steerTimeoutMs = options.steerTimeoutMs ?? DEFAULT_STEER_TIMEOUT_MS;
    this.interruptedTimeoutMs = options.interruptedTimeoutMs ?? DEFAULT_INTERRUPTED_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
    this.log = options.logger ?? NOOP_LOGGER;
    this.issuerOverride = options.issuer;
    this.validateBindingsOnStart = options.validateBindingsOnStart === true;
    if (options.bindingTtlMs !== undefined && !(options.bindingTtlMs >= 0)) throw new RangeError("bindingTtlMs must be a number >= 0");
    if (options.bindingMaxAgeMs !== undefined && !(options.bindingMaxAgeMs >= 0)) throw new RangeError("bindingMaxAgeMs must be a number >= 0");
    this.bindings = new ContextBindings({
      store: this.store,
      log: this.log,
      now: () => this.now(),
      issuer: () => this.issuerOf(),
      release: (ref) => this.releaseSession(ref),
      ...(this.provider.probeSession
        ? {
            probe: async (session: SessionRef): Promise<SessionProbe> => {
              const r = await this.bounded(() => this.provider.probeSession!(session));
              return r.ok ? r.value : "unknown";
            },
          }
        : {}),
      authorize: (by, action, target) => this.authorize(by, action, target),
      busy: (contextId) => this.contextBusy(contextId),
      ...(options.bindingTtlMs !== undefined ? { ttlMs: options.bindingTtlMs } : {}),
      ...(options.bindingMaxAgeMs !== undefined ? { maxAgeMs: options.bindingMaxAgeMs } : {}),
    });
    this.interactions.bind?.({
      store: this.store,
      log: this.log,
      now: () => this.now(),
      newId: () => this.newId(),
      expire: (taskId, error, state) => this.expire(taskId, error, state),
      setRunState: (taskId, state) => this.setRunState(taskId, state),
      authorize: (by, action, target) => this.authorize(by, action, target),
      track: (p) => this.track(p),
    });
  }

  /** Move a task's RunRecord to a non-terminal `state` (the interactions runtime: `input-required`, `working`). */
  private setRunState(taskId: string, state: CoreTaskState): void {
    const at = this.now();
    void this.mutateRecord(taskId, (r) => (r && classifyState(r.state) !== "terminal" ? { ...r, state, updatedAt: at } : r));
  }

  // ─── Introspection ────────────────────────────────────────────────────────

  /** The live handle of a task, if any. A handle is live until its terminal event is out. */
  get(taskId: string): RunInteractionHandle | undefined {
    return this.handles.get(taskId);
  }

  /** Is there a live run for this task? */
  isLive(taskId: string): boolean {
    return this.handles.has(taskId);
  }

  /** Called when a run's terminal event is out and its stream is settled (the bus manager cleans up here). */
  onSettled(listener: (info: { taskId: string; contextId: string }) => void): void {
    this.settledListeners.push(listener);
  }

  /** Resolve when every background job (record writes, aborts, orphan aborts) has settled. */
  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Stop every live run's signal with reason `shutdown` WITHOUT a terminal claim: the records stay active for the next start's sweep. */
  async shutdown(): Promise<void> {
    for (const h of this.handles.values()) {
      clearTimeout(h.interruptTimer);
      for (const t of h.turns) if (t.live) t.stop("shutdown");
    }
    await this.drain();
    this.publisherState.clear();
  }

  // ─── execute ──────────────────────────────────────────────────────────────

  /**
   * One SDK `execute()`. The first one for a task creates the run and starts the
   * first turn (in the context's lane); it resolves when the run ends or parks on
   * an interaction. A later one for the same task NEVER starts a second provider
   * call: it is a reply to a pending interaction (consumed by the interactions
   * runtime) or a message delivered by its `delivery` (`queue`, `steer`, `interrupt`;
   * see {@link RunRegistry.deliver}).
   */
  async execute(init: ExecuteInit): Promise<ExecuteOutcome> {
    const existing = this.handles.get(init.taskId);
    if (existing) return this.attach(existing, init);

    const handle: RunHandle = new RunHandle({
      runId: this.newId(),
      taskId: init.taskId,
      contextId: init.contextId,
      owner: init.caller,
      publisher: init.publisher,
      detached: (): RunPublisher | undefined => this.detachedPublisher(handle),
    });
    this.handles.set(init.taskId, handle);
    handle.attachments++;
    const firstTurnId = this.newId();
    handle.recordReady = this.writeRecord(handle, { state: "submitted", turnId: firstTurnId });
    this.lane(init.contextId).admit(handle, () => {
      handle.started = true;
      this.beginTurn(handle, init, firstTurnId);
    });
    return this.leave(handle, await handle.waitBoundary().finally(() => handle.attachments--));
  }

  /**
   * An `execute()` stops waiting. When it leaves at a park and was the last one, nothing consumes
   * the event bus any more: from here core writes the task store itself (`handle.sink`).
   */
  private leave(handle: RunHandle, outcome: "ended" | "parked"): ExecuteOutcome {
    handle.replyAttaching = false;
    if (outcome === "parked" && handle.attachments === 0 && handle.phase === "active") handle.consumerGone = true;
    return outcome;
  }

  private detachedPublisher(handle: RunHandle): RunPublisher | undefined {
    return this.detachedFactory?.({
      taskId: handle.taskId,
      contextId: handle.contextId,
      owner: { id: handle.owner.id, kind: handle.owner.kind },
      publisherState: this.publisherState,
    });
  }

  /**
   * Where core writes what it does to a run nobody is consuming (a timer expiring an interaction,
   * a withdrawal, the next queued interaction): the A2A task store. The server factory sets it.
   */
  setDetachedPublisher(factory: DetachedPublisherFactory | undefined): void {
    this.detachedFactory = factory;
  }

  /**
   * Claim, synchronously, the right to open a reply's stream with the Task snapshot for the current park. Exactly one
   * reply wins per park (until it leaves or the run parks again); every other concurrent reply must NOT publish a
   * snapshot (it would land inside the winner's lifecycle stream and break it) and must not start anything. Returns
   * `false` when the run is not parked or the claim is taken.
   */
  beginReply(taskId: string): number | undefined {
    const h = this.handles.get(taskId);
    if (!h || h.phase !== "active" || !h.parked) return undefined;
    // The holder keeps its claim fresh ({@link touchReply}) while its request is alive; a claim nobody refreshes for the TTL
    // (its request never reached `execute()`, the SDK failed in between) is a wedge and may be taken over.
    if (h.replyAttaching && Date.now() - h.replyClaimedAt < this.replyClaimTtlMs) return undefined;
    h.replyAttaching = true;
    h.replyClaimedAt = Date.now();
    h.replyToken = ++this.replyTokenSeq;
    return h.replyToken;
  }

  /** How often a claim holder should call {@link touchReply}. */
  get replyClaimKeepaliveMs(): number {
    return Math.max(1, Math.floor(this.replyClaimTtlMs / 3));
  }

  /** The holder of claim `token` is still working (its `execute()` entered, `authorize` is pending): push the stale deadline out. */
  touchReply(taskId: string, token: number): void {
    const h = this.handles.get(taskId);
    if (h && h.replyAttaching && h.replyToken === token) h.replyClaimedAt = Date.now();
  }

  /** Release claim `token` (the winner's `execute()` is over). A stale holder cannot release a newer claim. */
  endReply(taskId: string, token: number): void {
    const h = this.handles.get(taskId);
    if (h && h.replyToken === token) h.replyAttaching = false;
  }

  /**
   * A message the A2A task store is about to persist in a task's history: when it answers a SECRET question of the
   * task's presented interaction, the parts to store instead (answers removed). `undefined` when nothing needs hiding.
   */
  async redactReply(taskId: string, messageId: string, parts: readonly CorePart[], isNew: boolean): Promise<readonly CorePart[] | undefined> {
    return this.interactions.redactReply?.({ taskId, handle: this.handles.get(taskId) }, messageId, parts, isNew);
  }

  /** Is the run parked on a presented interaction (so the next message for it is a reply)? */
  isParked(taskId: string): boolean {
    const h = this.handles.get(taskId);
    return !!h && h.phase === "active" && h.parked;
  }

  private async attach(handle: RunHandle, init: ExecuteInit): Promise<ExecuteOutcome> {
    const carries = init.carriesStream !== false;
    const message = this.messageOf(init);
    const intent = resolveDelivery(message.delivery);
    if (carries) handle.attachments++;
    let left = false;
    try {
      if (handle.phase !== "active") {
        this.announce(init, this.rejected(handle.taskId, message.id, "task-ended", "the task is no longer running"), false);
        return "ended";
      }
      // `steer` and `interrupt` NEVER answer an interaction, so they are routed before the reply path (design doc 3.12).
      // A message with no `delivery` stays a reply attempt first; an explicit `queue` is one only when it parses as a
      // reply (otherwise it waits behind the interaction).
      if (intent.kind === "queue" && this.interactions?.handleReply) {
        let consumed = false;
        try {
          consumed = await this.interactions.handleReply(handle, init, { reprompt: !intent.explicit, carriesStream: carries });
        } catch (e) {
          // The contract says never throw. If it does, the message must still not run as a turn.
          this.log.warn("handleReply threw", causeMessage(e));
          consumed = handle.parked && !handle.interruptedPark;
        }
        if (consumed) {
          if (!carries) {
            this.announce(init, this.rejected(handle.taskId, message.id, "reply-ignored", "the interaction is no longer open"), false);
            return "reply";
          }
          if (handle.phase === "active") handle.setPublisher(init.publisher);
          const boundary = await handle.waitBoundary();
          handle.attachments--;
          left = true;
          return this.leave(handle, boundary);
        }
      }
      const outcome = await this.deliverTo(handle, message, init, intent, carries);
      if (outcome.resumed) {
        // This request carries the run on: like a reply, it returns at the next terminal or interrupted state.
        const boundary = await handle.waitBoundary();
        handle.attachments--;
        left = true;
        return this.leave(handle, boundary);
      }
      return outcome.state === "queued" ? "queued" : "delivered";
    } finally {
      if (!left && carries) handle.attachments--;
    }
  }

  /**
   * Deliver a message to a RUNNING task by its `delivery` (`queue`, `steer`, `interrupt`; absent is `queue`) and say what
   * happened, honestly. For a caller that is not an A2A request (the A2A layer goes through {@link execute}, which
   * routes here for a live task). `request` builds the provider request if the message has to run as a later turn.
   *
   * - `queue`: next turn of the task, after the running turn ends (core's lane, persisted as a `QueuedMessageRecord`).
   * - `steer`: the provider's `steer` handler decides (`inserted`, `queued{handle}`, `rejected`). No handler: queued by
   *   core and the result says so (`reason: "steer-unsupported"`). While an interaction is presented a steer waits behind it.
   * - `interrupt`: abort the running turn (`abort(info, "interrupt")`), then the message is the next turn, the task stays
   *   non-terminal. No `abort` handler: queued by core (`reason: "interrupt-unsupported"`). An interrupt with no content
   *   parks the task in `input-required` (marked interrupted) until the next message.
   *
   * Idempotent by `message.id` (and `idempotencyKey`): a duplicate gets the first answer and never delivers twice.
   * Authorized per intent (`authorize(by, "queue" | "steer" | "interrupt", task)`). Never rejects.
   */
  async deliver(taskId: string, message: CoreMessage, by: CoreCaller, request: ExecuteInit["request"]): Promise<DeliveryResult> {
    const handle = this.handles.get(taskId);
    if (!handle) return this.rejected(taskId, message.id, "unknown-task", "no live run for this task");
    let result: DeliveryResult | undefined;
    await this.attach(handle, {
      taskId,
      contextId: handle.contextId,
      caller: by,
      publisher: SILENT_PUBLISHER,
      request,
      message,
      carriesStream: false,
      onDelivery: (r) => {
        result = r;
      },
    });
    return result ?? this.rejected(taskId, message.id, "not-delivered", "the message was not delivered");
  }

  private messageOf(init: ExecuteInit): CoreMessage {
    return (
      init.message ?? {
        id: this.newId(),
        role: "user",
        parts: [],
        from: init.caller,
        at: this.now(),
      }
    );
  }

  private rejected(taskId: string, messageId: string, reason: string, detail?: string): DeliveryResult {
    return { state: "rejected", taskId, messageId, reason, ...(detail ? { detail } : {}) };
  }

  private announce(init: ExecuteInit, result: DeliveryResult, resumed: boolean): void {
    try {
      init.onDelivery?.(result, { resumed });
    } catch (e) {
      this.log.warn("onDelivery threw", causeMessage(e));
    }
  }

  /** Authorize, de-duplicate and dispatch one delivery; the answer goes to `init.onDelivery` exactly once. Never rejects. */
  private async deliverTo(
    handle: RunHandle,
    message: CoreMessage,
    init: ExecuteInit,
    intent: ResolvedDelivery,
    carries: boolean,
  ): Promise<{ state: DeliveryResult["state"]; resumed: boolean }> {
    const taskId = handle.taskId;
    let emitted = false;
    const emit = (result: DeliveryResult, resumed: boolean): void => {
      if (emitted) return;
      emitted = true;
      this.announce(init, result, resumed);
    };
    const finish = (result: DeliveryResult, resumed = false) => {
      emit(result, resumed);
      return { state: result.state, resumed };
    };
    try {
      if (intent.kind === "unsupported") {
        return finish(this.rejected(taskId, message.id, "unsupported-delivery", `unknown delivery "${intent.value}"`));
      }
      const target = { taskId, contextId: handle.contextId, ownerId: handle.owner.id };
      let allowed = false;
      try {
        const verdict = this.authorize(init.caller, intent.kind, target);
        allowed = typeof verdict === "boolean" ? verdict : await verdict;
      } catch (e) {
        this.log.warn("authorize threw; denying", causeMessage(e));
      }
      if (!allowed) return finish(this.rejected(taskId, message.id, "denied", `not allowed to ${intent.kind} this task`));
      if (handle.queueSeq === undefined) {
        const base = await this.maxQueuePosition(taskId);
        if (handle.queueSeq === undefined) handle.queueSeq = base;
      }
      if (handle.phase !== "active" || this.handles.get(taskId) !== handle) {
        return finish(this.rejected(taskId, message.id, "task-ended", "the task is no longer running"));
      }

      // Idempotent by message id (and idempotency key), decided synchronously so concurrent duplicates agree.
      const keys = [message.id, ...(message.idempotencyKey ? [`key:${message.idempotencyKey}`] : [])];
      for (const k of keys) {
        const prior = handle.deliveries.get(k);
        if (prior) return finish(await prior);
      }
      const decision = this.dispatch(handle, message, init, intent.kind, carries, emit);
      const answer = decision.then((d) => d.result);
      for (const k of keys) handle.deliveries.set(k, answer);
      const d = await decision;
      if (!d.cache) for (const k of keys) if (handle.deliveries.get(k) === answer) handle.deliveries.delete(k);
      return finish(d.result, d.resumed);
    } catch (e) {
      this.log.warn("delivery failed", causeMessage(e));
      return finish(this.rejected(taskId, message.id, "internal", causeMessage(e)));
    }
  }

  /** What to do with one authorized message. Never rejects. */
  private async dispatch(
    handle: RunHandle,
    message: CoreMessage,
    init: ExecuteInit,
    kind: DeliveryKind,
    carries: boolean,
    emit: (r: DeliveryResult, resumed: boolean) => void,
  ): Promise<DeliveryDecision> {
    const taskId = handle.taskId;
    try {
      // The same message id again (a retry after a restart, a client that re-sent): it is already ours.
      const prior = (await this.store.listQueued(taskId)).find(
        (r) => r.message.id === message.id && (r.state === "queued" || r.state === "running" || r.state === "done"),
      );
      if (prior) {
        return {
          result: { state: "queued", taskId, messageId: message.id, holder: prior.holder, reason: "duplicate" },
          resumed: false,
          cache: true,
        };
      }
      if (handle.phase !== "active") {
        return { result: this.rejected(taskId, message.id, "task-ended", "the task is no longer running"), resumed: false, cache: false };
      }
      // An interrupted task waits for its next message: whatever the intent, this one is that message.
      if (handle.interruptedPark) return this.continueInterrupted(handle, message, init, carries, emit);
      switch (kind) {
        case "steer":
          return await this.steerIt(handle, message, init);
        case "interrupt":
          return this.interruptIt(handle, message, init, carries, emit);
        default:
          return this.queueIt(handle, message, init);
      }
    } catch (e) {
      this.log.warn("dispatch failed", causeMessage(e));
      return { result: this.rejected(taskId, message.id, "internal", causeMessage(e)), resumed: false, cache: false };
    }
  }

  /** Core's own queue: the message becomes the next turn of the task. `reason` says why when that is not what the caller asked for. */
  private queueIt(handle: RunHandle, message: CoreMessage, init: ExecuteInit, reason?: string): DeliveryDecision {
    this.enqueue(handle, message, init);
    const result: DeliveryResult = {
      state: "queued",
      taskId: handle.taskId,
      messageId: message.id,
      holder: "core",
      position: handle.queue.length,
      ...(reason ? { reason } : {}),
    };
    this.kick(handle);
    return { result, resumed: false, cache: true };
  }

  private async steerIt(handle: RunHandle, message: CoreMessage, init: ExecuteInit): Promise<DeliveryDecision> {
    const taskId = handle.taskId;
    if (handle.parked) {
      return this.queueIt(handle, message, init, "interaction-presented: a steer does not answer an open request, so it waits behind it");
    }
    if (!this.provider.steer) return this.queueIt(handle, message, init, "steer-unsupported: the provider has no steer handler");
    const running = this.liveTurns(handle).find((t) => t.state === "running");
    if (!running) return this.queueIt(handle, message, init, "no-active-turn");

    const view = this.makeView(handle, running);
    // While the handler is in flight the task cannot go terminal: the turn may end under it and the message still needs a turn.
    handle.steering++;
    try {
      return await this.steerSettled(handle, message, init, running, await this.bounded(() => this.provider.steer!(view, message), this.steerTimeoutMs));
    } finally {
      handle.steering--;
      this.advance(handle); // the turn that ended while the steer was in flight can finalize now (or the queued message starts)
    }
  }

  private steerSettled(
    handle: RunHandle,
    message: CoreMessage,
    init: ExecuteInit,
    running: RunTurn,
    r: { ok: true; value: SteerOutcome | undefined } | { ok: false; error: Error },
  ): DeliveryDecision {
    const taskId = handle.taskId;
    if (!r.ok) {
      // Ambiguous: the provider may have taken it. Remembered, so a retry of the same message id cannot deliver twice.
      return { result: this.rejected(taskId, message.id, "steer-failed", r.error.message), resumed: false, cache: true };
    }
    const outcome = r.value as SteerOutcome | undefined;
    if (handle.phase !== "active") {
      return { result: this.rejected(taskId, message.id, "task-ended", "the task ended while the steer was in flight"), resumed: false, cache: true };
    }
    if (outcome && typeof outcome === "object" && outcome.state === "inserted" && !running.live) {
      // The turn the provider folded the message into had ended by the time it answered: it may never have seen it. Err toward
      // delivering: run it as the next turn and say so, never report `inserted` for a message that may be lost.
      return this.queueIt(handle, message, init, "turn-ended-during-steer");
    }
    if (outcome && typeof outcome === "object" && outcome.state === "queued") {
      const held = (outcome as { handle?: unknown }).handle;
      if (typeof held !== "string" || held === "") {
        return {
          result: this.rejected(taskId, message.id, "steer-invalid", "the provider answered queued without a handle"),
          resumed: false,
          cache: true,
        };
      }
      if (!this.registerHeld(taskId, held, message, init)) {
        return {
          result: this.rejected(taskId, message.id, "task-ended", "the provider queued the message after the task ended"),
          resumed: false,
          cache: true,
        };
      }
      return { result: { state: "queued", taskId, messageId: message.id, holder: "provider" }, resumed: false, cache: true };
    }
    const result = deliveryFromSteer(
      taskId,
      message.id,
      outcome && typeof outcome === "object" ? outcome : { state: "rejected", reason: "unsupported", detail: "the provider returned no outcome" },
    );
    // A definitive rejection from the provider changed nothing: a retry may try again.
    return { result, resumed: false, cache: result.state !== "rejected" };
  }

  private interruptIt(
    handle: RunHandle,
    message: CoreMessage,
    init: ExecuteInit,
    carries: boolean,
    emit: (r: DeliveryResult, resumed: boolean) => void,
  ): DeliveryDecision {
    if (!this.provider.abort) {
      return this.queueIt(handle, message, init, "interrupt-unsupported: the provider has no abort handler");
    }
    if (this.liveTurns(handle).length === 0) return this.queueIt(handle, message, init, "no-active-turn");

    // An interrupt MAY preempt an interaction: what is pending settles `canceled`, and the run goes on (decision 1).
    const presented = handle.parked;
    if (presented) {
      handle.settlePending();
      handle.signalResumed();
    }
    const resumed = presented && carries;
    if (resumed) handle.setPublisher(init.publisher);
    const result: DeliveryResult = { state: "interrupted", taskId: handle.taskId, messageId: message.id };
    if (resumed) emit(result, true); // before any event of the next turn
    this.startInterrupt(handle, messageHasContent(message) ? { message, init } : undefined);
    return { result, resumed, cache: true };
  }

  /** The message that continues a task an `interrupt` left waiting: it becomes the next turn. */
  private continueInterrupted(
    handle: RunHandle,
    message: CoreMessage,
    init: ExecuteInit,
    carries: boolean,
    emit: (r: DeliveryResult, resumed: boolean) => void,
  ): DeliveryDecision {
    handle.interruptedPark = false;
    clearTimeout(handle.interruptTimer);
    handle.signalResumed();
    this.enqueue(handle, message, init);
    const result: DeliveryResult = {
      state: "queued",
      taskId: handle.taskId,
      messageId: message.id,
      holder: "core",
      position: handle.queue.length,
      reason: "continues-interrupted-task",
    };
    const cleared = { state: "working" as const, metadata: { interrupted: false } };
    if (carries) {
      handle.setPublisher(init.publisher);
      emit(result, true);
      init.publisher.status(cleared);
    } else {
      handle.sink?.status(cleared);
    }
    this.kick(handle);
    return { result, resumed: carries, cache: true };
  }

  /** Ordering key of the next core-queued record of a run that has none yet: above every stored one. */
  private async maxQueuePosition(taskId: string): Promise<number> {
    try {
      return (await this.store.listQueued(taskId)).reduce((m, r) => Math.max(m, r.position ?? 0), 0);
    } catch {
      return 0;
    }
  }

  /** Queue a message as the next turn of the run and write its record. */
  private enqueue(handle: RunHandle, message: CoreMessage, init: ExecuteInit): void {
    handle.queueSeq = (handle.queueSeq ?? 0) + 1;
    const written = this.track(
      this.store
        .putQueued({
          ...newRecordHeader({ id: init.caller.id, kind: init.caller.kind }, this.now()),
          taskId: handle.taskId,
          contextId: handle.contextId,
          message,
          holder: "core",
          // An ordering key, monotonic per run: the position a caller is told is its live index, which shrinks as turns start.
          position: handle.queueSeq,
          state: "queued",
        })
        .catch((e) => this.log.warn("queued record write failed", causeMessage(e))),
    );
    handle.queue.push({ messageId: message.id, message, init, written, position: handle.queueSeq });
  }

  /** Register a provider-held message (the provider returned `queued` with `handle`). The steering runtime (#109) calls this. */
  registerHeld(taskId: string, heldHandle: string, message?: CoreMessage, init?: ExecuteInit): boolean {
    const handle = this.handles.get(taskId);
    if (!handle || handle.phase !== "active") return false;
    handle.held.set(heldHandle, {
      handle: heldHandle,
      ...(message ? { messageId: message.id, message } : {}),
      ...(init ? { init } : {}),
    });
    if (message) {
      this.track(
        this.store
          .putQueued({
            ...newRecordHeader({ id: message.from.id, kind: message.from.kind }, this.now()),
            taskId,
            contextId: handle.contextId,
            message,
            holder: "provider",
            handle: heldHandle,
            state: "queued",
          })
          .catch((e) => this.log.warn("held record write failed", causeMessage(e))),
      );
    }
    return true;
  }

  // ─── Turns ────────────────────────────────────────────────────────────────

  private lane(contextId: string): ContextLane {
    let l = this.lanes.get(contextId);
    if (!l) {
      l = new ContextLane();
      this.lanes.set(contextId, l);
    }
    return l;
  }

  private releaseLane(handle: RunHandle): void {
    const l = this.lanes.get(handle.contextId);
    if (!l) return;
    l.release(handle);
    if (l.idle) {
      this.lanes.delete(handle.contextId);
      this.bindings.contextIdle(handle.contextId);
    }
  }

  private liveTurns(handle: RunHandle): RunTurn[] {
    return handle.turns.filter((t) => t.live);
  }

  /** Start the next queued turn if the run is idle between turns. */
  private kick(handle: RunHandle): void {
    if (handle.phase !== "active" || !handle.started || handle.stopping) return;
    if (this.liveTurns(handle).length > 0 || handle.queue.length === 0) return;
    const next = handle.queue.shift()!;
    this.beginTurn(handle, next.init, this.newId(), next);
  }

  private beginTurn(handle: RunHandle, init: ExecuteInit, turnId: string, queued?: QueuedTurn): void {
    const turn = new RunTurn(turnId);
    turn.caller = init.caller;
    if (init.tenant !== undefined) turn.tenant = init.tenant;
    if (queued) turn.messageId = queued.messageId;
    handle.turn = turn;
    handle.turns.push(turn);
    handle.awaitingNextTurn = false;
    turn.runSettled = this.runTurn(handle, turn, init, queued).catch((e) =>
      this.log.warn("turn runner failed", causeMessage(e)),
    );
  }

  private async runTurn(
    handle: RunHandle,
    turn: RunTurn,
    init: ExecuteInit,
    queued?: QueuedTurn,
  ): Promise<void> {
    const gone = () => handle.phase !== "active" || !turn.live;
    try {
      if (queued) {
        await queued.written;
        // Atomic claim before provider.run: two instances, or a crash in between, cannot start it twice.
        const won = await this.store.claimQueued(handle.taskId, queued.messageId, "queued", "running");
        if (!won && !gone()) {
          turn.state = "ended";
          this.advance(handle);
          return;
        }
      }
      // The binding is resolved HERE, after the context's lane slot is held (the previous turn of this context has ended, and
      // its `bind` was persisted: writes of one context are serialized), so a turn never reads a stale binding.
      const resolved = await this.bindings.resolve({
        contextId: handle.contextId,
        taskId: handle.taskId,
        caller: init.caller,
        ...(init.tenant !== undefined ? { tenant: init.tenant } : {}),
      });
      if (gone()) return; // canceled, interrupted or expired before the provider was called
      if (resolved.kind === "rejected") {
        // Not another caller's session, and no fresh session on its context id either: the request is refused.
        this.turnEnded(handle, turn, { kind: "rejected", error: resolved.error });
        return;
      }
      await handle.recordReady; // the run's record is written and the turn ordinal base is known
      if (gone()) return;
      let session: SessionRef | undefined = resolved.kind === "session" ? resolved.session : undefined;
      turn.resumed = session !== undefined;
      for (let first = true; ; first = false) {
        turn.session = session;
        const ordinal = this.ordinalOf(handle, turn);
        const request = init.request({ runId: handle.runId, turnId: turn.turnId, turn: ordinal, ...(session ? { session } : {}) });
        turn.request = request;
        turn.state = "running";
        if (first) void this.writeRecord(handle, { state: "working", turnId: turn.turnId, turnCount: ordinal });
        turn.attempt++;
        const view = this.makeView(handle, turn);
        const retry = new Promise<"retry">((resolve) => {
          turn.retrySignal = () => resolve("retry");
        });
        let ran: Promise<void>;
        try {
          ran = Promise.resolve(this.provider.run(request, view));
        } catch (e) {
          ran = Promise.reject(e);
        }
        ran.catch(() => {}); // a call that lost the race to a retry settles on its own; its rejection is not the turn's
        let verdict: "done" | "retry";
        try {
          verdict = await Promise.race([ran.then(() => "done" as const), retry]);
        } catch (e) {
          // `provider.run` threw SessionNotFoundError (or any error whose code is `session-not-found`).
          if (!this.tryRetry(turn, { message: causeMessage(e), code: (e as { code?: string } | undefined)?.code })) throw e;
          verdict = "retry";
        }
        if (verdict === "done") break;
        // The backend cannot resume the bound session: forget it and run the SAME turn once more with no session.
        const lost = session!.ref;
        // The first call must have SETTLED before the second starts: two provider.run calls of one turn would break the lane
        // invariant (one provider session never sees overlapping prompts). Its view is dead already, so late output is dropped.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          ran.then(() => true, () => true),
          new Promise<false>((r) => {
            timer = setTimeout(() => r(false), this.abortTimeoutMs);
          }),
        ]);
        clearTimeout(timer);
        await this.bindings.forget(handle.contextId, lost);
        if (gone()) return;
        if (!settled) {
          this.log.warn(`task ${handle.taskId}: the first provider.run did not settle after session-not-found; not retrying`);
          // Do not abandon the backend: best-effort stop of the call that never settled (bounded, never throws).
          if (this.provider.abort) {
            const info: TaskRunInfo = { runId: handle.runId, turnId: turn.turnId, taskId: handle.taskId, contextId: handle.contextId, session: { ref: lost } };
            this.track(this.bounded(() => this.provider.abort!(info, "cancel")).then((r) => {
              if (!r.ok) this.log.warn(`provider.abort failed (cancel): ${r.error.message}`);
            }));
          }
          this.turnEnded(handle, turn, { kind: "failed", error: turn.lostError ?? { message: "the backend does not know this session", code: SESSION_NOT_FOUND } });
          return;
        }
        this.log.warn(`task ${handle.taskId}: the backend could not resume the bound session; retrying the turn with a fresh one`);
        session = undefined;
      }
    } catch (e) {
      if (!gone() && turn.live) {
        const code = (e as { code?: unknown } | undefined)?.code === SESSION_NOT_FOUND ? SESSION_NOT_FOUND : "internal";
        this.turnEnded(handle, turn, { kind: "failed", error: { message: causeMessage(e), code } });
      } else {
        this.log.debug?.("provider.run settled after the turn was stopped", causeMessage(e));
      }
      return;
    }
    // A late settlement after a cancel, interrupt or expiry is swallowed.
    if (gone() && !(handle.phase === "active" && (turn.state as string) === "ended")) return;
    if (turn.live) {
      // run() resolved without complete/fail/reject.
      this.turnEnded(
        handle,
        turn,
        turn.text
          ? { kind: "completed", result: { text: turn.text } }
          : { kind: "failed", error: { message: "provider returned without a result", code: "internal" } },
        true,
      );
    }
    // Liveness backstop: a provider that forgot its held messages cannot keep the task open forever.
    if (handle.phase === "active" && handle.held.size > 0 && this.liveTurns(handle).length === 0) {
      for (const h of [...handle.held.values()]) {
        this.log.warn("provider.run settled with a held message neither begun nor dropped; treating it as dropped", h.handle);
        this.dropHeld(handle, h.handle, "provider returned without running or dropping it");
      }
    }
  }

  /** A turn ended through the view (or core inferred it). Not live: silently dropped. */
  private turnEnded(handle: RunHandle, turn: RunTurn, outcome: TurnOutcome, inferred = false): void {
    if (handle.phase !== "active" || !turn.live) return;
    void inferred;
    turn.state = "ended";
    if (turn.messageId) {
      this.track(
        this.store
          .claimQueued(handle.taskId, turn.messageId, "running", "done")
          .catch((e) => this.log.warn("queued record update failed", causeMessage(e))),
      );
    }
    handle.lastOutcome = outcome;
    // The session was used until now: a long turn must not look idle to the binding TTL.
    if (turn.session) this.track(this.bindings.touch(handle.contextId, turn.session.ref));
    // More turns follow: what this one produced is output NOW (the terminal status carries only the last turn).
    if (handle.queue.length > 0 || handle.held.size > 0 || handle.steering > 0) this.publishTurnResult(handle, outcome);
    this.advance(handle);
  }

  /** A turn that is not the last one ended: publish its result as non-terminal output. */
  private publishTurnResult(handle: RunHandle, outcome: TurnOutcome): void {
    const pub = handle.sink;
    outcome.published = true;
    if (outcome.kind !== "completed") {
      pub?.status({
        state: "working",
        text: `The previous turn ${outcome.kind === "failed" ? "failed" : "was rejected"}: ${outcome.error.message}`,
      });
      return;
    }
    const r = outcome.result;
    for (const a of r.artifacts ?? []) pub?.artifact(a);
    if (r.parts && r.parts.length > 0) pub?.artifact({ parts: r.parts, lastChunk: true });
    if (r.text || r.usage || r.meta) {
      pub?.status({
        state: "working",
        ...(r.text && !(r.parts && r.parts.length > 0) ? { text: r.text } : {}),
        ...(r.meta ? { metadata: r.meta } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
      });
    }
  }

  /** After a turn: run the next queued turn, or go terminal when nothing is left. */
  private advance(handle: RunHandle): void {
    if (handle.phase !== "active") return;
    if (this.liveTurns(handle).length > 0) return;
    if (handle.queue.length > 0) {
      this.kick(handle);
      return;
    }
    if (handle.held.size > 0 || handle.steering > 0 || handle.awaitingNextTurn || handle.stopping || !handle.lastOutcome) return;
    this.finalize(handle, handle.lastOutcome);
  }

  private finalize(handle: RunHandle, outcome: TurnOutcome): void {
    if (!handle.claim("finalizing")) return;
    const pub = handle.sink;
    if (outcome.kind === "completed") {
      const r = outcome.result;
      if (!outcome.published) for (const a of r.artifacts ?? []) pub?.artifact(a);
      let text: string | undefined;
      if (outcome.published) {
        // Already out as non-terminal output while more turns were pending; the terminal status does not repeat it.
      } else if (r.parts && r.parts.length > 0) pub?.artifact({ parts: r.parts, lastChunk: true });
      else if (r.text) {
        // Text delivered as the final answer. A provider that already streamed it as deltas is
        // expected to call complete({}), so the text is not published twice.
        text = r.text;
      }
      pub?.status({
        state: "completed",
        ...(text ? { text } : {}),
        ...(r.meta && !outcome.published ? { metadata: r.meta } : {}),
        ...(r.usage && !outcome.published ? { usage: r.usage } : {}),
      });
    } else {
      pub?.status({
        state: outcome.kind,
        text: outcome.error.message,
        metadata: {
          ...(outcome.error.meta ?? {}),
          ...(outcome.error.code ? { code: outcome.error.code } : {}),
          ...(outcome.error.retryable !== undefined ? { retryable: outcome.error.retryable } : {}),
        },
      });
    }
    pub?.finished();
    this.closeRun(handle, outcome.kind);
    this.releaseLane(handle);
    handle.settlePending();
    this.persistTerminal(handle, outcome.kind);
  }

  /** The terminal event is out: end the handle and remove it. */
  private closeRun(handle: RunHandle, state: string): void {
    clearTimeout(handle.interruptTimer);
    handle.end(state);
    if (this.handles.get(handle.taskId) === handle) this.handles.delete(handle.taskId);
    this.publisherState.delete(handle.taskId);
    this.settling.add(handle.taskId);
    // In-memory memory of the terminal state, trusted over the store until the terminal write lands:
    // a failed write must not make a finished run look active (a second cancel, an "orphan").
    this.tombstones.delete(handle.taskId);
    this.tombstones.set(handle.taskId, { runId: handle.runId, state });
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest !== undefined) this.tombstones.delete(oldest);
    }
    for (const l of this.settledListeners) {
      try {
        l({ taskId: handle.taskId, contextId: handle.contextId });
      } catch {
        /* a listener must not break the run */
      }
    }
  }

  private persistTerminal(handle: RunHandle, state: string, cancel?: { by: string }): Promise<void> {
    const at = this.now();
    const write = () =>
      this.mutateRecord(handle.taskId, (r) =>
        r
          ? {
              ...r,
              state,
              endedAt: at,
              updatedAt: at,
              ...(cancel ? { cancel: { requestedAt: at, by: cancel.by, ...(r.cancel?.abort ? { abort: r.cancel.abort } : {}) } } : {}),
            }
          : r,
      );
    const p = (async () => {
      let ok = false;
      for (let attempt = 0; attempt < TERMINAL_WRITE_ATTEMPTS && !ok; attempt++) ok = await write();
      if (ok && this.tombstones.get(handle.taskId)?.runId === handle.runId) this.tombstones.delete(handle.taskId);
      if (!ok) this.log.warn(`terminal record write for ${handle.taskId} failed; keeping it in memory as ${state}`);
    })();
    void p.finally(() => this.settling.delete(handle.taskId));
    return p;
  }

  // ─── The provider-facing view ─────────────────────────────────────────────

  private makeView(handle: RunHandle, turn: RunTurn): CoreTaskRun {
    // A view belongs to one `provider.run` call: after a session-not-found retry the first call's view is dead.
    const attempt = turn.attempt;
    const live = () => handle.phase === "active" && turn.live && turn.attempt === attempt;
    const self = this;
    const view: CoreTaskRun = {
      runId: handle.runId,
      turnId: turn.turnId,
      taskId: handle.taskId,
      contextId: handle.contextId,
      signal: turn.controller.signal as CoreTaskRun["signal"],
      progress(text?: string, meta?: Meta) {
        if (!live()) return;
        handle.sink?.status({ state: "working", ...(text ? { text } : {}), ...(meta ? { metadata: meta } : {}) });
      },
      status(update: { meta: Meta }) {
        if (!live()) return;
        const meta = update?.meta;
        if (typeof meta !== "object" || meta === null || Object.keys(meta).length === 0) return;
        handle.sink?.status({ state: "working", metadata: meta });
      },
      event(e: CoreEvent) {
        if (!live()) return;
        turn.observable = true;
        if (e.type === "text") turn.text += e.text;
        handle.sink?.event(e);
      },
      artifact(a: CoreArtifact) {
        if (!live()) return;
        turn.observable = true;
        handle.sink?.artifact(a);
      },
      ask(request: CoreInteractionRequest, options?: AskOptions): Promise<CoreInteractionResult> {
        if (!live()) return Promise.resolve({ outcome: "canceled" });
        turn.observable = true;
        if (!self.interactions) {
          return Promise.resolve({ outcome: "unavailable", reason: "interactions are not enabled", code: "interactions-disabled" });
        }
        return self.interactions.ask(handle, request, options).then((r) => (live() ? r : { outcome: "canceled" as const }));
      },
      bind(session: SessionRef): Promise<BindResult> {
        if (!live()) return Promise.resolve("dropped"); // a late bind from an aborted or stale view is dropped silently (it must not resurrect a discarded session, nor throw into dead code)
        assertBindable(session);
        turn.session = session;
        turn.observable = true; // a session was established: a replay would not be of the same turn
        return self.bindSession(handle, turn, session);
      },
      reportUsage(reading: CoreUsage): Promise<CoreUsage> {
        if (reading?.scope !== "cumulative") return Promise.resolve(reading);
        if (!live()) return Promise.resolve(unknownUsageDelta(reading));
        return self.track(
          self.bindings.reportUsage({
            contextId: handle.contextId,
            caller: turn.caller ?? handle.owner,
            ...(turn.tenant !== undefined ? { tenant: turn.tenant } : {}),
            ...(turn.session ? { ref: turn.session.ref } : {}),
            reading,
          }),
        );
      },
      race<T>(work: Promise<T>): Promise<T | typeof CANCELED> {
        return turn.race(work);
      },
      complete(result: CoreResult) {
        if (turn.attempt !== attempt) return;
        self.turnEnded(handle, turn, { kind: "completed", result });
      },
      fail(error: CoreError) {
        if (turn.attempt !== attempt) return;
        if (live() && self.tryRetry(turn, error)) return; // session-not-found: the runner retries the same turn once
        self.turnEnded(handle, turn, { kind: "failed", error });
      },
      reject(reason: CoreError) {
        if (turn.attempt !== attempt) return;
        if (live() && self.tryRetry(turn, reason)) return;
        self.turnEnded(handle, turn, { kind: "rejected", error: reason });
      },
      beginHeldTurn(heldHandle: string): CoreTaskRun {
        if (handle.phase !== "active") return self.deadView(handle);
        const entry = handle.held.get(heldHandle);
        if (!entry) throw new Error(`unknown held message handle: ${heldHandle}`);
        handle.held.delete(heldHandle);
        const heldTurn = new RunTurn(self.newId());
        heldTurn.state = "running";
        if (entry.messageId) heldTurn.messageId = entry.messageId;
        heldTurn.session = turn.session;
        if (turn.caller) heldTurn.caller = turn.caller;
        if (turn.tenant !== undefined) heldTurn.tenant = turn.tenant;
        handle.turn = heldTurn;
        handle.turns.push(heldTurn);
        if (entry.messageId) {
          self.track(
            self.store
              .claimQueued(handle.taskId, entry.messageId, "queued", "running")
              .catch((e) => self.log.warn("held record update failed", causeMessage(e))),
          );
        }
        void self.writeRecord(handle, { state: "working", turnId: heldTurn.turnId, turnCount: self.ordinalOf(handle, heldTurn) });
        return self.makeView(handle, heldTurn);
      },
      dropHeld(heldHandle: string) {
        if (handle.phase !== "active") return;
        self.dropHeld(handle, heldHandle, "dropped by the provider");
      },
      settleSteer(heldHandle: string, outcome: "inserted" | "dropped" | "requeue") {
        if (handle.phase !== "active") return; // after a cancel the held records are already dropped
        if (outcome === "requeue") self.requeueHeld(handle, heldHandle);
        else self.settleSteer(handle, heldHandle, outcome);
      },
    };
    return view;
  }

  /** A view that drops everything: handed out after the run is gone. */
  private deadView(handle: RunHandle): CoreTaskRun {
    const dead = new RunTurn(this.newId());
    dead.stop("cancel");
    const gone = this.makeView(handle, dead);
    return gone;
  }

  /**
   * The real delivery of a provider-held steer, learned after the fact. `inserted`: the message was folded into a turn that
   * was running (its record is `done`). `dropped`: it was never delivered (record `dropped`). Either way the handle is no
   * longer held, so the task may go terminal. Idempotent (a handle that is not held is ignored).
   */
  /**
   * `settleSteer(handle, "requeue")`: the provider cannot deliver a message it held (its backend process is ending) but the
   * message must not be lost. Core takes it over as a core-queued message: the record becomes `queued` / holder `core` with
   * an ordering position AHEAD of everything queued (it was sent before whatever arrived with the interrupt), and the task
   * runs it as its next turn. Idempotent: a handle that is not held is ignored, and a message that is queued already is not
   * queued twice.
   */
  private requeueHeld(handle: RunHandle, heldHandle: string): void {
    const entry = handle.held.get(heldHandle);
    if (!entry) return;
    handle.held.delete(heldHandle);
    const { message, init, messageId } = entry;
    if (!messageId || !message || !init) {
      // Registered without the message (a runtime-internal registration): there is nothing core could run.
      this.log.warn("settleSteer(requeue): the held message is not known to core; treating it as dropped", heldHandle);
      this.advance(handle);
      return;
    }
    if (handle.queue.some((q) => q.messageId === messageId)) {
      this.advance(handle);
      return;
    }
    const first = handle.queue[0];
    const position = first?.position !== undefined ? first.position - 1 : (handle.queueSeq = (handle.queueSeq ?? 0) + 1);
    const taskId = handle.taskId;
    const written = this.track(
      this.store
        .listQueued(taskId)
        .then((records) => {
          const prior = records.find((r) => r.message.id === messageId);
          const base: QueuedMessageRecord = prior ?? {
            ...newRecordHeader({ id: message.from.id, kind: message.from.kind }, this.now()),
            taskId,
            contextId: handle.contextId,
            message,
            holder: "provider",
            state: "queued",
          };
          const { handle: _gone, ...rest } = base;
          void _gone;
          return this.store.putQueued({ ...rest, holder: "core", position, state: "queued", updatedAt: this.now() });
        })
        .catch((e) => this.log.warn("requeued record write failed", causeMessage(e))),
    );
    handle.queue.unshift({ messageId, message, init, written, position });
    this.advance(handle);
  }

  private settleSteer(handle: RunHandle, heldHandle: string, outcome: "inserted" | "dropped"): void {
    const entry = handle.held.get(heldHandle);
    if (!entry) return;
    handle.held.delete(heldHandle);
    if (entry.messageId) {
      this.track(
        this.store
          .claimQueued(handle.taskId, entry.messageId, "queued", outcome === "inserted" ? "done" : "dropped", outcome === "inserted" ? undefined : "settled as dropped by the provider")
          .catch((e) => this.log.warn("held record update failed", causeMessage(e))),
      );
    }
    this.advance(handle);
  }

  private dropHeld(handle: RunHandle, heldHandle: string, why: string): void {
    const entry = handle.held.get(heldHandle);
    if (!entry) return;
    handle.held.delete(heldHandle);
    if (entry.messageId) {
      this.track(
        this.store
          .claimQueued(handle.taskId, entry.messageId, "queued", "dropped", why)
          .catch((e) => this.log.warn("held record update failed", causeMessage(e))),
      );
    }
    this.advance(handle);
  }

  /**
   * The provider reported that the session it was given cannot be resumed (`SESSION_NOT_FOUND`). Retry the SAME turn once
   * with no session, but only when that is safe and not a loop: the turn started with a stored binding, no retry was
   * used yet, and the turn has published nothing a replay would repeat. Returns `true` when the retry was taken (the turn
   * runner wakes and starts the second call); `false` leaves the failure to end the turn as it is.
   */
  private tryRetry(turn: RunTurn, error: { code?: string; message?: string }): boolean {
    if (error.code !== SESSION_NOT_FOUND) return false;
    if (!turn.resumed || turn.retried || turn.observable || !turn.live || !turn.retrySignal) return false;
    turn.retried = true;
    turn.lostError = { message: error.message ?? "the backend does not know this session", code: SESSION_NOT_FOUND };
    turn.retrySignal();
    return true;
  }

  /** Persist `run.bind` for the turn (validated by the caller). */
  private bindSession(handle: RunHandle, turn: RunTurn, session: SessionRef): Promise<BindResult> {
    return this.track(
      this.bindings.bind({
        contextId: handle.contextId,
        caller: turn.caller ?? handle.owner,
        ...(turn.tenant !== undefined ? { tenant: turn.tenant } : {}),
        session,
        seq: turn.seq,
      }),
    );
  }

  /** `provider.release`, bounded; never rejects. */
  private async releaseSession(ref: string): Promise<void> {
    if (!this.provider.release) return;
    const r = await this.bounded(() => this.provider.release!({ ref }));
    if (!r.ok) this.log.warn(`provider.release failed: ${r.error.message}`);
  }

  /** Does this process have a run for the context (live, parked, adopted or waiting in the lane)? */
  private contextBusy(contextId: string): boolean {
    if (this.lanes.has(contextId)) return true;
    for (const h of this.handles.values()) if (h.contextId === contextId) return true;
    return false;
  }

  /**
   * Remove the bindings that were last used longer ago than `olderThanMs` (default `bindingTtlMs`; with neither nothing is
   * removed) and whose context has no non-terminal run. A binding of a context with a live, parked or orphaned run is
   * never removed, whatever its age. Calls `provider.release` for what it removes.
   */
  sweepBindings(options: { olderThanMs?: number } = {}): Promise<BindingSweepReport> {
    return this.track(this.bindings.sweep(options));
  }

  /**
   * Ask the provider's `probeSession` about every stored binding and delete the ones it reports `gone`. Runs at the end
   * of {@link RunRegistry.sweep} when `validateBindingsOnStart` is set.
   */
  validateBindings(): Promise<BindingValidationReport> {
    return this.track(this.bindings.validate());
  }

  /**
   * The issuer stamped on bindings: `RunRegistryOptions.issuer` when given, else `<id>@<sessionFormat ?? "1">` with `%` and `@`
   * escaped in both parts (`%25`, `%40`), so two different (id, format) pairs can never produce the same string. `undefined`
   * when `info()` throws or the id is empty: it matches nothing (see `ContextBindingsOptions.issuer`).
   */
  private issuerOf(): string | undefined {
    if (this.issuerOverride !== undefined) return this.issuerOverride;
    try {
      const i = this.provider.info();
      if (typeof i.id !== "string" || i.id === "") return undefined;
      const esc = (s: string) => s.replace(/%/g, "%25").replace(/@/g, "%40");
      return `${esc(i.id)}@${esc(String(i.sessionFormat ?? "1"))}`;
    } catch {
      return undefined;
    }
  }

  // ─── cancel ───────────────────────────────────────────────────────────────

  /**
   * Cancel a task. Resolves once the `canceled` status is published and persisted;
   * it does NOT wait for the provider's abort (that runs in the background, see the
   * module doc). Never rejects for ordinary reasons: the outcome says why nothing
   * was canceled.
   *
   * @param by       who asks (recorded on the RunRecord)
   * @param publish  builds the publisher for the canceled event when the caller has a bus
   *                 of its own (the SDK's `cancelTask`); defaults to the attached one
   */
  async cancel(taskId: string, by: CoreCaller, publish?: PublisherFactory): Promise<CancelOutcome> {
    const handle = this.handles.get(taskId);
    if (!handle) return this.cancelWithoutHandle(taskId, by, publish);

    const target = { taskId, contextId: handle.contextId, ownerId: handle.owner.id };
    const verdict = this.authorize(by, "cancel", target);
    const allowed = typeof verdict === "boolean" ? verdict : await verdict;
    if (!allowed) return { claimed: false, reason: "denied" };
    // After an async policy the run may have moved on; re-read.
    if (typeof verdict !== "boolean" && this.handles.get(taskId) !== handle) return this.cancel(taskId, by, publish);

    // 2. synchronous claim
    if (!handle.claim("canceling")) return this.refusal(handle);

    // 3. dependents, before any await
    const turns = this.liveTurns(handle);
    const running = turns.find((t) => t.state === "running");
    handle.settlePending();
    this.dropDependents(handle, "task canceled");

    // 4. persist (not awaited yet) and publish exactly one canceled status, then close the stream
    const persisted = this.persistTerminal(handle, "canceled", { by: by.id });
    const pub = publish ? publish({ taskId, contextId: handle.contextId }) : handle.sink;
    pub?.status({ state: "canceled" });
    pub?.finished();
    this.closeRun(handle, "canceled");

    // 5. stop the turns
    for (const t of turns) t.stop("cancel");

    // 6. abort in the background; the lane waits for it
    this.stopBackend(handle, running);

    await persisted;
    return { claimed: true, runId: handle.runId };
  }

  private refusal(handle: RunHandle): CancelOutcome {
    if (handle.phase === "canceling") return { claimed: false, reason: "already-canceling" };
    if (handle.phase === "ended") {
      return { claimed: false, reason: handle.endedState === "canceled" ? "already-canceled" : "already-terminal" };
    }
    return { claimed: false, reason: "terminal-in-progress" };
  }

  /** Cancel when nothing is live: the record decides. */
  private async cancelWithoutHandle(taskId: string, by: CoreCaller, publish?: PublisherFactory): Promise<CancelOutcome> {
    // A run that just ended may still be writing its record: let it land, then read.
    await (this.chains.get(taskId) ?? Promise.resolve());
    // The in-memory tombstone wins over a store that may have failed to take the terminal write.
    const tomb = this.tombstones.get(taskId);
    if (tomb) return { claimed: false, reason: tomb.state === "canceled" ? "already-canceled" : "already-terminal" };
    const rec = await this.store.getRun(taskId);
    if (!rec) return { claimed: false, reason: "unknown-task" };
    if (classifyState(rec.state) === "terminal") {
      return { claimed: false, reason: rec.state === "canceled" ? "already-canceled" : "already-terminal" };
    }
    const verdict = this.authorize(by, "cancel", { taskId, contextId: rec.contextId, ownerId: rec.owner.id });
    if (!(typeof verdict === "boolean" ? verdict : await verdict)) return { claimed: false, reason: "denied" };
    if (this.orphanClaims.has(rec.runId) || this.handles.has(taskId)) return { claimed: false, reason: "already-canceling" };

    // An orphan: active in the store, no live run. Record it, say canceled, stop the backend in the background.
    this.orphanClaims.add(rec.runId);
    await this.markOrphanCanceled(rec, by.id);
    const pub = publish?.({ taskId, contextId: rec.contextId });
    pub?.status({ state: "canceled" });
    pub?.finished();
    this.track(this.abortOrphan(rec, "cancel"));
    return { claimed: true, runId: rec.runId };
  }

  private markOrphanCanceled(rec: RunRecord, by: string): Promise<boolean> {
    const at = this.now();
    return this.mutateRecord(rec.taskId, (r) =>
      r ? { ...r, state: "canceled", endedAt: at, updatedAt: at, cancel: { requestedAt: at, by } } : r,
    );
  }

  /** Drop core-queued and provider-held messages of a run (records say why). */
  private dropDependents(handle: RunHandle, why: string): void {
    const ids = [
      ...handle.queue.map((q) => q.messageId),
      ...[...handle.held.values()].map((h) => h.messageId).filter((m): m is string => !!m),
    ];
    handle.queue.length = 0;
    handle.held.clear();
    for (const id of ids) {
      this.track(
        this.store
          .claimQueued(handle.taskId, id, "queued", "dropped", why)
          .catch((e) => this.log.warn("queued record update failed", causeMessage(e))),
      );
    }
  }

  // ─── interrupt ────────────────────────────────────────────────────────────

  /**
   * Stop the running turn WITHOUT ending the task: the signal aborts with reason
   * `interrupt`, no terminal claim, no `canceled`, the provider's own queue is
   * kept. The task continues with the next turn: `next` (the interrupting message,
   * whose publisher takes over the run's stream) or a message that arrives later. With
   * no `next` the task waits in `input-required`, marked interrupted, until the next
   * message (design doc 3.12). Delivering a message with `delivery: "interrupt"` is
   * {@link RunRegistry.deliver}; this is its primitive.
   */
  async interrupt(taskId: string, by: CoreCaller, next?: ExecuteInit): Promise<InterruptOutcome> {
    const handle = this.handles.get(taskId);
    if (!handle) return { interrupted: false, reason: "unknown-task" };
    const verdict = this.authorize(by, "interrupt", { taskId, contextId: handle.contextId, ownerId: handle.owner.id });
    if (!(typeof verdict === "boolean" ? verdict : await verdict)) return { interrupted: false, reason: "denied" };
    if (handle.phase !== "active") return { interrupted: false, reason: "terminal" };
    const running = this.liveTurns(handle);
    if (running.length === 0 && !handle.awaitingNextTurn && !next) return { interrupted: false, reason: "not-running" };
    if (handle.parked) {
      handle.settlePending();
      handle.signalResumed();
    }
    if (handle.interruptedPark) {
      handle.interruptedPark = false;
      clearTimeout(handle.interruptTimer);
    }
    this.startInterrupt(
      handle,
      next
        ? {
            message: next.message ?? {
              id: this.newId(),
              role: "user",
              parts: [],
              from: next.caller,
              delivery: "interrupt",
              at: this.now(),
            },
            init: next,
            takeStream: true,
          }
        : undefined,
    );
    return { interrupted: true };
  }

  /** Stop the live turns (reason `interrupt`), queue `next` if there is one, and continue (or park) when the provider's abort has settled. */
  private startInterrupt(handle: RunHandle, next?: { message: CoreMessage; init: ExecuteInit; takeStream?: boolean }): void {
    const running = this.liveTurns(handle);
    handle.awaitingNextTurn = true;
    const target = running.find((t) => t.state === "running");
    for (const t of running) t.stop("interrupt");
    if (next) {
      if (next.takeStream) handle.setPublisher(next.init.publisher);
      this.enqueue(handle, next.message, next.init);
    }
    if (target) {
      handle.stopping = true;
      handle.abortTarget = target;
      const aborting = this.runAbort(handle, target, "interrupt").finally(() => {
        handle.stopping = false;
        if (handle.aborting === aborting) handle.aborting = undefined;
        this.afterInterrupt(handle);
      });
      handle.aborting = aborting;
      this.track(aborting);
    } else {
      this.afterInterrupt(handle);
    }
  }

  /** The interrupted turn is stopped: run the next one, or, with nothing to run, park the task until a message arrives. */
  private afterInterrupt(handle: RunHandle): void {
    this.kick(handle);
    if (
      handle.phase === "active" &&
      handle.awaitingNextTurn &&
      !handle.stopping &&
      !handle.interruptedPark &&
      handle.queue.length === 0 &&
      handle.held.size === 0 &&
      this.liveTurns(handle).length === 0
    ) {
      this.enterInterruptedPark(handle);
    }
  }

  /**
   * An `interrupt` with no follow-up content: the turn is stopped and the task waits for direction in `input-required`,
   * marked `interrupted: true` (A2A proposal #2125). It holds its context lane; the next message continues it, and one
   * that never comes fails the task after `interruptedTimeoutMs`.
   */
  private enterInterruptedPark(handle: RunHandle): void {
    handle.interruptedPark = true;
    this.setRunState(handle.taskId, "input-required");
    handle.sink?.status({
      state: "input-required",
      text: "The running turn was interrupted. Send a message to continue the task.",
      metadata: { interrupted: true },
    });
    handle.signalParked();
    if (this.interruptedTimeoutMs > 0) {
      clearTimeout(handle.interruptTimer);
      const timer = setTimeout(() => {
        if (!handle.interruptedPark) return;
        void this.expire(handle.taskId, { message: "The task was interrupted and no message arrived to continue it.", code: "timeout" });
      }, this.interruptedTimeoutMs);
      timer.unref?.();
      handle.interruptTimer = timer;
    }
  }

  // ─── expiry (hook for the interactions runtime, #108) ─────────────────────

  /**
   * End the run because an interaction (or anything else core waits on) expired:
   * the third terminal claim. Exactly one terminal event, like cancel; the state
   * published is `failed` (default) or `canceled`, per policy.
   */
  async expire(taskId: string, error: CoreError, state: "failed" | "canceled" = "failed"): Promise<boolean> {
    const handle = this.handles.get(taskId);
    if (!handle || !handle.claim("expiring")) return false;
    const turns = this.liveTurns(handle);
    const running = turns.find((t) => t.state === "running");
    handle.settlePending();
    this.dropDependents(handle, `task ${state}: ${error.message}`);
    const persisted = this.persistTerminal(handle, state);
    const pub = handle.sink;
    pub?.status({ state, text: error.message, ...(error.code ? { metadata: { code: error.code } } : {}) });
    pub?.finished();
    this.closeRun(handle, state);
    for (const t of turns) t.stop("cancel");
    this.stopBackend(handle, running);
    await persisted;
    return true;
  }

  /**
   * The run is over (cancel or expiry): stop its backend in the background and
   * release the lane only when that has settled. If an interrupt's abort is still
   * in flight, wait for it first and THEN send `abort(cancel)`, so the provider
   * flushes its native queue (the interrupt abort kept it) and the lane never
   * hands the session to the next task while the backend may still be stopping.
   */
  private stopBackend(handle: RunHandle, running: RunTurn | undefined): void {
    if (!handle.started) {
      this.lane(handle.contextId).remove(handle);
      if (this.lanes.get(handle.contextId)?.idle) {
        this.lanes.delete(handle.contextId);
        this.bindings.contextIdle(handle.contextId);
      }
      return;
    }
    const pending = handle.aborting;
    const turn = running ?? (pending ? handle.abortTarget : undefined);
    if (!turn) {
      this.releaseLane(handle);
      return;
    }
    this.track(
      (async () => {
        if (pending) await pending.catch(() => {});
        await this.runAbort(handle, turn, "cancel");
      })().finally(() => this.releaseLane(handle)),
    );
  }

  // ─── abort ────────────────────────────────────────────────────────────────

  /** Run a bounded provider call. Never rejects: `undefined` on failure or timeout. */
  private async bounded<T>(
    fn: () => Promise<T> | T,
    timeoutMs: number = this.abortTimeoutMs,
  ): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(fn),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
    } finally {
      clearTimeout(timer);
    }
  }

  private normalizeOutcome(o: unknown): AbortOutcome {
    const x = (o ?? {}) as Partial<AbortOutcome>;
    return {
      stopped: x.stopped === "confirmed" ? "confirmed" : "unconfirmed",
      session: x.session === "reusable" ? "reusable" : "discard",
    };
  }

  /**
   * Stop the backend of a turn and apply what it reports. Never rejects. With no
   * `abort` handler the provider only honours the signal: core waits (bounded) for
   * `run()` to settle. That proves nothing (`race` wakes on stop, and a provider may
   * return early), so it is recorded `unconfirmed` / `reusable`; only an `abort`
   * handler can yield `confirmed`. Not settling in time is {@link ABORT_FAILED_OUTCOME}.
   */
  private async runAbort(handle: RunHandle, turn: RunTurn, reason: AbortReason): Promise<AbortOutcome> {
    const info: TaskRunInfo = {
      runId: handle.runId,
      turnId: turn.turnId,
      taskId: handle.taskId,
      contextId: handle.contextId,
      ...(turn.session ? { session: turn.session } : {}),
    };
    let outcome: AbortOutcome;
    if (this.provider.abort) {
      const r = await this.bounded(() => this.provider.abort!(info, reason));
      outcome = r.ok ? this.normalizeOutcome(r.value) : { ...ABORT_FAILED_OUTCOME };
      if (!r.ok) this.log.warn(`provider.abort failed (${reason}): ${r.error.message}`);
    } else {
      const r = await this.bounded(() => turn.runSettled);
      outcome = r.ok ? { stopped: "unconfirmed", session: "reusable" } : { ...ABORT_FAILED_OUTCOME };
    }
    await this.applyOutcome(handle.taskId, handle.contextId, turn.session, outcome, reason === "cancel");
    return outcome;
  }

  /** Record an abort outcome and, on `discard`, drop the session binding and release the session. */
  private async applyOutcome(
    taskId: string,
    contextId: string,
    session: SessionRef | undefined,
    outcome: AbortOutcome,
    recordOnRun: boolean,
  ): Promise<void> {
    if (recordOnRun) {
      const at = this.now();
      await this.mutateRecord(taskId, (r) =>
        r ? { ...r, updatedAt: at, cancel: { requestedAt: r.cancel?.requestedAt ?? at, by: r.cancel?.by ?? "unknown", abort: outcome } } : r,
      );
    }
    if (outcome.session === "discard") await this.discardSession(contextId, session);
  }

  private discardSession(contextId: string, session: SessionRef | undefined): Promise<void> {
    return this.bindings.discard(contextId, session?.ref);
  }

  // ─── orphans ──────────────────────────────────────────────────────────────

  /**
   * Ask the provider to stop a run core has no handle for, and apply the outcome.
   * Without an `abortOrphan` handler core cannot stop the backend and cannot trust
   * the session, so the outcome is {@link ABORT_FAILED_OUTCOME}. Never rejects.
   */
  async abortOrphan(record: RunRecord, reason: AbortReason = "cancel"): Promise<AbortOutcome> {
    let session: { ref: string } | undefined;
    try {
      const binding = await this.bindings.peek(record.contextId);
      if (binding?.session) session = { ref: binding.session.ref };
    } catch {
      /* no session known */
    }
    const info: OrphanInfo = {
      runId: record.runId,
      turnId: record.turnId,
      taskId: record.taskId,
      contextId: record.contextId,
      reason,
      ...(session ? { session } : {}),
    };
    let outcome: AbortOutcome = { ...ABORT_FAILED_OUTCOME };
    if (this.provider.abortOrphan) {
      const r = await this.bounded(() => this.provider.abortOrphan!(info));
      outcome = r.ok ? this.normalizeOutcome(r.value) : { ...ABORT_FAILED_OUTCOME };
      if (!r.ok) this.log.warn(`provider.abortOrphan failed: ${r.error.message}`);
    }
    await this.applyOutcome(record.taskId, record.contextId, session, outcome, reason === "cancel");
    return outcome;
  }

  /**
   * The A2A task store was just told a task is `canceled` (the SDK does that itself,
   * without calling the executor, when a task has no event bus). If core's record
   * says the run is active and nothing here is running it, the backend is still
   * working: stop it through `abortOrphan`. Resolves `true` when an orphan abort was
   * started (it then runs in the background), `false` when there was nothing to do.
   */
  handleStoreCancel(taskId: string): Promise<boolean> {
    return this.track(this.storeCancel(taskId));
  }

  private async storeCancel(taskId: string): Promise<boolean> {
    const live = this.handles.get(taskId);
    if (live) {
      // The store says canceled while core still runs it: make the run agree (one terminal event, abort).
      if (live.phase !== "active") return false;
      return (await this.cancel(taskId, { id: "store", kind: "service" })).claimed;
    }
    if (this.settling.has(taskId) || this.tombstones.has(taskId)) return false;
    const rec = await this.store.getRun(taskId);
    if (this.tombstones.has(taskId)) return false;
    if (!rec || classifyState(rec.state) === "terminal") return false;
    if (this.handles.has(taskId) || this.orphanClaims.has(rec.runId)) return false;
    this.orphanClaims.add(rec.runId);
    await this.markOrphanCanceled(rec, "store");
    this.track(this.abortOrphan(rec, "cancel"));
    return true;
  }

  /**
   * Startup sweep over non-terminal run records. Restart policy (design doc 3.6):
   *
   * - a record with a live handle is left alone; `interrupted` records
   *   (`input-required`, `auth-required`) are left to the interactions runtime;
   *   a state core does not know (`classifyState` is `unknown`) is reported and
   *   never assumed finished;
   * - an `active` record is an orphan: `abortOrphan({reason: "cancel"})` is asked
   *   once and its outcome applied (binding and release on `discard`);
   * - core-queued messages replay only from `queued`, claimed `queued -> running`
   *   atomically, and only when the session is reusable and `options.replay`
   *   exists; a `running` one is an orphaned turn and is NEVER replayed;
   * - provider-held messages are marked `dropped` only when the orphan abort was
   *   `confirmed`, otherwise `unknown`, and reported;
   * - when the task cannot continue it is ended `failed` (and `options.endTask`
   *   tells the A2A store); its remaining queue is dropped and reported.
   */
  async sweep(options: SweepOptions = {}): Promise<SweepReport> {
    const entries: SweepEntry[] = [];
    const records = await this.store.listNonTerminalRuns();

    // One abortOrphan per orphaned run, a few at a time (each is bounded by the abort timeout).
    const eligible = records.filter(
      (r) => !this.handles.has(r.taskId) && classifyState(r.state) === "active" && !this.orphanClaims.has(r.runId),
    );
    for (const r of eligible) this.orphanClaims.add(r.runId);
    const outcomes = new Map<string, AbortOutcome>();
    let nextIndex = 0;
    await Promise.all(
      Array.from({ length: Math.min(SWEEP_CONCURRENCY, eligible.length) }, async () => {
        while (nextIndex < eligible.length) {
          const rec = eligible[nextIndex++];
          outcomes.set(rec.runId, await this.abortOrphan(rec, "cancel"));
        }
      }),
    );

    for (const rec of records) {
      const entry: SweepEntry = {
        taskId: rec.taskId,
        runId: rec.runId,
        action: "orphan-aborted",
        queued: { replayed: [], dropped: [], unknown: [] },
      };
      entries.push(entry);
      if (this.handles.has(rec.taskId)) {
        entry.action = "skipped-live";
        continue;
      }
      const cls = classifyState(rec.state);
      if (cls === "unknown") {
        entry.action = "skipped-unknown-state";
        this.log.warn(`run ${rec.runId} has a state core does not know ("${rec.state}"); not assuming it finished`);
        continue;
      }
      if (cls === "interrupted") {
        await this.sweepInterrupted(rec, entry, options);
        continue;
      }
      const outcome = outcomes.get(rec.runId);
      if (!outcome) continue; // already claimed by another orphan path
      entry.abort = { stopped: outcome.stopped, session: outcome.session };

      const queued = await this.store.listQueued(rec.taskId);
      const coreQueued: QueuedMessageRecord[] = [];
      for (const q of queued) {
        const id = q.message.id;
        if (q.holder === "provider" && (q.state === "queued" || q.state === "running")) {
          const to = outcome.stopped === "confirmed" ? "dropped" : "unknown";
          const reason =
            to === "dropped" ? "provider confirmed the orphan stopped" : "provider did not confirm; state unknown";
          await this.store.claimQueued(rec.taskId, id, q.state, to, reason);
          (to === "dropped" ? entry.queued.dropped : entry.queued.unknown).push(id);
        } else if (q.holder === "core" && q.state === "running") {
          // An orphaned turn: it may already have had side effects. Never replayed.
          await this.store.claimQueued(rec.taskId, id, "running", "dropped", "was running at restart; never replayed");
          entry.queued.dropped.push(id);
        } else if (q.holder === "core" && q.state === "queued") {
          coreQueued.push(q);
        }
      }

      const canContinue = outcome.session === "reusable" && !!options.replay && coreQueued.length > 0;
      if (canContinue) {
        entry.action = "turn-failed-queue-continued";
        for (const q of coreQueued) {
          if (await this.store.claimQueued(rec.taskId, q.message.id, "queued", "running")) {
            entry.queued.replayed.push(q.message.id);
            await options.replay!({ ...q, state: "running" });
          }
        }
        continue;
      }

      // The task cannot continue: fail it, drop and report the rest of its queue.
      entry.action = "task-failed";
      for (const q of coreQueued) {
        await this.store.claimQueued(rec.taskId, q.message.id, "queued", "dropped", "task failed by the restart sweep");
        entry.queued.dropped.push(q.message.id);
      }
      const reason = "the run was interrupted by a restart";
      const at = this.now();
      await this.mutateRecord(rec.taskId, (r) => (r ? { ...r, state: "failed", endedAt: at, updatedAt: at } : r));
      try {
        await options.endTask?.({
          taskId: rec.taskId,
          contextId: rec.contextId,
          state: "failed",
          reason,
          owner: rec.owner,
          ...(rec.tenant ? { tenant: rec.tenant } : {}),
        });
      } catch (e) {
        this.log.warn("endTask failed", causeMessage(e));
      }
    }
    const report: SweepReport = { entries };
    if (this.validateBindingsOnStart) report.bindings = await this.bindings.validate();
    return report;
  }

  /**
   * An `interrupted` record (`input-required`, `auth-required`) with no live run: the process
   * restarted while the task waited on a person. Core never leaves such a task hanging:
   *
   * - interactions that carry a provider `handle` go to `provider.reattach` when it exists:
   *   core re-creates the run (live handle, lane held, restored interactions in front of it,
   *   expiry timers re-armed) and the provider re-asks with each handle to continue its turn;
   * - everything else (no `reattach`, no handle, or the provider rejects): the pending records
   *   become `expired` and the task is failed with "server restarted".
   */
  private async sweepInterrupted(rec: RunRecord, entry: SweepEntry, options: SweepOptions): Promise<void> {
    const reason = "server restarted";
    const all = await this.store.listPending(rec.taskId).catch((e) => {
      this.log.warn("listing pending interactions failed", causeMessage(e));
      return [] as PendingInteraction[];
    });
    const open = all.filter((p) => isOpenInteractionState(p.state));
    const reattachable = open.filter((p) => p.handle !== undefined);

    const failTask = async (): Promise<void> => {
      entry.action = "interrupted-failed";
      const at = this.now();
      await this.mutateRecord(rec.taskId, (r) =>
        r && classifyState(r.state) !== "terminal" ? { ...r, state: "failed", endedAt: at, updatedAt: at } : r,
      );
      try {
        await options.endTask?.({
          taskId: rec.taskId,
          contextId: rec.contextId,
          state: "failed",
          reason,
          owner: rec.owner,
          ...(rec.tenant ? { tenant: rec.tenant } : {}),
        });
      } catch (e) {
        this.log.warn("endTask failed", causeMessage(e));
      }
    };

    if (this.provider.reattach && this.interactions.restore && reattachable.length > 0) {
      for (const p of open.filter((x) => x.handle === undefined)) await this.expirePending(p);
      const handle = await this.adopt(rec);
      this.interactions.restore(handle, reattachable);
      const r = await this.bounded(() => this.provider.reattach!(reattachable, { view: (taskId) => this.viewFor(taskId) }));
      if (r.ok) {
        entry.action = "interrupted-reattached";
        return;
      }
      this.log.warn(`provider.reattach failed: ${r.error.message}`);
      await this.expire(rec.taskId, { message: reason, code: "unavailable" });
      await this.drain();
      for (const p of reattachable) await this.expirePending(p);
      await failTask();
      return;
    }

    for (const p of open) await this.expirePending(p);
    await failTask();
  }

  /** A pending interaction that can no longer be answered. */
  private async expirePending(p: PendingInteraction): Promise<void> {
    await this.store
      .putPending({ ...p, state: "expired", updatedAt: this.now(), result: { outcome: "expired" } })
      .catch((e) => this.log.warn("pending record write failed", causeMessage(e)));
  }

  /**
   * Re-create the live run of an interrupted task after a restart: no provider call is made (the
   * provider's reattach resumes its own turn), but the handle, the running turn, the context lane
   * and the session are as if the run had never stopped, so cancel, expiry and replies work.
   */
  private async adopt(rec: RunRecord): Promise<RunHandle> {
    const handle: RunHandle = new RunHandle({
      runId: rec.runId,
      taskId: rec.taskId,
      contextId: rec.contextId,
      owner: { id: rec.owner.id, kind: rec.owner.kind },
      detached: (): RunPublisher | undefined => this.detachedPublisher(handle),
    });
    handle.started = true;
    handle.turnBase = Math.max(0, (rec.turnCount ?? 1) - 1); // the adopted turn is the one the record counts
    handle.consumerGone = true; // nobody is attached after a restart
    const turn = new RunTurn(rec.turnId);
    turn.state = "running";
    turn.caller = { id: rec.owner.id, kind: rec.owner.kind };
    if (rec.tenant) turn.tenant = rec.tenant;
    const binding = await this.bindings.peek(rec.contextId);
    if (binding?.session) turn.session = { ref: binding.session.ref, ...(binding.session.meta ? { meta: binding.session.meta } : {}) };
    handle.turn = turn;
    handle.turns.push(turn);
    this.handles.set(rec.taskId, handle);
    this.lane(rec.contextId).admit(handle, () => {});
    return handle;
  }

  /** The provider-facing view of a live run's current turn (what `reattach` gets to continue it). */
  viewFor(taskId: string): CoreTaskRun | undefined {
    const h = this.handles.get(taskId);
    return h?.turn ? this.makeView(h, h.turn) : undefined;
  }

  // ─── Records ──────────────────────────────────────────────────────────────

  private track<T>(p: Promise<T>): Promise<T> {
    this.background.add(p);
    void p.then(
      () => this.background.delete(p),
      () => this.background.delete(p),
    );
    return p;
  }

  /** Read-modify-write one task's record; serialized per task and never rejects. */
  private mutateRecord(taskId: string, fn: (r: RunRecord | undefined) => RunRecord | undefined): Promise<boolean> {
    const prev = this.chains.get(taskId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const updated = fn(await this.store.getRun(taskId));
      if (updated) await this.store.putRun(updated);
      return true;
    }).catch((e) => {
      this.log.warn("run record write failed", causeMessage(e));
      return false;
    });
    const link = next.then(() => {});
    this.chains.set(taskId, link);
    this.track(next);
    void link.then(() => {
      if (this.chains.get(taskId) === link) this.chains.delete(taskId);
    });
    return next;
  }

  /** Create the run's record, or move it to `state` / `turnId`. */
  private writeRecord(handle: RunHandle, patch: { state: string; turnId: string; turnCount?: number }): Promise<boolean> {
    const at = this.now();
    return this.mutateRecord(handle.taskId, (r) => {
      if (r && r.runId === handle.runId) {
        if (classifyState(r.state) === "terminal") return r;
        return { ...r, ...patch, updatedAt: at };
      }
      // A record of an earlier run of the same task that never ended (a restart continued the task under a new run): the
      // ordinal of its turns keeps counting.
      if (r && classifyState(r.state) !== "terminal" && typeof r.turnCount === "number") handle.turnBase = r.turnCount;
      return {
        ...newRecordHeader({ id: handle.owner.id, kind: handle.owner.kind }, at),
        runId: handle.runId,
        taskId: handle.taskId,
        contextId: handle.contextId,
        turnId: patch.turnId,
        state: patch.state,
        startedAt: at,
        ...(patch.turnCount !== undefined ? { turnCount: patch.turnCount } : {}),
      };
    });
  }

  /** The 1-based ordinal of a turn within its task: the turns that ran before this handle existed plus its place among the handle's. */
  private ordinalOf(handle: RunHandle, turn: RunTurn): number {
    return handle.turnBase + handle.turns.indexOf(turn) + 1;
  }
}
