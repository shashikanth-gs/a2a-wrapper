/**
 * @module model/run
 *
 * What a provider receives ({@link CoreRequest}), what it acts through
 * ({@link CoreTaskRun}) and the values it emits. None of it mentions the A2A SDK.
 *
 * `CoreTaskRun` is the design document's `TaskRun`. It carries a different name
 * only because `@a2a-wrapper/core` already exports a `TaskRun` (the in-flight
 * run handed out by `TaskRunRegistry`), which stays unchanged until the run
 * model replaces it.
 *
 * ### Runs and turns
 *
 * A task has one `runId` and is a sequence of turns, each with its own
 * `turnId`. A message queued or interrupting at a task is the next turn of the
 * same task and run; the task goes terminal only when the last turn ends and
 * nothing is queued for it.
 *
 * ### Held turns
 *
 * A provider may answer a steer with `queued` (it keeps the message in its own
 * queue, for example Copilot enqueue, OpenCode inbox, Claude `later`). That
 * message later runs as a turn of the same task. The provider says so with
 * {@link CoreTaskRun.beginHeldTurn} (it returns the run view for that turn, with
 * a new `turnId`) or discards it with {@link CoreTaskRun.dropHeld} (an interrupt or
 * cancel flushed the queue). A task goes terminal only when the last turn ends AND
 * no core-queued message AND no provider-held handle remains un-run and
 * un-dropped. Without these calls the held message's output would arrive after the
 * task is terminal and be dropped.
 *
 * ### How a run ends
 *
 * Exactly one of `complete`, `fail` or `reject` ends a turn (and, with nothing
 * queued, the task); `ask` parks it in an interrupted state; `progress` is
 * always `working`. A provider cannot name a task state, so a state core does not
 * know can never be emitted. If `run()` resolves without any of those, core
 * completes the turn with the text accumulated from `text` events, or fails it
 * when there is none. Anything a provider publishes after a cancel (including a
 * `complete`) is dropped.
 *
 * @see docs/design/core-data-model.md sections 3.2 and 3.5
 */

import type { CANCELED } from "./cancel.js";
import type { JsonObject } from "./json.js";
import type { AskOptions, CoreInteractionRequest, CoreInteractionResult } from "./interaction.js";
import type { HistoryMessage } from "./message.js";
import type { CoreCaller, CorePart, CoreTraceContext, Meta, Open } from "./primitives.js";
import type { CoreUsage } from "./usage.js";

/** A persisted provider session reference. */
export interface SessionRef {
  ref: string;
  /** Persisted with the binding, so JSON-safe. */
  meta?: JsonObject;
}

/**
 * The abort signal of a run. Its `reason` is the {@link AbortReason} core stopped
 * it for: `cancel`, `interrupt` (an interrupt aborts the signal too, then the task
 * continues with the next turn) or `shutdown`. Unaborted: `undefined`.
 */
export type CoreAbortSignal = Omit<AbortSignal, "reason"> & { readonly reason: AbortReason | undefined };

/** What a provider receives for one turn. */
export interface CoreRequest {
  /** One per task. */
  runId: string;
  /** One per turn of the run. */
  turnId: string;
  /**
   * The ordinal of this turn within its TASK: 1 for the first turn, 2 for the next, and so on (a queued message, an
   * interrupt, a message folded in as its own turn and a held turn each start a new one). Persisted with the run record,
   * so it keeps counting after a restart, and the same for the retry of a turn with `session-not-found`. Derive ids that
   * must differ per turn from it (see {@link turnArtifactId}) instead of keeping a process-local counter.
   */
  turn: number;
  taskId: string;
  contextId: string;
  input: readonly CorePart[];
  /** Read-only view of earlier turns. Sender and time are unknown for stored messages. */
  history: readonly HistoryMessage[];
  caller: CoreCaller;
  /**
   * The persisted provider session for this context, if it has one: what the provider stored with `run.bind` on an
   * earlier turn, handed back (also after a restart) so the provider resumes it. Core only passes a binding that
   * belongs to this caller and was written by this provider (see `ContextBinding`). If the backend can no longer
   * resume it, the provider fails the turn with {@link SESSION_NOT_FOUND}: core forgets the binding and runs the same
   * turn once more with no session.
   */
  session?: SessionRef;
  correlation: {
    eventId: string;
    parentAgentId?: string;
    trace?: CoreTraceContext;
    metadata: Meta;
  };
  /** Negotiated A2A extensions, opaque to providers. */
  extensions: ReadonlyMap<string, unknown>;
}

