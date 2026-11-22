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
  newRecordHeader,
  type AbortOutcome,
  type AbortReason,
  type AskOptions,
  type ContextBinding,
  type CoreArtifact,
  type CoreCaller,
  type CoreError,
  type CoreEvent,
  type CoreInteractionRequest,
  type CoreInteractionResult,
  type CoreMessage,
  type CoreResult,
  type CoreTaskRun,
  type Meta,
  type OrphanInfo,
  type ProviderExecutor,
  type QueuedMessageRecord,
  type RunRecord,
  type SessionRef,
  type TaskRunInfo,
} from "../model/index.js";
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

/** Builds the publisher for a task when the caller (the SDK's `cancelTask`) only has a bus. */
export type PublisherFactory = (ids: { taskId: string; contextId: string }) => RunPublisher;

export interface RunRegistryOptions {
  provider: ProviderExecutor;
  /** Default: a new {@link InMemoryRunStore}. */
  store?: RunStore;
  /** Default: {@link allowAll}. */
  authorize?: Authorizer;
  /** The interactions runtime (issue #108). Absent: `run.ask` answers `unavailable`. */
  interactions?: InteractionRuntime;
  /** Upper bound for `abort` / `abortOrphan` / `release`. Default {@link DEFAULT_ABORT_TIMEOUT_MS}. */
  abortTimeoutMs?: number;
  /** Clock, ISO string. */
  now?: () => string;
  /** Id source. Default `crypto.randomUUID`. */
  newId?: () => string;
  logger?: RuntimeLogger;
  /** Opaque issuer stored with a bound session. Default `provider.info().id` + version. */
  issuer?: string;
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
  private readonly background = new Set<Promise<unknown>>();
  private readonly settledListeners: Array<(info: { taskId: string; contextId: string }) => void> = [];

  private readonly authorize: Authorizer;
  private readonly interactions?: InteractionRuntime;
  private readonly abortTimeoutMs: number;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly log: RuntimeLogger;
  private readonly issuerOverride?: string;

  constructor(options: RunRegistryOptions) {
    this.provider = options.provider;
    this.store = options.store ?? new InMemoryRunStore();
    this.authorize = options.authorize ?? allowAll;
    this.interactions = options.interactions;
    this.abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
    this.log = options.logger ?? NOOP_LOGGER;
    this.issuerOverride = options.issuer;
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
    for (const h of this.handles.values()) for (const t of h.turns) if (t.live) t.stop("shutdown");
    await this.drain();
  }

  // ─── execute ──────────────────────────────────────────────────────────────

  /**
   * One SDK `execute()`. The first one for a task creates the run and starts the
   * first turn (in the context's lane); it resolves when the run ends or parks on
   * an interaction. A later one for the same task NEVER starts a second provider
   * call: it is a reply to a pending interaction (consumed by the interactions
   * runtime) or, by the default delivery, a message queued as the next turn.
   */
  async execute(init: ExecuteInit): Promise<ExecuteOutcome> {
    const existing = this.handles.get(init.taskId);
    if (existing) return this.attach(existing, init);

    const handle = new RunHandle({
      runId: this.newId(),
      taskId: init.taskId,
      contextId: init.contextId,
      owner: init.caller,
      publisher: init.publisher,
    });
    this.handles.set(init.taskId, handle);
    handle.attachments++;
    const firstTurnId = this.newId();
    this.writeRecord(handle, { state: "submitted", turnId: firstTurnId });
    this.lane(init.contextId).admit(handle, () => {
      handle.started = true;
      this.beginTurn(handle, init, firstTurnId);
    });
    try {
      return await handle.waitBoundary();
    } finally {
      handle.attachments--;
    }
  }

  private async attach(handle: RunHandle, init: ExecuteInit): Promise<ExecuteOutcome> {
    handle.attachments++;
    try {
      if (this.interactions?.handleReply) {
        const consumed = await this.interactions.handleReply(handle, init);
        if (consumed) {
          if (handle.phase === "active") handle.publisher = init.publisher;
          return await handle.waitBoundary();
        }
      }
      if (handle.phase !== "active") return "ended";
      // Default delivery: the message becomes the next turn of this task. It never runs now.
      handle.publisher = init.publisher;
      const message: CoreMessage = init.message ?? {
        id: this.newId(),
        role: "user",
        parts: [],
        from: init.caller,
        at: this.now(),
      };
      this.enqueue(handle, message, init);
      this.kick(handle);
      return "queued";
    } finally {
      handle.attachments--;
    }
  }

  /** Queue a message as the next turn of the run and write its record. */
  private enqueue(handle: RunHandle, message: CoreMessage, init: ExecuteInit): void {
    const written = this.track(
      this.store
        .putQueued({
          ...newRecordHeader({ id: init.caller.id, kind: init.caller.kind }, this.now()),
          taskId: handle.taskId,
          contextId: handle.contextId,
          message,
          holder: "core",
          position: handle.queue.length + 1,
          state: "queued",
        })
        .catch((e) => this.log.warn("queued record write failed", causeMessage(e))),
    );
    handle.queue.push({ messageId: message.id, message, init, written });
  }

