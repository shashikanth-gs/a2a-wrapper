/**
 * @module model/records
 *
 * Persistence records for core's `TaskStore` extension. Types and pure helpers
 * only: the stores that read and write them come later.
 *
 * Every record is JSON-safe (see `json.ts`), carries a {@link RecordHeader}
 * (schema version, owner, tenant, timestamps) and survives
 * `JSON.stringify` / `JSON.parse` through {@link encodeRecord} /
 * {@link decodeRecord}, which convert the one non-JSON thing a record may hold:
 * file bytes.
 *
 * @see docs/design/core-data-model.md section 3.6
 */

import type { Json, JsonObject } from "./json.js";
import { isJson } from "./json.js";
import type { CoreInteraction, CoreInteractionResult } from "./interaction.js";
import type { CoreMessage } from "./message.js";
import type { CorePart, CoreTaskState } from "./primitives.js";
import type { AbortOutcome, SessionRef } from "./run.js";

/** Current record schema version. A reader rejects a record with a higher one. */
export const RECORD_VERSION = 1;

/** Fields every record carries. */
export interface RecordHeader {
  v: 1;
  /** Whose record this is: the task owner. Scoping (spec 13.1) reads it. */
  owner: { id: string; kind: string };
  tenant?: string;
  createdAt: string;
  updatedAt: string;
}

/** Build a header for a new record. */
export function newRecordHeader(
  owner: RecordHeader["owner"],
  now: string,
  tenant?: string,
): RecordHeader {
  return { v: RECORD_VERSION, owner, ...(tenant ? { tenant } : {}), createdAt: now, updatedAt: now };
}

/**
 * Lifecycle of an interaction. `queued` waits behind the one `presented`
 * interaction of its task (per-task FIFO by `seq`; at most one `presented`).
 * `queued` and `presented` are the open states; the rest are final.
 */
export type InteractionState = "queued" | "presented" | "answered" | "expired" | "canceled" | "withdrawn";

/** `true` for `queued` and `presented`. */
export function isOpenInteractionState(state: string): boolean {
  return state === "queued" || state === "presented";
}

export interface PendingInteraction extends RecordHeader {
  interaction: CoreInteraction;
  taskId: string;
  contextId: string;
  runId: string;
  /** Per-task order, assigned by core, increasing. FIFO order of presentation. */
  seq: number;
  state: InteractionState;
  expiresAt: string;
  /**
   * The outcome, once final. `redacted` lists the paths removed before storing
   * (secret answers), for example `answers.token.text`.
   */
  result?: CoreInteractionResult & { redacted?: readonly string[] };
  /** Opaque provider handle, present only if the interaction can be re-attached. */
  handle?: string;
}

/** The interaction currently shown to the caller for a task, if any. */
export function presentedInteraction(records: readonly PendingInteraction[]): PendingInteraction | undefined {
  return records.filter((r) => r.state === "presented").sort((a, b) => a.seq - b.seq)[0];
}

/** The queued interaction to present next: lowest `seq`. `undefined` when none. */
export function nextQueuedInteraction(records: readonly PendingInteraction[]): PendingInteraction | undefined {
  return records.filter((r) => r.state === "queued").sort((a, b) => a.seq - b.seq)[0];
}

/**
 * The state a newly asked interaction starts in: `presented` when the task has
 * no open interaction, else `queued`. This is the per-task FIFO rule.
 */
export function initialInteractionState(existing: readonly PendingInteraction[]): "presented" | "queued" {
  return existing.some((r) => isOpenInteractionState(r.state)) ? "queued" : "presented";
}

/**
 * Provider session as stored. `issuer` is an opaque string naming the provider
 * and its version that created the session. Core compares it for equality only
 * (a changed issuer means the stored session may not be usable); it never
 * branches on its content.
 */
export type StoredSessionRef = SessionRef & { issuer: string };

export interface ContextBinding extends RecordHeader {
  contextId: string;
  session?: StoredSessionRef;
}

/**
 * One record per task, keyed by `runId`, updated per turn (`turnId` and `state`
 * follow the current turn). Terminal when the last turn ended with nothing queued
 * or held (see `QueuedMessageRecord`). The startup sweep reads `state` through
 * `classifyState`: `active` records with no live run are orphans, `unknown` is
 * handled by policy, never assumed finished.
 */
export interface RunRecord extends RecordHeader {
  runId: string;
  taskId: string;
  contextId: string;
  turnId: string;
  state: CoreTaskState;
  startedAt: string;
  endedAt?: string;
  /** Set when a cancel was requested for this run. */
  cancel?: { requestedAt: string; by: string; abort?: AbortOutcome };
  /**
   * The input of the turn that started the run. DIAGNOSTICS ONLY: core never
   * replays it after a crash (a replay could repeat side effects). It may hold
   * bytes and secrets, so a store treats it like any other sensitive field
   * (encryption, retention, redaction). Bytes are stored as `{"$bytes:v1": base64}`.
   */
  input?: readonly CorePart[];
}

/// ─── Stored form and codec ──────────────────────────────────────────────────

/** The one reserved key of stored bytes: `{"$bytes:v1": "<base64>"}`. */
export const BYTES_KEY = "$bytes:v1";

/** Bytes as stored. Unambiguous: no ordinary data has this key. */
export type StoredBytes = { readonly [BYTES_KEY]: string };

/**
 * A part as stored: file bytes become {@link StoredBytes}. Text, data and
 * unknown parts are already JSON-safe.
 */
