/**
 * @module model/primitives
 *
 * Core-owned primitives shared by the whole domain model: metadata bags, open
 * enums, the caller identity, message parts and the task state vocabulary.
 *
 * Nothing in `model/` imports the A2A SDK. Translation to and from A2A lives in
 * `a2a/adapter.ts`, the only module that does.
 *
 * @see docs/design/core-data-model.md section 3.1
 */

/** Free-form metadata bag carried on most entities. */
export type Meta = Record<string, unknown>;

/**
 * Open enum: the known literals plus any other string. Unknown values
 * round-trip untouched, so a core upgrade never needs a provider upgrade and
 * the reverse (design decision D6).
 */
export type Open<T extends string> = T | (string & {});

/** Who is calling. Set by core from authentication, never by a provider. */
export interface CoreCaller {
  /** Stable subject. `"anonymous"` when unauthenticated. */
  id: string;
  kind: Open<"user" | "agent" | "service" | "anonymous">;
  scopes?: string[];
  claims?: Meta;
}

/** The caller used when nothing authenticated the request. */
export const ANONYMOUS_CALLER: Readonly<CoreCaller> = Object.freeze({
  id: "anonymous",
  kind: "anonymous",
});

/**
 * A unit of content. Open union: `unknown` carries a kind this core version
 * does not model, intact, so it can be forwarded without loss.
 */
export type CorePart =
  | {
      kind: "text";
      text: string;
      /** Media type of the text (for example `text/markdown`), when the sender gave one. */
      mediaType?: string;
      meta?: Meta;
    }
  | { kind: "data"; data: unknown; mediaType?: string; meta?: Meta }
  | {
      kind: "file";
      name?: string;
      mediaType?: string;
      uri?: string;
      bytes?: Uint8Array;
      meta?: Meta;
    }
  | { kind: "unknown"; raw: unknown };

/**
 * One vocabulary for task state. Open, so a state this core version does not
 * know is carried as-is instead of being dropped.
 */
export type CoreTaskState = Open<
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected"
>;

/** States after which a task never changes again. */
export const TERMINAL_TASK_STATES: readonly string[] = Object.freeze([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

/** States in which the task is parked waiting for the caller. */
export const INTERRUPTED_TASK_STATES: readonly string[] = Object.freeze([
  "input-required",
  "auth-required",
]);

/** `true` for completed, failed, canceled and rejected. Unknown states are not terminal. */
export function isTerminalState(state: CoreTaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

/** `true` for input-required and auth-required. Unknown states are not interrupted. */
export function isInterruptedState(state: CoreTaskState): boolean {
  return INTERRUPTED_TASK_STATES.includes(state);
}

/** Trace and correlation identifiers carried with a request. */
export interface CoreTraceContext {
  /** W3C `traceparent`, when the caller supplied one. */
  traceparent?: string;
  /** W3C `tracestate`, when the caller supplied one. */
  tracestate?: string;
  traceId?: string;
  conversationId?: string;
  sessionId?: string;
  meta?: Meta;
}