/**
 * An artifact id that is unique per turn of a task: `<kind>-<taskId>-<turn>`, for example `response-t1-2`. A turn of a
 * task that is not its first runs under the same `taskId` and `runId`, so an id built from those alone would collide with
 * the earlier turn's artifact and the later answer would REPLACE the earlier one in the stored task.
 */
export function turnArtifactId(kind: string, taskId: string, turn: number): string {
  return `${kind}-${taskId}-${turn}`;
}

/** A streamed or buffered output of a run. */
export interface CoreArtifact {
  /** Core assigns one when absent. */
  id?: string;
  name?: string;
  description?: string;
  parts: readonly CorePart[];
  /** Extension URIs the artifact belongs to (for example the trace extension of a sideband artifact). */
  extensions?: readonly string[];
  /** Append `parts` to the artifact with this id (streaming chunk). */
  append?: boolean;
  /** This is the last chunk of the artifact. */
  lastChunk?: boolean;
  meta?: Meta;
}

/** What a tool call does, for display and policy. */
export type ToolKind = Open<
  "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other"
>;

/** A place a tool call touches. */
export interface ToolLocation {
  path: string;
  line?: number;
}

/** Which agent produced an event; a sub-agent names its parent. */
export interface EventAgent {
  id: string;
  parentId?: string;
}

/** Fields every event may carry. */
interface EventBase {
  /** Set when the event comes from a sub-agent rather than the main agent. */
  agent?: EventAgent;
}

/**
 * Non-terminal events a provider reports while running. Open union via `unknown`.
 * `text` and `thought` carry DELTAS: append `text` to the message `messageId`.
 */
export type CoreEvent = EventBase &
  (
    | {
        type: "text";
        /** The message this delta belongs to. Core assigns one per contiguous stream when absent. */
        messageId?: string;
        /** Delta, not the message so far. */
        text: string;
        meta?: Meta;
      }
    | { type: "thought"; messageId?: string; text: string; meta?: Meta }
    | {
        type: "tool";
        id: string;
        name: string;
        kind?: ToolKind;
        state: Open<"started" | "running" | "completed" | "failed">;
        input?: unknown;
        output?: unknown;
        locations?: readonly ToolLocation[];
        /** The tool call this one runs under (a sub-agent or composite tool). */
        parentToolId?: string;
        meta?: Meta;
      }
    | {
        type: "plan";
        entries: readonly { text: string; status?: Open<"pending" | "in_progress" | "completed"> }[];
        meta?: Meta;
      }
    | { type: "todo"; items: readonly { id?: string; text: string; done?: boolean }[]; meta?: Meta }
    | {
        type: "diff";
        path: string;
        /** `null` or absent for a new file. */
        oldText?: string | null;
        newText: string;
        meta?: Meta;
      }
    | { type: "usage"; usage: CoreUsage }
    | { type: "log"; level: Open<"debug" | "info" | "warn" | "error">; message: string; meta?: Meta }
    | { type: "unknown"; raw: unknown }
  );

/** Successful outcome of a run. */
export interface CoreResult {
  /** Final answer text. */
  text?: string;
  /** Final answer parts, when more than text. */
  parts?: readonly CorePart[];
  artifacts?: readonly CoreArtifact[];
  usage?: CoreUsage;
  meta?: Meta;
}

/** Failure or refusal of a run. */
export interface CoreError {
  message: string;
  code?: Open<
    | "timeout"
    | "backend"
    | "auth"
    | "internal"
    | "rate_limit"
    | "context_overflow"
    | "invalid_request"
    | "unavailable"
    | "session-not-found"
    | "forbidden"
  >;
  /** The caller may retry the same request later (a rate limit, a transient backend error). */
  retryable?: boolean;
  /**
   * Machine-readable extras for the caller, rendered as metadata of the failed or rejected status (for example when a rate
   * limit resets). Must be JSON-safe. `code` and `retryable` above win over a key of the same name here.
   */
  meta?: Meta;
  detail?: unknown;
}

