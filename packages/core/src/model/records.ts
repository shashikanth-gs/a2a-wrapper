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
  /** The input of the turn that started the run (file bytes are stored per {@link StoredPart}). */
  input?: readonly CorePart[];
}

// ─── Stored form and codec ──────────────────────────────────────────────────

/**
 * A part as stored: file bytes become `{base64}`. Text, data and unknown parts
 * are already JSON-safe.
 */
export type StoredPart =
  | { kind: "text"; text: string; mediaType?: string; meta?: JsonObject }
  | { kind: "data"; data: Json; mediaType?: string; meta?: JsonObject }
  | {
      kind: "file";
      name?: string;
      mediaType?: string;
      bytes?: { base64: string };
      uri?: string;
      meta?: JsonObject;
    }
  | { kind: "unknown"; raw: Json };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

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
  if (value instanceof Uint8Array) {
    throw new TypeError(`${path}: raw bytes may only appear inside a file part`);
  }
  if (Array.isArray(value)) return value.map((v, n) => encodeValue(v, `${path}[${n}]`));
  if (isPlainObject(value)) {
    const out: Record<string, Json> = {};
    const isFile = value.kind === "file";
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue; // JSON has no undefined; an absent field is the same thing
      if (isFile && k === "bytes" && v instanceof Uint8Array) {
        out[k] = { base64: toBase64(v) };
        continue;
      }
      out[k] = encodeValue(v, `${path}.${k}`);
    }
    return out;
  }
  if (!isJson(value)) throw new TypeError(`${path}: not JSON-safe (${typeof value})`);
  return value;
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    const isFile = value.kind === "file";
    for (const [k, v] of Object.entries(value)) {
      if (isFile && k === "bytes" && isPlainObject(v) && typeof v.base64 === "string") {
        out[k] = new Uint8Array(Buffer.from(v.base64, "base64"));
        continue;
      }
      out[k] = decodeValue(v);
    }
    return out;
  }
  return value;
}

/** A record in stored form: plain JSON. */
export type StoredRecord = JsonObject & { v: number };

/**
 * Record to plain JSON, ready for `JSON.stringify`. File bytes inside file parts
 * become `{base64}`; `undefined` fields are dropped; anything else that is not
 * JSON (a function, a stray `Uint8Array`, `NaN`) throws, so a bad record fails
 * at write time and not at the next restart.
 */
export function encodeRecord<T extends RecordHeader>(record: T): StoredRecord {
  return encodeValue(record, "record") as StoredRecord;
}

/**
 * Plain JSON (parsed) back to a record. Throws when `v` is missing, not a
 * number, or newer than {@link RECORD_VERSION} (this core cannot read it).
 */
export function decodeRecord<T extends RecordHeader>(stored: unknown): T {
  if (!isPlainObject(stored) || typeof stored.v !== "number") throw new TypeError("record has no version");
  if (stored.v > RECORD_VERSION) throw new RangeError(`record version ${stored.v} is newer than ${RECORD_VERSION}`);
  return decodeValue(stored) as T;
}
