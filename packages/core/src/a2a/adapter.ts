/**
 * @module a2a/adapter
 *
 * The A2A v1 adapter: the one place that translates between core's domain model
 * (`model/`) and `@a2a-js/sdk` types. When the SDK or protocol moves, this file
 * is what changes; providers never see an SDK type.
 *
 * Everything here is a pure function: no run registry, no stores, no I/O. The
 * run model and its wiring come later.
 *
 * ### Shapes handled
 *
 * - **A2A v1** (SDK 1.x): protobuf-style `Part` (`content.$case` of `text`,
 *   `raw`, `url`, `data`), `TASK_STATE_*` numeric enum, `ROLE_*` enum.
 * - **A2A v0.3** (inbound only, tolerated): `{kind: "text" | "data" | "file"}`
 *   parts and lowercase-hyphen task state strings. The SDK normally converts
 *   these before core sees them; the adapter accepts them anyway so a part or
 *   state in the old shape is never dropped.
 *
 * ### Loss rules
 *
 * Nothing is dropped silently. A part core does not model becomes
 * `{kind: "unknown", raw}` and is emitted again as it came. A task state with no
 * v1 equivalent is never sent as `TASK_STATE_UNSPECIFIED`: it goes out as
 * `TASK_STATE_WORKING` with the original string in versioned status metadata
 * ({@link CORE_STATE_META_KEY}) and is restored on the way back.
 *
 * ### Wire keys
 *
 * Every key this adapter writes is versioned (`urn:a2a-wrapper:<name>:v1`) and
 * listed in {@link WIRE_EXTENSIONS}; {@link agentExtensionDeclarations} turns the
 * list into agent-card declarations. The old unversioned keys are still read
 * inbound ({@link LEGACY_WIRE_KEYS}) but never written.
 *
 * @see docs/design/core-data-model.md section 4
 */