/**
 * What a provider acts through. Everything it publishes goes through here, so
 * core can drop events after a cancel and translate the rest to A2A.
 */
export interface CoreTaskRun {
  readonly runId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly contextId: string;
  /** Aborted on cancel, and on interrupt (see {@link CoreAbortSignal}). */
  readonly signal: CoreAbortSignal;
  /** Report that the turn is working, with an optional status text. Always `working`. */
  progress(text?: string, meta?: Meta): void;
  /**
   * Attach metadata to the task with a non-terminal `working` status that carries NO text: for a provider that holds a
   * task open between rounds and wants to publish `backgroundTasks`, a usage summary, and so on, without the round's
   * text appearing a second time as a status message (`progress(text, meta)` is one status, so its text and its metadata
   * arrive together). Nothing is published for an empty `meta`. Dropped after the turn stopped, like every other call.
   */
  status(update: { meta: Meta }): void;
  /** Text/thought delta, tool, plan, todo, diff, usage, log. */
  event(e: CoreEvent): void;
  artifact(a: CoreArtifact): void;
  /**
   * Park the run until the caller answers (the task becomes `input-required` or
   * `auth-required`). Resolves with a core-produced result (D5: only `selected`
   * allow approves). Concurrent asks queue per task (see `model/interaction`).
   *
   * Expiry: an unanswered interaction expires per kind (10 minutes, auth 30). With the
   * default policy `onTimeout: "fail"` core fails the task, so the promise resolves
   * `{outcome: "canceled"}` and `signal` aborts with reason `cancel`; with `"deny"` it
   * resolves `{outcome: "expired"}` and the run goes on. Either way nothing approves.
   */
  ask(i: CoreInteractionRequest, opts?: AskOptions): Promise<CoreInteractionResult>;
  /**
   * Persist contextId to provider session (survives restart). A later bind replaces the earlier one; a bind after a
   * cancel, from an aborted turn or from a turn older than the one that bound last is dropped. Throws a `TypeError` for
   * an empty `ref` or a `meta` that is not JSON-safe (it could not be stored, and a silently lost binding means no
   * resume after a restart); a view that is no longer live never throws, whatever it passes.
   *
   * Resolves `"stored"` once the binding is written, or `"dropped"` when it was not: a stale or canceled view, a bind
   * from a turn older than the one that bound last, a context another caller owns, a store failure. Never rejects. A
   * caller that does not need to know may ignore the promise (the write is tracked by core either way).
   */
  bind(session: SessionRef): Promise<BindResult>;
  /**
   * Hand core a usage reading and get back what THIS turn spent. A `delta` reading is returned as it is. A `cumulative`
   * one is a running total: core diffs it (`usageDelta`, per series and per model, a total that went down starts a new
   * epoch and is never reported negative) against the previous reading of the same series, which it keeps with the
   * context's session binding (`ContextBinding.usageBaseline`) so it is exact after a restart, and stores this reading
   * as the new baseline. Readings of one context are applied in order (the context lane serializes the turns).
   *
   * - A new `series` (a new session) is a new total: the reading is the delta.
   * - A series core has NO previous reading of (the baseline is lost: the process died between the session being bound
   *   and its first reading, the binding was replaced or deleted, no session is bound) is reported as the whole reading
   *   only when the provider says it is `fresh`; otherwise the delta is EMPTY (no tokens, no cost: nothing is claimed),
   *   because the total may include earlier turns this process never saw and over-reporting is worse than leaving a
   *   turn's usage unreported. The reading is still stored, so the NEXT turn is exact.
   * - A view that is not live (a canceled or interrupted turn) reports nothing and stores nothing: its spend is part of
   *   the next reading and lands on the next turn.
   *
   * Pass the result to `complete({ usage })`, or let `RunObservability.recordCumulative` do it. Never rejects.
   */
  reportUsage(reading: CoreUsage): Promise<CoreUsage>;
  race<T>(work: Promise<T>): Promise<T | typeof CANCELED>;
  /** End the turn successfully (`completed`). */
  complete(result: CoreResult): void;
  /** End the turn with an error (`failed`). */
  fail(error: CoreError): void;
  /** Refuse the request without doing it (`rejected`): out of scope, policy, invalid. */
  reject(reason: CoreError): void;
  /**
   * The provider-held message `handle` (from `SteerOutcome.queued`) now runs.
   * Returns the run view for that message's turn: same task and run, a new
   * `turnId`, and the task stays non-terminal. End that turn with the returned
   * view's `complete`, `fail` or `reject`.
   */
  beginHeldTurn(handle: string): CoreTaskRun;
  /**
   * The provider discarded the held message `handle` without running it (it
   * flushed its queue on cancel, or the backend dropped it). The task may now go
   * terminal if nothing else remains.
   */
  dropHeld(handle: string): void;
  /**
   * Record the real delivery of a provider-held steer after the fact. A provider that answered a steer `queued{handle}`
   * (because the backend had not said yet) learns later that the message was in fact `inserted` into a turn that was
   * running, or that it was never delivered (`dropped`). Core marks the message's record `done` or `dropped` and stops
   * holding the handle (the task may now go terminal), WITHOUT starting a turn: use {@link beginHeldTurn} when the held
   * message begins its own turn.
   *
   * `"requeue"`: the provider can no longer deliver it but the message must not be lost (an `interrupt` that ends the
   * backend process takes its native queue with it). Core takes it over: the record becomes `queued` with holder `core`
   * (so it survives a restart like any core-queued message) and the message runs as the NEXT turn of the task, ahead of
   * what was queued after it (a message the caller sent while the turn was running is older than anything that arrived
   * with the interrupt), through the provider's `run` like any queued message. Idempotent by message id.
   *
   * Idempotent: a handle that is not (or no longer) held is ignored. Silently dropped after the task was canceled.
   */
  settleSteer(handle: string, outcome: "inserted" | "dropped" | "requeue"): void;
}

