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
 * @see docs/design/core-data-model.md sections 3.2 and 3.5
 */

import type { CANCELED } from "../executor/task-runs.js";
import type { AskOptions, CoreInteractionRequest, CoreInteractionResult } from "./interaction.js";
import type { CoreMessage } from "./message.js";
import type { CoreCaller, CorePart, CoreTaskState, CoreTraceContext, Meta, Open } from "./primitives.js";
import type { CoreUsage } from "./usage.js";

/** A persisted provider session reference. */
export interface SessionRef {
  ref: string;
  meta?: Meta;
}

/** What a provider receives for one turn. */
export interface CoreRequest {
  runId: string;
  taskId: string;
  contextId: string;
  input: CorePart[];
  /** Read-only view of earlier turns. */
  history: readonly CoreMessage[];
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
  parts: CorePart[];
  /** Append `parts` to the artifact with this id (streaming chunk). */
  append?: boolean;
  /** This is the last chunk of the artifact. */
  lastChunk?: boolean;
  meta?: Meta;
}

/** Non-terminal events a provider reports while running. Open union via `unknown`. */
export type CoreEvent =
  | { type: "text"; text: string; meta?: Meta }
  | { type: "thought"; text: string; meta?: Meta }
  | {
      type: "tool";
      id: string;
      name: string;
      state: Open<"started" | "running" | "completed" | "failed">;
      input?: unknown;
      output?: unknown;
      meta?: Meta;
    }
  | { type: "plan"; entries: { text: string; status?: Open<"pending" | "in_progress" | "completed"> }[]; meta?: Meta }
  | { type: "todo"; items: { id?: string; text: string; done?: boolean }[]; meta?: Meta }
  | { type: "diff"; path: string; diff: string; meta?: Meta }
  | { type: "usage"; usage: CoreUsage }
  | { type: "log"; level: Open<"debug" | "info" | "warn" | "error">; message: string; meta?: Meta }
  | { type: "unknown"; raw: unknown };

/** Successful outcome of a run. */
export interface CoreResult {
  /** Final answer text. */
  text?: string;
  /** Final answer parts, when more than text. */
  parts?: CorePart[];
  artifacts?: CoreArtifact[];
  usage?: CoreUsage;
  meta?: Meta;
}

/** Failure outcome of a run. */
export interface CoreError {
  message: string;
  code?: Open<"timeout" | "backend" | "auth" | "internal">;
  detail?: unknown;
}

/**
 * What a provider acts through. Everything it publishes goes through here, so
 * core can drop events after a cancel and translate the rest to A2A.
 */
export interface CoreTaskRun {
  readonly runId: string;
  readonly taskId: string;
  readonly contextId: string;
  /** Aborted on cancel. */
  readonly signal: AbortSignal;
  status(state: CoreTaskState, text?: string): void;
  /** Text/thought delta, tool, plan, todo, diff, usage, log. */
  event(e: CoreEvent): void;
  artifact(a: CoreArtifact): void;
  /** Park the run until the caller answers. Resolves with a core-produced result (D5: only `selected` allow approves). */
  ask(i: CoreInteractionRequest, opts?: AskOptions): Promise<CoreInteractionResult>;
  /** Persist contextId to provider session (survives restart). */
  bind(session: SessionRef): void;
  race<T>(work: Promise<T>): Promise<T | typeof CANCELED>;
  complete(result: CoreResult): void;
  fail(error: CoreError): void;
}

/** Read-only identity of a run, passed to `abort`. */
export interface TaskRunInfo {
  readonly runId: string;
  readonly taskId: string;
  readonly contextId: string;
  readonly session?: SessionRef;
}

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
