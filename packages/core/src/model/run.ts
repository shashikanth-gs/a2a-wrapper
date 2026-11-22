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

/** What a provider receives for one turn. */
export interface CoreRequest {
  /** One per task. */
  runId: string;
  /** One per turn of the run. */
  turnId: string;
  taskId: string;
  contextId: string;
  input: readonly CorePart[];
  /** Read-only view of earlier turns. Sender and time are unknown for stored messages. */
  history: readonly HistoryMessage[];
  caller: CoreCaller;
  /** The persisted provider session for this context, if it has one. */
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

/** A streamed or buffered output of a run. */
export interface CoreArtifact {
  /** Core assigns one when absent. */
  id?: string;
  name?: string;
  description?: string;
  parts: readonly CorePart[];
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
  >;
  /** The caller may retry the same request later (a rate limit, a transient backend error). */
  retryable?: boolean;
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
  /** Aborted on cancel. */
  readonly signal: AbortSignal;
  /** Report that the turn is working, with an optional status text. Always `working`. */
  progress(text?: string, meta?: Meta): void;
  /** Text/thought delta, tool, plan, todo, diff, usage, log. */
  event(e: CoreEvent): void;
  artifact(a: CoreArtifact): void;
  /**
   * Park the run until the caller answers (the task becomes `input-required` or
   * `auth-required`). Resolves with a core-produced result (D5: only `selected`
   * allow approves). Concurrent asks queue per task (see `model/interaction`).
   */
  ask(i: CoreInteractionRequest, opts?: AskOptions): Promise<CoreInteractionResult>;
  /** Persist contextId to provider session (survives restart). */
  bind(session: SessionRef): void;
  race<T>(work: Promise<T>): Promise<T | typeof CANCELED>;
  /** End the turn successfully (`completed`). */
  complete(result: CoreResult): void;
  /** End the turn with an error (`failed`). */
  fail(error: CoreError): void;
  /** Refuse the request without doing it (`rejected`): out of scope, policy, invalid. */
  reject(reason: CoreError): void;
}

/** Read-only identity of a run, passed to `abort`. */
export interface TaskRunInfo {
  readonly runId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly session?: SessionRef;
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