/** What {@link CoreTaskRun.bind} reports: written, or not written (why is logged, never thrown). */
export type BindResult = "stored" | "dropped";

/** Read-only identity of a run, passed to `abort`. */
export interface TaskRunInfo {
  readonly runId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly session?: SessionRef;
}

/** What `abortOrphan` is told: the run and turn that have no live handle, and why core is stopping them. */
export interface OrphanInfo {
  runId: string;
  turnId: string;
  taskId: string;
  contextId: string;
  reason: AbortReason;
  session?: { ref: string };
}

/** Why core is stopping a turn. The provider handles its native queue accordingly. */
export type AbortReason = Open<"cancel" | "interrupt" | "shutdown">;

/** What a provider's `abort` handler returns. */
export interface AbortOutcome {
  /** Did the backend acknowledge it stopped. */
  stopped: "confirmed" | "unconfirmed";
  /** Can the bound session take the next turn. */
  session: "reusable" | "discard";
}

/** A rejected or timed-out `abort` is treated as this (core applies it). */
export const ABORT_FAILED_OUTCOME: Readonly<AbortOutcome> = Object.freeze({
  stopped: "unconfirmed",
  session: "discard",
});

/**
 * The `CoreError.code` a provider uses when `CoreRequest.session` names a session its backend cannot resume (deleted,
 * expired, never existed). Core deletes the binding and runs the SAME turn once more with no session (never a second
 * retry). Report it with `run.fail({ code: SESSION_NOT_FOUND, ... })` or by throwing a {@link SessionNotFoundError},
 * BEFORE the turn publishes anything (an event, an artifact or an `ask`); after that core cannot replay the turn, so the
 * failure is final. See docs/design/core-data-model.md 3.5.
 */
export const SESSION_NOT_FOUND = "session-not-found";

/** Throw this from `provider.run` for {@link SESSION_NOT_FOUND}. */
export class SessionNotFoundError extends Error {
  readonly code = SESSION_NOT_FOUND;
  constructor(message = "the backend does not know this session") {
    super(message);
    this.name = "SessionNotFoundError";
  }
}