  /** Register a provider-held message (the provider returned `queued` with `handle`). The steering runtime (#109) calls this. */
  registerHeld(taskId: string, heldHandle: string, message?: CoreMessage): boolean {
    const handle = this.handles.get(taskId);
    if (!handle || handle.phase !== "active") return false;
    handle.held.set(heldHandle, { handle: heldHandle, ...(message ? { messageId: message.id } : {}) });
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
    if (l.idle) this.lanes.delete(handle.contextId);
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
      const binding = await this.store.getBinding(handle.contextId).catch(() => undefined);
      if (gone()) return; // canceled, interrupted or expired before the provider was called
      const session: SessionRef | undefined = binding?.session
        ? { ref: binding.session.ref, ...(binding.session.meta ? { meta: binding.session.meta } : {}) }
        : undefined;
      turn.session = session;
      const request = init.request({ runId: handle.runId, turnId: turn.turnId, ...(session ? { session } : {}) });
      turn.request = request;
      turn.state = "running";
      this.writeRecord(handle, { state: "working", turnId: turn.turnId });
      const view = this.makeView(handle, turn);
      await this.provider.run(request, view);
    } catch (e) {
      if (!gone() && turn.live) {
        this.turnEnded(handle, turn, { kind: "failed", error: { message: causeMessage(e), code: "internal" } });
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
    this.advance(handle);
  }

  /** After a turn: run the next queued turn, or go terminal when nothing is left. */
  private advance(handle: RunHandle): void {
    if (handle.phase !== "active") return;
    if (this.liveTurns(handle).length > 0) return;
    if (handle.queue.length > 0) {
      if (handle.lastOutcome && handle.lastOutcome.kind !== "completed") {
        handle.publisher?.status({
          state: "working",
          text: `The previous turn ${handle.lastOutcome.kind === "failed" ? "failed" : "was rejected"}: ${handle.lastOutcome.error.message}`,
        });
      }
      this.kick(handle);
      return;
    }
    if (handle.held.size > 0 || handle.awaitingNextTurn || handle.stopping || !handle.lastOutcome) return;
    this.finalize(handle, handle.lastOutcome);
  }

  private finalize(handle: RunHandle, outcome: TurnOutcome): void {
    if (!handle.claim("finalizing")) return;
    const pub = handle.publisher;
    if (outcome.kind === "completed") {
      const r = outcome.result;
      for (const a of r.artifacts ?? []) pub?.artifact(a);
      let text: string | undefined;
      if (r.parts && r.parts.length > 0) pub?.artifact({ parts: r.parts, lastChunk: true });
      else if (r.text) {
        // Text delivered as the final answer. A provider that already streamed it as deltas is
        // expected to call complete({}), so the text is not published twice.
        text = r.text;
      }
      pub?.status({
        state: "completed",
        ...(text ? { text } : {}),
        ...(r.meta ? { metadata: r.meta } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
      });
    } else {
      pub?.status({
        state: outcome.kind,
        text: outcome.error.message,
        metadata: {
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
    handle.end(state);
    if (this.handles.get(handle.taskId) === handle) this.handles.delete(handle.taskId);
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
    const live = () => handle.phase === "active" && turn.live;
    const self = this;
    const view: CoreTaskRun = {
      runId: handle.runId,
      turnId: turn.turnId,
      taskId: handle.taskId,
      contextId: handle.contextId,
      signal: turn.controller.signal as CoreTaskRun["signal"],
      progress(text?: string, meta?: Meta) {
        if (!live()) return;
        handle.publisher?.status({ state: "working", ...(text ? { text } : {}), ...(meta ? { metadata: meta } : {}) });
      },
      event(e: CoreEvent) {
        if (!live()) return;
        if (e.type === "text") turn.text += e.text;
        handle.publisher?.event(e);
      },
      artifact(a: CoreArtifact) {
        if (!live()) return;
        handle.publisher?.artifact(a);
      },
      ask(request: CoreInteractionRequest, options?: AskOptions): Promise<CoreInteractionResult> {
        if (!live()) return Promise.resolve({ outcome: "canceled" });
        if (!self.interactions) {
          return Promise.resolve({ outcome: "unavailable", reason: "interactions are not enabled" });
        }
        return self.interactions.ask(handle, request, options).then((r) => (live() ? r : { outcome: "canceled" as const }));
      },
      bind(session: SessionRef) {
        if (!live()) return; // a late bind from an aborted run must not resurrect a discarded session
        turn.session = session;
        self.bindSession(handle, session);
      },
      race<T>(work: Promise<T>): Promise<T | typeof CANCELED> {
        return turn.race(work);
      },
      complete(result: CoreResult) {
        self.turnEnded(handle, turn, { kind: "completed", result });
      },
      fail(error: CoreError) {
        self.turnEnded(handle, turn, { kind: "failed", error });
      },
      reject(reason: CoreError) {
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
        handle.turn = heldTurn;
        handle.turns.push(heldTurn);
        if (entry.messageId) {
          self.track(
            self.store
              .claimQueued(handle.taskId, entry.messageId, "queued", "running")
              .catch((e) => self.log.warn("held record update failed", causeMessage(e))),
          );
        }
        self.writeRecord(handle, { state: "working", turnId: heldTurn.turnId });
        return self.makeView(handle, heldTurn);
      },
      dropHeld(heldHandle: string) {
        if (handle.phase !== "active") return;
        self.dropHeld(handle, heldHandle, "dropped by the provider");
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

  private bindSession(handle: RunHandle, session: SessionRef): void {
    const at = this.now();
    const issuer = this.issuerOverride ?? this.issuerOf();
    this.track(
      this.store
        .getBinding(handle.contextId)
        .then((prev) => {
          const binding: ContextBinding = {
            ...(prev ?? newRecordHeader({ id: handle.owner.id, kind: handle.owner.kind }, at)),
            updatedAt: at,
            contextId: handle.contextId,
            session: { ref: session.ref, ...(session.meta ? { meta: session.meta } : {}), issuer },
          };
          return this.store.putBinding(binding);
        })
        .catch((e) => this.log.warn("binding write failed", causeMessage(e))),
    );
  }

  private issuerOf(): string {
    try {
      const i = this.provider.info();
      return `${i.id}@${i.version ?? ""}`;
    } catch {
      return "unknown";
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
    const pub = publish ? publish({ taskId, contextId: handle.contextId }) : handle.publisher;
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
   * kept. The task continues with the next turn: `next` (the interrupting message)
   * or a message that arrives later. Composition of `interrupt` with a message is
   * the steering runtime's (#109); this is its primitive.
   */
  async interrupt(taskId: string, by: CoreCaller, next?: ExecuteInit): Promise<InterruptOutcome> {
    const handle = this.handles.get(taskId);
    if (!handle) return { interrupted: false, reason: "unknown-task" };
    const verdict = this.authorize(by, "interrupt", { taskId, contextId: handle.contextId, ownerId: handle.owner.id });
    if (!(typeof verdict === "boolean" ? verdict : await verdict)) return { interrupted: false, reason: "denied" };
    if (handle.phase !== "active") return { interrupted: false, reason: "terminal" };
    const running = this.liveTurns(handle);
    if (running.length === 0 && !handle.awaitingNextTurn && !next) return { interrupted: false, reason: "not-running" };

    handle.awaitingNextTurn = true;
    const target = running.find((t) => t.state === "running");
    for (const t of running) t.stop("interrupt");
    if (next) {
      const message: CoreMessage = next.message ?? {
        id: this.newId(),
        role: "user",
        parts: [],
        from: next.caller,
        delivery: "interrupt",
        at: this.now(),
      };
      handle.publisher = next.publisher;
      this.enqueue(handle, message, next);
    }
    if (target) {
      handle.stopping = true;
      handle.abortTarget = target;
      const aborting = this.runAbort(handle, target, "interrupt").finally(() => {
        handle.stopping = false;
        if (handle.aborting === aborting) handle.aborting = undefined;
        this.kick(handle);
      });
      handle.aborting = aborting;
      this.track(aborting);
    } else {
      this.kick(handle);
    }
    return { interrupted: true };
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
    handle.publisher?.status({ state, text: error.message, ...(error.code ? { metadata: { code: error.code } } : {}) });
    handle.publisher?.finished();
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
      if (this.lanes.get(handle.contextId)?.idle) this.lanes.delete(handle.contextId);
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
  private async bounded<T>(fn: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(fn),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${this.abortTimeoutMs}ms`)), this.abortTimeoutMs);
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

  private async discardSession(contextId: string, session: SessionRef | undefined): Promise<void> {
    let ref = session?.ref;
    try {
      const binding = await this.store.getBinding(contextId);
      if (binding?.session && (!ref || binding.session.ref === ref)) {
        ref = binding.session.ref;
        await this.store.deleteBinding(contextId);
      }
    } catch (e) {
      this.log.warn("clearing the context binding failed", causeMessage(e));
    }
    if (ref && this.provider.release) {
      const r = await this.bounded(() => this.provider.release!({ ref: ref! }));
      if (!r.ok) this.log.warn(`provider.release failed: ${r.error.message}`);
    }
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
      const binding = await this.store.getBinding(record.contextId);
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
        entry.action = "skipped-interrupted";
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
    return { entries };
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
  private writeRecord(handle: RunHandle, patch: { state: string; turnId: string }): void {
    const at = this.now();
    void this.mutateRecord(handle.taskId, (r) => {
      if (r && r.runId === handle.runId) {
        if (classifyState(r.state) === "terminal") return r;
        return { ...r, ...patch, updatedAt: at };
      }
      return {
        ...newRecordHeader({ id: handle.owner.id, kind: handle.owner.kind }, at),
        runId: handle.runId,
        taskId: handle.taskId,
        contextId: handle.contextId,
        turnId: patch.turnId,
        state: patch.state,
        startedAt: at,
      };
    });
  }
}