export type StoredPart =
  | { kind: "text"; text: string; mediaType?: string; meta?: JsonObject }
  | { kind: "data"; data: Json; mediaType?: string; meta?: JsonObject }
  | {
      kind: "file";
      name?: string;
      mediaType?: string;
      bytes?: StoredBytes;
      uri?: string;
      meta?: JsonObject;
    }
  | { kind: "unknown"; raw: Json };

/** Strictly plain: prototype is `Object.prototype` or `null`. A Date, Map or class instance is not. */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const isStoredBytes = (v: unknown): v is StoredBytes =>
  isPlainObject(v) && Object.keys(v).length === 1 && typeof v[BYTES_KEY] === "string";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Core part to its stored (JSON-safe) form. Throws when the part holds a non-JSON value. */
export function encodePart(part: CorePart): StoredPart {
  return encodeValue(part, "part") as unknown as StoredPart;
}

/** Stored part back to a core part (file bytes restored as `Uint8Array`). */
export function decodePart(stored: StoredPart): CorePart {
  return decodeValue(stored) as CorePart;
}

function encodeValue(value: unknown, path: string): Json {
  if (value instanceof Uint8Array) return { [BYTES_KEY]: toBase64(value) };
  if (Array.isArray(value)) return value.map((v, n) => encodeValue(v, `${path}[${n}]`));
  if (isPlainObject(value)) {
    // Never re-encode stored data: a live object may not use the reserved key at all.
    if (Object.hasOwn(value, BYTES_KEY)) throw new TypeError(`${path}: key "${BYTES_KEY}" is reserved for stored bytes`);
    // fromEntries defines own data properties, so a "__proto__" key stays a key and never sets the prototype.
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined) // JSON has no undefined; an absent field is the same thing
        .map(([k, v]) => [k, encodeValue(v, `${path}.${k}`)]),
    ) as Json;
  }
  if (!isJson(value)) throw new TypeError(`${path}: not JSON-safe (${Object.prototype.toString.call(value)})`);
  return value;
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (isStoredBytes(value)) return new Uint8Array(Buffer.from(value[BYTES_KEY], "base64"));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeValue(v)]));
  }
  return value;
}

/** A record in stored form: plain JSON. */
export type StoredRecord = JsonObject & { v: number };

/**
 * Record to plain JSON, ready for `JSON.stringify`. Bytes (`Uint8Array`,
 * wherever they appear, normally in file parts) become `{"$bytes:v1": base64}`;
 * `undefined` fields are dropped. Anything else that is not JSON (a function, a
 * `Date`, a `Map`, `NaN`, bigint, a class instance) throws, as does ANY live object that
 * uses the reserved `$bytes:v1` key (never re-encode stored data), so a bad record fails at write
 * time and not at the next restart.
 */
export function encodeRecord<T extends RecordHeader>(record: T): StoredRecord {
  return encodeValue(record, "record") as StoredRecord;
}

/**
 * Plain JSON (parsed) back to a record. `{"$bytes:v1": base64}` objects become
 * `Uint8Array` wherever they appear; every other object, including one shaped
 * like a file part with a `bytes` field, is returned unchanged. Throws when `v`
 * is missing, not a number, or newer than {@link RECORD_VERSION}.
 */
export function decodeRecord<T extends RecordHeader>(stored: unknown): T {
  if (!isPlainObject(stored) || typeof stored.v !== "number") throw new TypeError("record has no version");
  if (stored.v > RECORD_VERSION) throw new RangeError(`record version ${stored.v} is newer than ${RECORD_VERSION}`);
  return decodeValue(stored) as T;
}

// ─── Core-queued messages ───────────────────────────────────────────────────

/**
 * Lifecycle of a message held for a task. `queued` waits; `running` became a turn;
 * `dropped` was discarded (flush); `unknown` is a provider-held message whose fate
 * core could not confirm (the restart sweep asked the provider to stop it and the
 * outcome was not `stopped: "confirmed"`). `unknown` is never replayed and never
 * assumed dropped.
 */
export type QueuedMessageState = "queued" | "running" | "done" | "dropped" | "unknown";

/**
 * A message held for a task, so it survives a restart. `holder: "core"` messages
 * wait in core's per-context lane and run as the next turn. `holder: "provider"`
 * messages live in the provider's own queue: the record keeps the `handle` the
 * provider gave in `SteerOutcome.queued`, so core still knows the task is not
 * finished and can report or drop it. Restart rules (docs/design/core-data-model.md
 * 3.6): core replays only `queued` core-held records, claiming `queued -> running`
 * atomically BEFORE `provider.run`; a `running` record is an orphaned turn and is
 * never replayed. A provider-held record is not assumed dead: core calls
 * `abortOrphan({reason: "cancel"})` and marks it `dropped` only on
 * `stopped: "confirmed"`, else "state unknown".
 */
export interface QueuedMessageRecord extends RecordHeader {
  taskId: string;
  contextId: string;
  /** Live message; encodeRecord stores its bytes. */
  message: CoreMessage;
  holder: "provider" | "core";
  /**
   * Ordering key among the task's queued messages: `listQueued` returns records in this order. Core assigns it
   * monotonically per run (a message that starts does not renumber the ones behind it), so it is NOT the position
   * a caller is told (`DeliveryResult.position` is the live 1-based index at delivery time).
   */
  position?: number;
  /** The provider's handle for a provider-held message. */
  handle?: string;
  state: QueuedMessageState;
  /** Why the record ended as `dropped` or `unknown` (for example `"task canceled"`). */
  reason?: string;
}
