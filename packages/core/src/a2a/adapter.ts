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
 * v1 equivalent is sent as `TASK_STATE_UNSPECIFIED` with the original string in
 * status metadata ({@link CORE_STATE_META_KEY}) and restored on the way back.
 *
 * @see docs/design/core-data-model.md section 4
 */

import { Role, TaskState } from "@a2a-js/sdk";
import type { Artifact, Message, Part, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type { RequestContext } from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";
import { extractA2ATraceContext } from "../telemetry/context.js";
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
  Meta,
  SessionRef,
} from "../model/index.js";
import { ANONYMOUS_CALLER } from "../model/index.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Extension URI under which structured interaction data parts are advertised. */
export const INTERACTION_EXTENSION_URI = "urn:a2a-wrapper:interaction:v1";

/** Part metadata key marking a `data` part that carries an unknown core part verbatim. */
export const UNKNOWN_PART_META_KEY = "urn:a2a-wrapper:unknown-part";
/** Part metadata key preserving a file `uri` when the part also carries bytes. */
export const FILE_URI_META_KEY = "urn:a2a-wrapper:file-uri";
/** Status metadata key preserving a core task state that has no v1 equivalent. */
export const CORE_STATE_META_KEY = "urn:a2a-wrapper:core-state";
/** Message metadata key carrying the caller's `delivery` intent (queue, steer, interrupt). */
export const DELIVERY_META_KEY = "urn:a2a-wrapper:delivery";
/** Metadata key under which usage is rendered. */
export const USAGE_META_KEY = "urn:a2a-wrapper:usage";

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
      const out: Extract<CorePart, { kind: "file" }> = { kind: "file" };
      if (typeof f.name === "string" && f.name) out.name = f.name;
      const mt = f.mimeType ?? f.mediaType;
      if (typeof mt === "string" && mt) out.mediaType = mt;
      if (typeof f.uri === "string") out.uri = f.uri;
      else if (typeof f.bytes === "string") out.bytes = new Uint8Array(Buffer.from(f.bytes, "base64"));
      else break;
      if (meta) out.meta = meta;
      return out;
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
      const marked = takeMetaKey(metadata, UNKNOWN_PART_META_KEY);
      if (marked.value === true) return { kind: "unknown", raw: content.value };
      return {
        kind: "data",
        data: content.value,
        ...(mediaType ? { mediaType } : {}),
        ...(metadata ? { meta: metadata } : {}),
      };
    }
    case "raw": {
      const { meta, value: uri } = takeMetaKey(metadata, FILE_URI_META_KEY);
      return {
        kind: "file",
        ...(name ? { name } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(typeof uri === "string" ? { uri } : {}),
        bytes: toUint8Array(content.value as Uint8Array),
        ...(meta ? { meta } : {}),
      };
    }
    case "url": {
      const uri = content.value as string;
      return {
        kind: "file",
        ...(name ? { name } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(uri ? { uri } : {}),
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
        content: { $case: "url", value: part.uri ?? "" },
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
    if (state in CORE_TO_V1) return state;
    if (state in V1_NAME_TO_CORE) return V1_NAME_TO_CORE[state]!;
    if (state === "TASK_STATE_UNSPECIFIED" || state === "UNRECOGNIZED") return "unknown";
    return state || "unknown";
  }
  return "unknown";
}

/**
 * Core state to the v1 enum. A state with no v1 equivalent (including
 * `"unknown"`) maps to `TASK_STATE_UNSPECIFIED`; {@link toStatusUpdate} keeps
 * the original string in metadata so it is not lost.
 */
export function toA2ATaskState(state: CoreTaskState): TaskState {
  return CORE_TO_V1[state] ?? coreToV1ByWireName(state) ?? TaskState.TASK_STATE_UNSPECIFIED;
}

function coreToV1ByWireName(state: string): TaskState | undefined {
  const core = V1_NAME_TO_CORE[state];
  return core ? CORE_TO_V1[core] : undefined;
}

/** `true` if the state has a v1 equivalent and needs no metadata to survive. */
export function isRepresentableState(state: CoreTaskState): boolean {
  return state in CORE_TO_V1;
}

// ─── Messages ───────────────────────────────────────────────────────────────

/** Options for {@link fromA2AMessage}. */
export interface FromMessageOptions {
  /** Who sent it. A2A carries no sender identity; defaults to anonymous. */
  from?: CoreCaller;
  /** ISO timestamp. A2A messages carry none; defaults to now. */
  at?: string;
}

/**
 * A2A message to core message. `delivery` is read from message metadata
 * ({@link DELIVERY_META_KEY}); a non-string value is ignored. An unspecified or
 * unknown role is treated as `"user"`.
 */
export function fromA2AMessage(message: Message, options: FromMessageOptions = {}): CoreMessage {
  const { meta, value: delivery } = takeMetaKey(message.metadata, DELIVERY_META_KEY);
  return {
    id: message.messageId,
    role: message.role === Role.ROLE_AGENT ? "agent" : "user",
    parts: (message.parts ?? []).map(fromA2APart),
    from: options.from ?? { ...ANONYMOUS_CALLER },
    ...(typeof delivery === "string" && delivery ? { delivery } : {}),
    at: options.at ?? new Date().toISOString(),
    ...(meta ? { meta } : {}),
  };
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
  /** Core-assigned id of this run. */
  runId: string;
  /** Overrides the caller derived from the SDK call context. */
  caller?: CoreCaller;
  /** Persisted provider session for the context, if any. */
  session?: SessionRef;
  /** Correlation event id. Defaults to a fresh UUID. */
  eventId?: string;
  /** Timestamp for history messages (A2A messages carry none). Defaults to now. */
  at?: string;
}

/** Caller as the SDK call context knows it. Unauthenticated is `anonymous`. */
export function callerFromContext(ctx: RequestContext): CoreCaller {
  const user = ctx.context?.user;
  if (user && user.isAuthenticated && user.userName) return { id: user.userName, kind: "user" };
  return { ...ANONYMOUS_CALLER };
}

/**
 * Build the provider-facing {@link CoreRequest} from an SDK `RequestContext`:
 * input parts from the user message, history from the stored task, caller from
 * the call context, correlation from the request metadata and negotiated
 * extensions.
 */
export function coreRequestFromContext(ctx: RequestContext, options: CoreRequestOptions): CoreRequest {
  const caller = options.caller ?? callerFromContext(ctx);
  const at = options.at ?? new Date().toISOString();
  const message = ctx.userMessage;

  const history = (ctx.task?.history ?? []).map((m) =>
    fromA2AMessage(m, {
      at,
      from: m.role === Role.ROLE_AGENT ? { id: "agent", kind: "agent" } : caller,
    }),
  );

  const extensions = new Map<string, unknown>();
  for (const uri of message?.extensions ?? []) extensions.set(uri, true);
  for (const uri of ctx.context?.requestedExtensions ?? []) extensions.set(uri, true);

  const trace = extractA2ATraceContext(ctx);

  return {
    runId: options.runId,
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
  parts?: CorePart[];
  /** Extension URIs the status message belongs to. */
  messageExtensions?: string[];
  /** Event metadata. */
  metadata?: Meta;
  timestamp?: string;
  messageId?: string;
}

/**
 * Core status to an SDK `TaskStatusUpdateEvent` (the `data` of a
 * `{kind: "statusUpdate"}` bus event). A state with no v1 equivalent is sent as
 * `TASK_STATE_UNSPECIFIED` with the original in {@link CORE_STATE_META_KEY}.
 */
export function toStatusUpdate(input: StatusUpdateInput): TaskStatusUpdateEvent {
  const parts: CorePart[] | undefined =
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
          extensions: input.messageExtensions ?? [],
          referenceTaskIds: [],
        }
      : undefined;
  const metadata =
    !isRepresentableState(input.state) && input.state !== "unknown"
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

/** SDK status update to core terms; restores a state carried in {@link CORE_STATE_META_KEY}. */
export function fromStatusUpdate(event: TaskStatusUpdateEvent, options: FromMessageOptions = {}): CoreStatusUpdate {
  const { meta, value: preserved } = takeMetaKey(event.metadata, CORE_STATE_META_KEY);
  const wire = event.status?.state;
  const state =
    wire === TaskState.TASK_STATE_UNSPECIFIED && typeof preserved === "string" && preserved
      ? preserved
      : fromA2ATaskState(wire);
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
  const tokens: Record<string, number> = {};
  for (const [k, v] of Object.entries(usage.tokens ?? {})) if (typeof v === "number") tokens[k] = v;
  return {
    [USAGE_META_KEY]: {
      scope: usage.scope,
      tokens,
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      ...(usage.contextWindow ? { contextWindow: { ...usage.contextWindow } } : {}),
      ...(usage.model ? { model: usage.model } : {}),
    },
  };
}

/** Read usage back from event metadata, or `undefined` if absent or malformed. */
export function usageFromMetadata(metadata: Meta | undefined | null): CoreUsage | undefined {
  const raw = metadata?.[USAGE_META_KEY];
  if (!isObject(raw)) return undefined;
  if (raw.scope !== "delta" && raw.scope !== "cumulative") return undefined;
  if (!isObject(raw.tokens)) return undefined;
  const usage: CoreUsage = { scope: raw.scope, tokens: { ...(raw.tokens as CoreUsage["tokens"]) } };
  if ("costUsd" in raw && (raw.costUsd === null || typeof raw.costUsd === "number")) usage.costUsd = raw.costUsd;
  if (isObject(raw.contextWindow)) usage.contextWindow = { ...(raw.contextWindow as CoreUsage["contextWindow"]) };
  if (typeof raw.model === "string") usage.model = raw.model;
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

/** Plain text rendering of an interaction, with numbered options. */
export function renderInteractionText(i: CoreInteraction): string {
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
    lines.push("Reply with the option number or its label.");
  }

  if (i.questions?.length) {
    i.questions.forEach((q, qn) => {
      const head = `${i.questions!.length > 1 ? `Question ${qn + 1}` : "Question"}${q.header ? ` (${q.header})` : ""}: ${q.prompt}`;
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
        .map(([name, p]) => `- ${name}${p.type ? ` (${p.type}${required.has(name) ? ", required" : ""})` : required.has(name) ? " (required)" : ""}${p.title ? `: ${p.title}` : ""}`)
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

function replyText(parts: CorePart[]): string {
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

function parseStructured(
  interaction: CoreInteraction,
  data: Record<string, unknown>,
  by: CoreCaller,
): CoreInteractionResult | undefined {
  if (typeof data.optionId === "string") {
    const option = interaction.options?.find((o) => o.id === data.optionId);
    if (!option) return undefined;
    return {
      outcome: "selected",
      optionId: option.id,
      ...(typeof data.feedback === "string" && data.feedback ? { feedback: data.feedback } : {}),
      by,
    };
  }

  if (isObject(data.answers) && interaction.questions?.length) {
    const answers: Record<string, { optionIds?: string[]; text?: string }> = {};
    const given = data.answers as Record<string, unknown>;
    for (const key of Object.keys(given)) {
      if (!interaction.questions.some((q) => q.id === key)) return undefined;
    }
    for (const q of interaction.questions) {
      const a = given[q.id];
      if (!isObject(a)) return undefined;
      const entry: { optionIds?: string[]; text?: string } = {};
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
      if (entry.optionIds === undefined && entry.text === undefined) return undefined;
      answers[q.id] = entry;
    }
    return { outcome: "answered", answers, by };
  }

  if (isObject(data.values) && interaction.schema) {
    const values = data.values as Meta;
    const props = interaction.schema.properties ?? {};
    for (const [k, v] of Object.entries(values)) {
      const p = props[k];
      if (!p) return undefined;
      if (p.type === "string" && typeof v !== "string") return undefined;
      if ((p.type === "number" || p.type === "integer") && typeof v !== "number") return undefined;
      if (p.type === "integer" && !Number.isInteger(v)) return undefined;
      if (p.type === "boolean" && typeof v !== "boolean") return undefined;
      if (Array.isArray(p.enum) && !p.enum.includes(v)) return undefined;
    }
    for (const r of interaction.schema.required ?? []) if (!(r in values)) return undefined;
    return { outcome: "submitted", values, by };
  }

  if (data.declined === true) {
    return {
      outcome: "declined",
      ...(typeof data.feedback === "string" && data.feedback ? { feedback: data.feedback } : {}),
      by,
    };
  }
  if (data.completed === true && interaction.kind === "auth") return { outcome: "completed", by };
  return undefined;
}

function parseText(interaction: CoreInteraction, text: string, by: CoreCaller): CoreInteractionResult | undefined {
  const t = norm(text);
  if (!t) return undefined;

  const options = interaction.options;
  if (options?.length) {
    const hit = matchByToken(text, options);
    if (hit) return { outcome: "selected", optionId: hit.id, by };
    if (APPROVE_WORDS.has(t)) {
      const allow = options.find((o) => o.kind === "allow_once");
      return allow ? { outcome: "selected", optionId: allow.id, by } : undefined;
    }
    if (DENY_WORDS.has(t)) {
      const reject = options.find((o) => o.kind === "reject_once");
      return reject ? { outcome: "selected", optionId: reject.id, by } : { outcome: "declined", by };
    }
    return undefined;
  }

  if (DENY_WORDS.has(t)) return { outcome: "declined", by };
  if (interaction.kind === "auth" && DONE_WORDS.has(t)) return { outcome: "completed", by };

  const qs = interaction.questions;
  if (qs?.length === 1) {
    const q = qs[0]!;
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
 * Parse a caller's reply to a pending interaction into a result, or `undefined`
 * when the message is not a valid reply (so core ignores it with no side
 * effect).
 *
 * Structured first: a data part `{interactionId, optionId | answers | values |
 * declined | completed}`. A data part naming another interaction id makes the
 * whole message not-a-reply. Text fallback second: option number, id or label;
 * `approve`/`allow`/`yes` select the first `allow_once` option only (never an
 * `allow_always`); `deny`/`reject`/`no` select the first `reject_once` option or
 * decline. Anything ambiguous, unknown or invalid is `undefined`: a reply never
 * approves by guesswork (D5).
 */
export function parseInteractionReply(
  interaction: CoreInteraction,
  parts: CorePart[],
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