import { Role, TaskState } from "@a2a-js/sdk";
import type {
  AgentExtension,
  Artifact,
  Message,
  Part,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type { RequestContext } from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";
import { extractA2ATraceContext } from "../telemetry/context.js";
import { collectInboundCarrier } from "../telemetry/propagation.js";
import type {
  CoreArtifact,
  CoreCaller,
  CoreInteraction,
  CoreInteractionResult,
  CoreMessage,
  CorePart,
  CoreRequest,
  CoreTaskState,
  CoreUsage,
  HistoryMessage,
  FlatSchemaProperty,
  JsonObject,
  Meta,
  ModelUsage,
  SessionRef,
  UnknownInteraction,
} from "../model/index.js";
import { ANONYMOUS_CALLER, APPROVING_OPTION_KINDS, isJsonObject } from "../model/index.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Extension URI under which structured interaction data parts are advertised. */
export const INTERACTION_EXTENSION_URI = "urn:a2a-wrapper:interaction:v1";

/** Part metadata key marking a `data` part that carries an unknown core part verbatim. */
export const UNKNOWN_PART_META_KEY = "urn:a2a-wrapper:unknown-part:v1";
/** Part metadata key preserving a file `uri` when the part also carries bytes. */
export const FILE_URI_META_KEY = "urn:a2a-wrapper:file-uri:v1";
/** Status metadata key preserving a core task state that has no v1 equivalent. */
export const CORE_STATE_META_KEY = "urn:a2a-wrapper:core-state:v1";
/** Message metadata key carrying the caller's `delivery` intent (queue, steer, interrupt). */
export const DELIVERY_META_KEY = "urn:a2a-wrapper:delivery:v1";
/** Metadata key under which usage is rendered. */
export const USAGE_META_KEY = "urn:a2a-wrapper:usage:v1";

/**
 * Keys this adapter wrote before they were versioned. Read inbound so existing
 * clients and stored tasks keep working; never written.
 */
export const LEGACY_WIRE_KEYS = Object.freeze({
  unknownPart: "urn:a2a-wrapper:unknown-part",
  fileUri: "urn:a2a-wrapper:file-uri",
  coreState: "urn:a2a-wrapper:core-state",
  delivery: "urn:a2a-wrapper:delivery",
  usage: "urn:a2a-wrapper:usage",
} as const);

/**
 * Inbound alias for steering control, accepted best effort. The A2A open steering
 * proposal (a2a-protocol #2125) is not final, so the shape is an assumption: a
 * message metadata entry under this URI whose value is either the string
 * `"steer"` / `"interrupt"` / `"queue"`, or an object with one of `action`,
 * `mode`, `type` or `delivery` holding that string. Anything else is ignored.
 * The core key ({@link DELIVERY_META_KEY}) wins when both are present.
 */
export const STEERING_EXTENSION_ALIAS = "https://a2a-protocol.org/extensions/steering/v1/control";

/** One wire key or extension this adapter uses, with its role. */
export interface WireExtension {
  uri: string;
  /** `extension`: activated by header. `metadata-key`: a metadata key core writes or reads, versioned the same way. */
  kind: "extension" | "metadata-key";
  description: string;
}

/** Every versioned key and extension URI core writes, in one list. */
export const WIRE_EXTENSIONS: readonly WireExtension[] = Object.freeze([
  {
    uri: INTERACTION_EXTENSION_URI,
    kind: "extension",
    description:
      "Structured permission, question, form and auth requests, and their replies, as data parts next to a text rendering.",
  },
  {
    uri: DELIVERY_META_KEY,
    kind: "metadata-key",
    description: "Message metadata: delivery intent for a message to a running task (queue, steer, interrupt).",
  },
  { uri: USAGE_META_KEY, kind: "metadata-key", description: "Event metadata: token and cost usage." },
  {
    uri: CORE_STATE_META_KEY,
    kind: "metadata-key",
    description: "Status metadata: the original task state when it has no A2A v1 equivalent.",
  },
  {
    uri: FILE_URI_META_KEY,
    kind: "metadata-key",
    description: "Part metadata: the source uri of a file part that also carries inline bytes.",
  },
  {
    uri: UNKNOWN_PART_META_KEY,
    kind: "metadata-key",
    description: "Part metadata: marks a data part that carries a part core does not model, unchanged.",
  },
] as const);

/**
 * Agent card `capabilities.extensions` entries for {@link WIRE_EXTENSIONS}. All
 * are optional (`required: false`): a client that ignores them still gets text.
 * Not wired into the server factory yet; the caller decides what to advertise.
 */
export function agentExtensionDeclarations(options: { only?: readonly string[] } = {}): AgentExtension[] {
  return WIRE_EXTENSIONS.filter((e) => !options.only || options.only.includes(e.uri)).map((e) => ({
    uri: e.uri,
    description: e.description,
    required: false,
    params: { kind: e.kind },
  }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Remove `key` from `metadata`; returns the remaining meta (undefined if none was given or nothing remains after a removal) and the removed value. */
function takeMetaKey(
  metadata: Record<string, unknown> | undefined | null,
  key: string,
): { meta: Meta | undefined; value: unknown } {
  if (!metadata) return { meta: undefined, value: undefined };
  if (!(key in metadata)) return { meta: metadata, value: undefined };
  const { [key]: value, ...rest } = metadata;
  return { meta: Object.keys(rest).length > 0 ? rest : undefined, value };
}

/** Like {@link takeMetaKey} for the versioned key, falling back to (and removing) the legacy one. */
function takeVersionedKey(
  metadata: Record<string, unknown> | undefined | null,
  key: string,
  legacyKey: string,
): { meta: Meta | undefined; value: unknown } {
  const current = takeMetaKey(metadata, key);
  const legacy = takeMetaKey(current.meta, legacyKey);
  return { meta: legacy.meta, value: current.value !== undefined ? current.value : legacy.value };
}

function toUint8Array(buf: Uint8Array): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ─── Parts ──────────────────────────────────────────────────────────────────

function fromLegacyPart(p: Record<string, unknown>): CorePart {
  const meta = isObject(p.metadata) ? p.metadata : undefined;
  switch (p.kind) {
    case "text":
      if (typeof p.text === "string") return { kind: "text", text: p.text, ...(meta ? { meta } : {}) };
      break;
    case "data":
      return { kind: "data", data: p.data, ...(meta ? { meta } : {}) };
    case "file": {
      const f = isObject(p.file) ? p.file : undefined;
      if (!f) break;
      const mt = f.mimeType ?? f.mediaType;
      const common = {
        ...(typeof f.name === "string" && f.name ? { name: f.name } : {}),
        ...(typeof mt === "string" && mt ? { mediaType: mt } : {}),
        ...(meta ? { meta } : {}),
      };
      if (typeof f.uri === "string" && f.uri) return { kind: "file", ...common, uri: f.uri };
      if (typeof f.bytes === "string") {
        return { kind: "file", ...common, bytes: new Uint8Array(Buffer.from(f.bytes, "base64")) };
      }
      break;
    }
  }
  return { kind: "unknown", raw: p };
}

/**
 * A2A part to core part. Accepts a v1 `Part` (or, tolerated, a v0.3-shaped
 * part). Anything it cannot model becomes `{kind: "unknown", raw}`.
 */
export function fromA2APart(part: Part): CorePart {
  if (!isObject(part)) return { kind: "unknown", raw: part };
  const p = part as unknown as Record<string, unknown>;
  const content = p.content as { $case?: string; value?: unknown } | undefined;
  if (content === undefined && typeof p.kind === "string") return fromLegacyPart(p);
  if (!isObject(content) || typeof content.$case !== "string") return { kind: "unknown", raw: part };

  const metadata = isObject(p.metadata) ? (p.metadata as Record<string, unknown>) : undefined;
  const mediaType = typeof p.mediaType === "string" && p.mediaType ? p.mediaType : undefined;
  const name = typeof p.filename === "string" && p.filename ? p.filename : undefined;

  switch (content.$case) {
    case "text":
      return {
        kind: "text",
        text: content.value as string,
        ...(mediaType ? { mediaType } : {}),
        ...(metadata ? { meta: metadata } : {}),
      };
    case "data": {
      const marked = takeVersionedKey(metadata, UNKNOWN_PART_META_KEY, LEGACY_WIRE_KEYS.unknownPart);
      if (marked.value === true) return { kind: "unknown", raw: content.value };
      return {
        kind: "data",
        data: content.value,
        ...(mediaType ? { mediaType } : {}),
        ...(metadata ? { meta: metadata } : {}),
      };
    }
    case "raw": {
      const { meta, value: uri } = takeVersionedKey(metadata, FILE_URI_META_KEY, LEGACY_WIRE_KEYS.fileUri);
      return {
        kind: "file",
        ...(name ? { name } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(typeof uri === "string" && uri ? { uri } : {}),
        bytes: toUint8Array(content.value as Uint8Array),
        ...(meta ? { meta } : {}),
      };
    }
    case "url": {
      const uri = content.value as string;
      // A file with no source is not a file part: keep it as it came.
      if (typeof uri !== "string" || !uri) return { kind: "unknown", raw: part };
      return {
        kind: "file",
        ...(name ? { name } : {}),
        ...(mediaType ? { mediaType } : {}),
        uri,
        ...(metadata ? { meta: metadata } : {}),
      };
    }
    default:
      return { kind: "unknown", raw: part };
  }
}

function looksLikeA2APart(raw: unknown): raw is Part {
  if (!isObject(raw)) return false;
  const c = raw.content as { $case?: unknown } | undefined;
  return isObject(c) && typeof c.$case === "string";
}

/**
 * Core part to A2A part. An `unknown` part whose `raw` is itself an A2A part is
 * emitted as is; any other `unknown` is wrapped in a marked `data` part that
 * {@link fromA2APart} unwraps, so it survives a round trip.
 */
export function toA2APart(part: CorePart): Part {
  switch (part.kind) {
    case "text":
      return {
        content: { $case: "text", value: part.text },
        metadata: part.meta,
        filename: "",
        mediaType: part.mediaType ?? "",
      };
    case "data":
      return {
        content: { $case: "data", value: part.data },
        metadata: part.meta,
        filename: "",
        mediaType: part.mediaType ?? "",
      };
    case "file": {
      if (part.bytes) {
        const metadata =
          part.uri !== undefined ? { ...(part.meta ?? {}), [FILE_URI_META_KEY]: part.uri } : part.meta;
        return {
          content: { $case: "raw", value: Buffer.from(part.bytes) },
          metadata,
          filename: part.name ?? "",
          mediaType: part.mediaType ?? "",
        };
      }
      return {
        content: { $case: "url", value: part.uri },
        metadata: part.meta,
        filename: part.name ?? "",
        mediaType: part.mediaType ?? "",
      };
    }
    case "unknown":
    default: {
      const raw = (part as { raw?: unknown }).raw;
      if (looksLikeA2APart(raw)) return raw;
      return {
        content: { $case: "data", value: raw },
        metadata: { [UNKNOWN_PART_META_KEY]: true },
        filename: "",
        mediaType: "",
      };
    }
  }
}

// ─── Task state ─────────────────────────────────────────────────────────────

const V1_TO_CORE: Partial<Record<number, CoreTaskState>> = {
  [TaskState.TASK_STATE_SUBMITTED]: "submitted",
  [TaskState.TASK_STATE_WORKING]: "working",
  [TaskState.TASK_STATE_INPUT_REQUIRED]: "input-required",
  [TaskState.TASK_STATE_AUTH_REQUIRED]: "auth-required",
  [TaskState.TASK_STATE_COMPLETED]: "completed",
  [TaskState.TASK_STATE_FAILED]: "failed",
  [TaskState.TASK_STATE_CANCELED]: "canceled",
  [TaskState.TASK_STATE_REJECTED]: "rejected",
};

const CORE_TO_V1: Record<string, TaskState> = {
  submitted: TaskState.TASK_STATE_SUBMITTED,
  working: TaskState.TASK_STATE_WORKING,
  "input-required": TaskState.TASK_STATE_INPUT_REQUIRED,
  "auth-required": TaskState.TASK_STATE_AUTH_REQUIRED,
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  canceled: TaskState.TASK_STATE_CANCELED,
  rejected: TaskState.TASK_STATE_REJECTED,
};

/** Wire-name strings (`TASK_STATE_WORKING`) to core state. */
const V1_NAME_TO_CORE: Record<string, CoreTaskState> = Object.fromEntries(
  Object.entries(TaskState)
    .filter(([, v]) => typeof v === "number" && V1_TO_CORE[v] !== undefined)
    .map(([k, v]) => [k, V1_TO_CORE[v as number] as CoreTaskState]),
);

/**
 * A2A task state to core state. Accepts the v1 enum, the v1 wire name
 * (`"TASK_STATE_WORKING"`) and v0.3 lowercase-hyphen strings. `UNSPECIFIED` and
 * unrecognised numbers become `"unknown"`; an unrecognised string is returned
 * unchanged (the type is open).
 */
export function fromA2ATaskState(state: TaskState | string | number | undefined | null): CoreTaskState {
  if (typeof state === "number") return V1_TO_CORE[state] ?? "unknown";
  if (typeof state === "string") {
    if (Object.hasOwn(CORE_TO_V1, state)) return state;
    if (Object.hasOwn(V1_NAME_TO_CORE, state)) return V1_NAME_TO_CORE[state]!;
    if (state === "TASK_STATE_UNSPECIFIED" || state === "UNRECOGNIZED") return "unknown";
    return state || "unknown";
  }
  return "unknown";
}

/**
 * Core state to the v1 enum. A state with no v1 equivalent (including
 * `"unknown"`) maps to `TASK_STATE_WORKING`, never to `TASK_STATE_UNSPECIFIED`
 * (clients do not know what to do with it); {@link toStatusUpdate} keeps the
 * original string in versioned metadata so it is not lost.
 */
export function toA2ATaskState(state: CoreTaskState): TaskState {
  return (Object.hasOwn(CORE_TO_V1, state) ? CORE_TO_V1[state] : undefined) ?? coreToV1ByWireName(state) ?? TaskState.TASK_STATE_WORKING;
}

function coreToV1ByWireName(state: string): TaskState | undefined {
  const core = Object.hasOwn(V1_NAME_TO_CORE, state) ? V1_NAME_TO_CORE[state] : undefined;
  return core ? CORE_TO_V1[core] : undefined;
}

/** `true` if the state has a v1 equivalent and needs no metadata to survive. */
export function isRepresentableState(state: CoreTaskState): boolean {
  return Object.hasOwn(CORE_TO_V1, state);
}

/// ─── Messages ───────────────────────────────────────────────────────────────

/** Options for {@link fromA2AMessage}. */
export interface FromMessageOptions {
  /** Who sent it. A2A carries no sender identity; defaults to anonymous. */
  from?: CoreCaller;
  /** ISO timestamp. A2A messages carry none; defaults to now. */
  at?: string;
}

const DELIVERY_WORDS = ["queue", "steer", "interrupt"];

/** Delivery intent from the assumed steering-extension value (see {@link STEERING_EXTENSION_ALIAS}). */
function deliveryFromSteeringAlias(value: unknown): string | undefined {
  if (typeof value === "string") return DELIVERY_WORDS.includes(value) ? value : undefined;
  if (!isObject(value)) return undefined;
  for (const k of ["action", "mode", "type", "delivery"]) {
    const v = value[k];
    if (typeof v === "string" && DELIVERY_WORDS.includes(v)) return v;
  }
  return undefined;
}

/**
 * A2A message to core message. `delivery` is read from message metadata
 * ({@link DELIVERY_META_KEY}, else the legacy unversioned key, else the steering
 * alias {@link STEERING_EXTENSION_ALIAS}); a non-string value is ignored. An
 * unspecified or unknown role is treated as `"user"`.
 */
export function fromA2AMessage(message: Message, options: FromMessageOptions = {}): CoreMessage {
  const own = takeVersionedKey(message.metadata, DELIVERY_META_KEY, LEGACY_WIRE_KEYS.delivery);
  const alias = takeMetaKey(own.meta, STEERING_EXTENSION_ALIAS);
  const delivery =
    typeof own.value === "string" && own.value ? own.value : deliveryFromSteeringAlias(alias.value);
  return {
    id: message.messageId,
    role: message.role === Role.ROLE_AGENT ? "agent" : "user",
    parts: (message.parts ?? []).map(fromA2APart),
    from: options.from ?? { ...ANONYMOUS_CALLER },
    ...(delivery ? { delivery } : {}),
    at: options.at ?? new Date().toISOString(),
    ...(alias.meta ? { meta: alias.meta } : {}),
  };
}

/**
 * A2A message from a task's stored history to a core history message. A2A stores
 * no sender and no timestamp, so neither is invented: `from` and `at` stay
 * absent, and a past user message is never attributed to the current caller.
 */
export function fromA2AHistoryMessage(message: Message): HistoryMessage {
  const { from: _from, at: _at, ...rest } = fromA2AMessage(message);
  return rest;
}

/** Core message to A2A message. The sender identity has no A2A field and is not sent. */
export function toA2AMessage(
  message: CoreMessage,
  ids: { taskId?: string; contextId?: string } = {},
): Message {
  const metadata =
    message.delivery !== undefined ? { ...(message.meta ?? {}), [DELIVERY_META_KEY]: message.delivery } : message.meta;
  return {
    messageId: message.id,
    contextId: ids.contextId ?? "",
    taskId: ids.taskId ?? "",
    role: message.role === "agent" ? Role.ROLE_AGENT : Role.ROLE_USER,
    parts: message.parts.map(toA2APart),
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

// ─── Request ────────────────────────────────────────────────────────────────

/** Options for {@link coreRequestFromContext}. */
export interface CoreRequestOptions {
  /** Core-assigned id of this run (one per task). */
  runId: string;
  /** Core-assigned id of this turn (one per turn of the run). Defaults to a fresh UUID. */
  turnId?: string;
  /** Overrides the caller derived from the SDK call context. */
  caller?: CoreCaller;
  /** Persisted provider session for the context, if any. */
  session?: SessionRef;
  /** Correlation event id. Defaults to a fresh UUID. */
  eventId?: string;
}

/**
 * Caller as the SDK call context knows it. Unauthenticated is `anonymous`. The
 * SDK `User` carries only a name; when an authentication layer attaches
 * `scopes` (string array) or `claims` (JSON object) to that user object they are
 * kept on the caller.
 */
export function callerFromContext(ctx: RequestContext): CoreCaller {
  const user = ctx.context?.user as
    | { isAuthenticated?: boolean; userName?: string; scopes?: unknown; claims?: unknown }
    | undefined;
  if (user && user.isAuthenticated && user.userName) {
    const scopes =
      Array.isArray(user.scopes) && user.scopes.every((s) => typeof s === "string") ? (user.scopes as string[]) : undefined;
    const claims = isJsonObject(user.claims) ? user.claims : undefined;
    return {
      id: user.userName,
      kind: "user",
      ...(scopes ? { scopes } : {}),
      ...(claims ? { claims } : {}),
    };
  }
  return { ...ANONYMOUS_CALLER };
}

/**
 * Build the provider-facing {@link CoreRequest} from an SDK `RequestContext`:
 * input parts from the user message, history from the stored task (sender and
 * time unknown, see {@link fromA2AHistoryMessage}), caller from the call
 * context, correlation from the request metadata, the W3C `traceparent` /
 * `tracestate` when the caller sent a valid one, and negotiated extensions.
 */
export function coreRequestFromContext(ctx: RequestContext, options: CoreRequestOptions): CoreRequest {
  const caller = options.caller ?? callerFromContext(ctx);
  const message = ctx.userMessage;

  const history = (ctx.task?.history ?? []).map(fromA2AHistoryMessage);

  const extensions = new Map<string, unknown>();
  for (const uri of message?.extensions ?? []) extensions.set(uri, true);
  for (const uri of ctx.context?.requestedExtensions ?? []) extensions.set(uri, true);

  const trace = extractA2ATraceContext(ctx);
  const carrier = collectInboundCarrier(ctx, ["header", "metadata"]);
  const traceparent = carrier
    ? `${carrier.parsed.version}-${carrier.parsed.traceId}-${carrier.parsed.spanId}-${carrier.parsed.traceFlags
        .toString(16)
        .padStart(2, "0")}`
    : undefined;

  return {
    runId: options.runId,
    turnId: options.turnId ?? uuidv4(),
    taskId: ctx.taskId,
    contextId: ctx.contextId,
    input: (message?.parts ?? []).map(fromA2APart),
    history,
    caller,
    ...(options.session ? { session: options.session } : {}),
    correlation: {
      eventId: options.eventId ?? uuidv4(),
      ...(trace.parentAgentId ? { parentAgentId: trace.parentAgentId } : {}),
      trace: {
        ...(traceparent ? { traceparent } : {}),
        ...(carrier?.tracestate ? { tracestate: carrier.tracestate } : {}),
        traceId: trace.traceId,
        conversationId: trace.conversationId,
        ...(trace.sessionId ? { sessionId: trace.sessionId } : {}),
      },
      metadata: trace.metadata,
    },
    extensions,
  };
}

// ─── Status, artifacts, usage ───────────────────────────────────────────────

/** Input for {@link toStatusUpdate}. */
export interface StatusUpdateInput {
  taskId: string;
  contextId: string;
  state: CoreTaskState;
  /** Convenience: a single text part. Ignored when `parts` is given. */
  text?: string;
  /** Message parts. Omit both `text` and `parts` for a status with no message. */
  parts?: readonly CorePart[];
  /** Extension URIs the status message belongs to. */
  messageExtensions?: readonly string[];
  /** Event metadata. */
  metadata?: Meta;
  timestamp?: string;
  messageId?: string;
}

/**
 * Core status to an SDK `TaskStatusUpdateEvent` (the `data` of a
 * `{kind: "statusUpdate"}` bus event). A state with no v1 equivalent is sent as
 * `TASK_STATE_WORKING` (never `TASK_STATE_UNSPECIFIED`) with the original in
 * {@link CORE_STATE_META_KEY}.
 */
export function toStatusUpdate(input: StatusUpdateInput): TaskStatusUpdateEvent {
  const parts: readonly CorePart[] | undefined =
    input.parts ?? (input.text ? [{ kind: "text", text: input.text }] : undefined);
  const message: Message | undefined =
    parts && parts.length > 0
      ? {
          messageId: input.messageId ?? uuidv4(),
          contextId: input.contextId,
          taskId: input.taskId,
          role: Role.ROLE_AGENT,
          parts: parts.map(toA2APart),
          metadata: undefined,
          extensions: [...(input.messageExtensions ?? [])],
          referenceTaskIds: [],
        }
      : undefined;
  const metadata = !isRepresentableState(input.state)
    ? { ...(input.metadata ?? {}), [CORE_STATE_META_KEY]: input.state }
    : input.metadata;
  return {
    taskId: input.taskId,
    contextId: input.contextId,
    status: {
      state: toA2ATaskState(input.state),
      message,
      timestamp: input.timestamp ?? new Date().toISOString(),
    },
    metadata,
  };
}

/** A status update read back into core terms. */
export interface CoreStatusUpdate {
  taskId: string;
  contextId: string;
  state: CoreTaskState;
  message?: CoreMessage;
  timestamp?: string;
  metadata?: Meta;
}

/**
 * SDK status update to core terms. A state carried in {@link CORE_STATE_META_KEY}
 * (or the legacy unversioned key) is restored when the wire state is `working`
 * or `unspecified` and the carried state is one core does not model; a carried
 * state that disagrees with the wire (a known state on a non-working wire state)
 * is ignored. Use {@link classifyState} on the result: `"unknown"` must be
 * handled by the caller.
 */
export function fromStatusUpdate(event: TaskStatusUpdateEvent, options: FromMessageOptions = {}): CoreStatusUpdate {
  const { meta, value: preserved } = takeVersionedKey(event.metadata, CORE_STATE_META_KEY, LEGACY_WIRE_KEYS.coreState);
  const wire = event.status?.state;
  const restorable =
    (wire === TaskState.TASK_STATE_WORKING || wire === TaskState.TASK_STATE_UNSPECIFIED) &&
    typeof preserved === "string" &&
    preserved !== "" &&
    !isRepresentableState(preserved);
  const state = restorable ? (preserved as string) : fromA2ATaskState(wire);
  return {
    taskId: event.taskId,
    contextId: event.contextId,
    state,
    ...(event.status?.message ? { message: fromA2AMessage(event.status.message, options) } : {}),
    ...(event.status?.timestamp ? { timestamp: event.status.timestamp } : {}),
    ...(meta ? { metadata: meta } : {}),
  };
}

/** Core artifact to an SDK `TaskArtifactUpdateEvent`. An artifact without an id gets a UUID. */
export function toArtifactUpdate(
  taskId: string,
  contextId: string,
  artifact: CoreArtifact,
  metadata?: Meta,
): TaskArtifactUpdateEvent {
  return {
    taskId,
    contextId,
    artifact: {
      artifactId: artifact.id ?? uuidv4(),
      name: artifact.name ?? "",
      description: artifact.description ?? "",
      parts: artifact.parts.map(toA2APart),
      metadata: artifact.meta,
      extensions: [],
    },
    append: artifact.append ?? false,
    lastChunk: artifact.lastChunk ?? false,
    metadata,
  };
}

/** SDK artifact to core artifact. */
export function fromA2AArtifact(
  artifact: Artifact,
  flags: { append?: boolean; lastChunk?: boolean } = {},
): CoreArtifact {
  return {
    id: artifact.artifactId,
    ...(artifact.name ? { name: artifact.name } : {}),
    ...(artifact.description ? { description: artifact.description } : {}),
    parts: (artifact.parts ?? []).map(fromA2APart),
    ...(flags.append ? { append: true } : {}),
    ...(flags.lastChunk ? { lastChunk: true } : {}),
    ...(artifact.metadata ? { meta: artifact.metadata } : {}),
  };
}

/**
 * Render usage as event metadata under {@link USAGE_META_KEY}, ready to pass as
 * `metadata` to {@link toStatusUpdate} or {@link toArtifactUpdate}. Only defined
 * fields are included; `costUsd: null` (provider reports no cost) is kept.
 */
export function usageToMetadata(usage: CoreUsage): Meta {
  const counters = (src: object | undefined): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries((src ?? {}) as Record<string, unknown>)) if (k !== "costUsd" && typeof v === "number") out[k] = v;
    return out;
  };
  const byModel =
    usage.byModel &&
    Object.fromEntries(
      Object.entries(usage.byModel).map(([model, u]) => [
        model,
        { ...counters(u), ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}) },
      ]),
    );
  return {
    [USAGE_META_KEY]: {
      scope: usage.scope,
      ...(usage.series !== undefined ? { series: usage.series } : {}),
      tokens: counters(usage.tokens),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      ...(usage.contextWindow ? { contextWindow: { ...usage.contextWindow } } : {}),
      ...(usage.model ? { model: usage.model } : {}),
      ...(byModel ? { byModel } : {}),
    },
  };
}

function modelUsageFrom(raw: unknown): ModelUsage | undefined {
  if (!isObject(raw)) return undefined;
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "costUsd") {
      if (v === null || typeof v === "number") out[k] = v;
    } else if (typeof v === "number") out[k] = v;
  }
  return out as ModelUsage;
}

/** Read usage back from event metadata (versioned key, else the legacy one), or `undefined` if absent or malformed. */
export function usageFromMetadata(metadata: Meta | undefined | null): CoreUsage | undefined {
  const raw = metadata?.[USAGE_META_KEY] ?? metadata?.[LEGACY_WIRE_KEYS.usage];
  if (!isObject(raw)) return undefined;
  if (raw.scope !== "delta" && raw.scope !== "cumulative") return undefined;
  if (!isObject(raw.tokens)) return undefined;
  const usage: CoreUsage = { scope: raw.scope, tokens: { ...(raw.tokens as CoreUsage["tokens"]) } };
  if (typeof raw.series === "string") usage.series = raw.series;
  if ("costUsd" in raw && (raw.costUsd === null || typeof raw.costUsd === "number")) usage.costUsd = raw.costUsd;
  if (isObject(raw.contextWindow)) usage.contextWindow = { ...(raw.contextWindow as CoreUsage["contextWindow"]) };
  if (typeof raw.model === "string") usage.model = raw.model;
  if (isObject(raw.byModel)) {
    const byModel: Record<string, ModelUsage> = {};
    for (const [model, u] of Object.entries(raw.byModel)) {
      const m = modelUsageFrom(u);
      if (m) byModel[model] = m;
    }
    usage.byModel = byModel;
  }
  return usage;
}

// ─── Interactions: rendering ────────────────────────────────────────────────

/** An interaction rendered for the wire. */
export interface RenderedInteraction {
  /** `auth-required` for an auth interaction, `input-required` for everything else. */
  state: CoreTaskState;
  /** Plain text rendering, options numbered. Always present. */
  text: string;
  /** `[text]`, plus the structured data part when `structured` is on. */
  parts: CorePart[];
  /** Extension URIs to set on the status message (the interaction extension when structured). */
  extensions: string[];
}

/** Every field of every kind, for code that handles all kinds the same way. */
const view = (i: CoreInteraction): UnknownInteraction => i as UnknownInteraction;

/** Task state an interaction parks the task in. Unknown kinds ask for input. */
export function interactionTaskState(interaction: Pick<CoreInteraction, "kind">): CoreTaskState {
  return interaction.kind === "auth" ? "auth-required" : "input-required";
}

/**
 * The structured payload of the interaction data part: `{version, interactionId,
 * interaction}`. Provider-internal `meta` is not sent.
 */
export function interactionPayload(interaction: CoreInteraction): Record<string, unknown> {
  const { meta: _meta, ...rest } = interaction;
  return { version: 1, interactionId: interaction.id, interaction: rest };
}

/** Plain text rendering of an interaction, with numbered options and the reply code. */
export function renderInteractionText(interaction: CoreInteraction): string {
  const i = view(interaction);
  const lines: string[] = [];
  if (i.kind === "auth" && i.auth) {
    lines.push(i.title || `Authentication required for ${i.auth.service}`);
  } else {
    lines.push(i.title);
  }
  if (i.description) lines.push(i.description);

  const s = i.subject;
  if (s) {
    const facts: string[] = [];
    if (s.tool) facts.push(`Tool: ${s.tool}`);
    if (s.action) facts.push(`Action: ${s.action}`);
    if (s.command) facts.push(`Command: ${s.command}`);
    if (s.resources?.length) facts.push(`Resources: ${s.resources.join(", ")}`);
    if (s.risk) facts.push(`Risk: ${s.risk}`);
    if (facts.length) lines.push(facts.join("\n"));
  }

  if (i.auth) {
    if (i.auth.url) lines.push(`Sign in at: ${i.auth.url}`);
    if (i.auth.userCode) lines.push(`Code: ${i.auth.userCode}`);
    if (i.auth.instructions) lines.push(i.auth.instructions);
    lines.push("Reply when you have finished signing in.");
  }

  if (i.options?.length) {
    lines.push(i.options.map((o, n) => `${n + 1}. ${o.label}`).join("\n"));
    lines.push(
      i.replyCode
        ? `Reply with the option number and the code, for example \`1 ${i.replyCode}\`.`
        : "Reply with the option number or its label.",
    );
  }

  if (i.questions?.length) {
    const qs = i.questions;
    qs.forEach((q, qn) => {
      const head = `${qs.length > 1 ? `Question ${qn + 1}` : "Question"}${q.header ? ` (${q.header})` : ""}: ${q.prompt}`;
      const opts = (q.options ?? []).map((o, n) => `  ${n + 1}. ${o.label}${o.description ? ` - ${o.description}` : ""}`);
      const notes: string[] = [];
      if (q.multi) notes.push("choose one or more, comma separated");
      if (q.allowFreeform) notes.push("free text accepted");
      if (q.secret) notes.push("secret");
      lines.push([head, ...opts, ...(notes.length ? [`  (${notes.join("; ")})`] : [])].join("\n"));
    });
  }

  if (i.schema?.properties) {
    const required = new Set(i.schema.required ?? []);
    lines.push(
      Object.entries(i.schema.properties)
        .map(([name, p]) => {
          const type = p.type === "array" ? "multi-select" : p.type;
          const choices = (p.oneOf ?? []).map((c) => c.title).concat((p.items?.anyOf ?? []).map((c) => c.title));
          return `- ${name}${type ? ` (${type}${required.has(name) ? ", required" : ""})` : required.has(name) ? " (required)" : ""}${p.title ? `: ${p.title}` : ""}${choices.length ? ` [${choices.join(" | ")}]` : ""}`;
        })
        .join("\n"),
    );
  }

  return lines.filter((l) => l !== "").join("\n");
}

/**
 * Render an interaction for the wire: the state, the text, and the message
 * parts. `structured: false` (a client that did not activate
 * {@link INTERACTION_EXTENSION_URI}) yields the text rendering only; core still
 * parses text replies. Default `structured: true`.
 */
export function renderInteraction(
  interaction: CoreInteraction,
  options: { structured?: boolean } = {},
): RenderedInteraction {
  const structured = options.structured ?? true;
  const text = renderInteractionText(interaction);
  const parts: CorePart[] = [{ kind: "text", text }];
  if (structured) {
    parts.push({ kind: "data", data: interactionPayload(interaction), mediaType: "application/json" });
  }
  return {
    state: interactionTaskState(interaction),
    text,
    parts,
    extensions: structured ? [INTERACTION_EXTENSION_URI] : [],
  };
}

/** Status update that parks the task on an interaction (`input-required` / `auth-required`). */
export function toInteractionStatusUpdate(
  taskId: string,
  contextId: string,
  interaction: CoreInteraction,
  options: { structured?: boolean; metadata?: Meta; timestamp?: string } = {},
): TaskStatusUpdateEvent {
  const r = renderInteraction(interaction, options);
  return toStatusUpdate({
    taskId,
    contextId,
    state: r.state,
    parts: r.parts,
    messageExtensions: r.extensions,
    metadata: options.metadata,
    timestamp: options.timestamp,
  });
}

// ─── Interactions: reply parsing ────────────────────────────────────────────

const norm = (s: string) => s.trim().toLowerCase();
const APPROVE_WORDS = new Set(["approve", "allow", "yes", "y"]);
const DENY_WORDS = new Set(["deny", "reject", "no", "n", "decline"]);
const DONE_WORDS = new Set(["done", "completed", "authenticated", "signed in"]);

function replyText(parts: readonly CorePart[]): string {
  return parts
    .map((p) => (p.kind === "text" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Match a token against numbered options by 1-based number, id, then label. */
function matchByToken<T extends { id: string; label: string }>(token: string, options: readonly T[]): T | undefined {
  const t = norm(token);
  if (!t) return undefined;
  if (/^\d+$/.test(t)) return options[Number(t) - 1];
  return options.find((o) => norm(o.id) === t) ?? options.find((o) => norm(o.label) === t);
}

/** Remove one token equal to the reply code (ignoring case and wrapping punctuation). */
function takeReplyCode(text: string, code: string | undefined): { text: string; hadCode: boolean } {
  if (!code) return { text, hadCode: false };
  const tokens = text.trim().split(/\s+/);
  const at = tokens.findIndex((t) => t.replace(/^[`#*_([]+|[`*_.,;:!)\]]+$/g, "").toUpperCase() === code.toUpperCase());
  if (at < 0) return { text, hadCode: false };
  tokens.splice(at, 1);
  return { text: tokens.join(" "), hadCode: true };
}

/** Does `v` satisfy one property of a flat form schema? */
function matchesProperty(p: FlatSchemaProperty, v: unknown): boolean {
  if (p.type === "array") {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return false;
    if (typeof p.minItems === "number" && v.length < p.minItems) return false;
    if (typeof p.maxItems === "number" && v.length > p.maxItems) return false;
    const allowed = p.items?.enum ?? p.items?.anyOf?.map((c) => c.const);
    return !allowed || v.every((x) => allowed.includes(x));
  }
  if (p.type === "string" && typeof v !== "string") return false;
  if ((p.type === "number" || p.type === "integer") && typeof v !== "number") return false;
  if (p.type === "integer" && !Number.isInteger(v)) return false;
  if (p.type === "boolean" && typeof v !== "boolean") return false;
  if (Array.isArray(p.enum) && !p.enum.includes(v as never)) return false;
  if (Array.isArray(p.oneOf) && !p.oneOf.some((c) => c.const === v)) return false;
  return true;
}

function parseStructured(
  interaction: CoreInteraction,
  data: Record<string, unknown>,
  by: CoreCaller,
): CoreInteractionResult | undefined {
  const i = view(interaction);

  if (typeof data.optionId === "string") {
    const option = i.options?.find((o) => o.id === data.optionId);
    if (!option) return undefined;
    if (data.amendment !== undefined && !isJsonObject(data.amendment)) return undefined;
    return {
      outcome: "selected",
      optionId: option.id,
      ...(typeof data.feedback === "string" && data.feedback ? { feedback: data.feedback } : {}),
      ...(data.amendment !== undefined ? { amendment: data.amendment as JsonObject } : {}),
      by,
    };
  }

  if (isObject(data.answers) && i.questions?.length) {
    const answers: Record<string, { optionIds?: string[]; text?: string; freeText?: string }> = {};
    const given = data.answers as Record<string, unknown>;
    for (const key of Object.keys(given)) {
      if (!i.questions.some((q) => q.id === key)) return undefined;
    }
    for (const q of i.questions) {
      const a = Object.hasOwn(given, q.id) ? given[q.id] : undefined;
      if (!isObject(a)) return undefined;
      const entry: { optionIds?: string[]; text?: string; freeText?: string } = {};
      if (a.optionIds !== undefined) {
        if (!Array.isArray(a.optionIds) || !a.optionIds.every((x) => typeof x === "string")) return undefined;
        const ids = a.optionIds as string[];
        if (!ids.every((id) => q.options?.some((o) => o.id === id))) return undefined;
        if (ids.length > 1 && !q.multi) return undefined;
        entry.optionIds = ids;
      }
      if (a.text !== undefined) {
        if (typeof a.text !== "string") return undefined;
        if (q.options?.length && !q.allowFreeform) return undefined;
        entry.text = a.text;
      }
      if (a.freeText !== undefined) {
        if (typeof a.freeText !== "string" || !q.allowFreeform) return undefined;
        entry.freeText = a.freeText;
      }
      if (entry.optionIds === undefined && entry.text === undefined && entry.freeText === undefined) return undefined;
      answers[q.id] = entry;
    }
    return { outcome: "answered", answers, by };
  }

  if (isObject(data.values) && i.schema) {
    if (!isJsonObject(data.values)) return undefined;
    const values = data.values;
    const props = i.schema.properties ?? {};
    for (const [k, v] of Object.entries(values)) {
      // Own properties only: a key like "constructor" must not pass for a declared field.
      if (!Object.hasOwn(props, k)) return undefined;
      if (!matchesProperty(props[k]!, v)) return undefined;
    }
    for (const r of i.schema.required ?? []) if (!Object.hasOwn(values, r)) return undefined;
    return { outcome: "submitted", values, by };
  }

  if (data.declined === true) {
    return {
      outcome: "declined",
      ...(typeof data.feedback === "string" && data.feedback ? { feedback: data.feedback } : {}),
      by,
    };
  }
  if (data.dismissed === true) return { outcome: "dismissed", by };
  if (data.completed === true && i.kind === "auth") return { outcome: "completed", by };
  return undefined;
}

function parseText(interaction: CoreInteraction, rawText: string, by: CoreCaller): CoreInteractionResult | undefined {
  const i = view(interaction);
  if (!norm(rawText)) return undefined;

  const options = i.options;
  if (options?.length) {
    // An allow_* option is chosen from text only with the presented interaction's
    // code, so a stale "yes" meant for an earlier interaction cannot approve this one.
    const { text, hadCode } = takeReplyCode(rawText.trim().replace(/^`+|`+$/g, ""), i.replyCode);
    const t = norm(text);
    if (!t) return undefined;
    const approving = (o: { kind: string }) => APPROVING_OPTION_KINDS.includes(o.kind);
    const hit = matchByToken(text, options);
    if (hit) {
      if (approving(hit) && !hadCode) return undefined;
      return { outcome: "selected", optionId: hit.id, by };
    }
    if (APPROVE_WORDS.has(t)) {
      if (!hadCode) return undefined;
      const allow = options.find((o) => o.kind === "allow_once");
      return allow ? { outcome: "selected", optionId: allow.id, by } : undefined;
    }
    if (DENY_WORDS.has(t)) {
      const reject = options.find((o) => o.kind === "reject_once");
      return reject ? { outcome: "selected", optionId: reject.id, by } : { outcome: "declined", by };
    }
    return undefined;
  }

  const t = norm(rawText);
  const qs = i.questions;
  // With questions, "no" and "n" are answers, not refusals: decline only via a structured `declined`.
  if (!qs?.length && DENY_WORDS.has(t)) return { outcome: "declined", by };
  if (i.kind === "auth" && DONE_WORDS.has(t)) return { outcome: "completed", by };

  if (qs?.length === 1) {
    const q = qs[0]!;
    const text = rawText;
    if (q.options?.length) {
      const tokens = q.multi ? text.split(",") : [text];
      const hits = tokens.map((tok) => matchByToken(tok, q.options!));
      if (hits.every(Boolean)) {
        return { outcome: "answered", answers: { [q.id]: { optionIds: hits.map((h) => h!.id) } }, by };
      }
    }
    if (q.allowFreeform || !q.options?.length) {
      return { outcome: "answered", answers: { [q.id]: { text: text.trim() } }, by };
    }
  }
  return undefined;
}

/**
 * Parse a caller's reply to the PRESENTED interaction into a result, or
 * `undefined` when the message is not a valid reply (so core ignores it with no
 * side effect).
 *
 * Structured first: a data part `{interactionId, optionId | answers | values |
 * declined | dismissed | completed}`. A data part naming another interaction id
 * makes the whole message not-a-reply. Text fallback second: option number, id
 * or label; `approve`/`allow`/`yes` select the first `allow_once` option only
 * (never an `allow_always`); `deny`/`reject`/`no` select the first `reject_once`
 * option or decline. Selecting any `allow_*` option from text requires the
 * interaction's `replyCode` in the reply ("1 K7"); no code, a wrong code, or an
 * interaction with no code means the reply is ignored. Anything ambiguous,
 * unknown or invalid is `undefined`: a reply never approves by guesswork (D5).
 * With questions, a free-form answer such as "no" is an answer, never a refusal.
 */
export function parseInteractionReply(
  interaction: CoreInteraction,
  parts: readonly CorePart[],
  by: CoreCaller,
): CoreInteractionResult | undefined {
  const structured = parts.filter(
    (p): p is Extract<CorePart, { kind: "data" }> =>
      p.kind === "data" && isObject(p.data) && typeof (p.data as Record<string, unknown>).interactionId === "string",
  );
  if (structured.length > 0) {
    const mine = structured.filter((p) => (p.data as Record<string, unknown>).interactionId === interaction.id);
    if (mine.length === 0 || mine.length !== structured.length) return undefined;
    return parseStructured(interaction, mine[0]!.data as Record<string, unknown>, by);
  }
  return parseText(interaction, replyText(parts), by);
}
