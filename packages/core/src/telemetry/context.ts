/**
 * Per-task OpenTelemetry / A2A trace context (AsyncLocalStorage).
 *
 * @module telemetry/context
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { v4 as uuidv4 } from "uuid";
import type { RequestContext } from "@a2a-js/sdk/server";
import type { OtelEmissionPolicy, OtelSpanLike, W3cTraceContext } from "./types.js";

const require = createRequire(import.meta.url);

export interface A2ATraceContext {
  traceId: string;
  parentAgentId: string | null;
  metadata: Record<string, unknown>;
  /**
   * Stable conversation / thread id for platform session grouping.
   * From metadata when provided; else A2A `contextId`.
   */
  conversationId: string;
  /** Broader UX session id when the gateway distinguishes it from conversation. */
  sessionId?: string;
  /** Gateway business keys (passkey, spectrum, ticket, …) — correlation only. */
  gateway: {
    passkey?: string;
    spectrumId?: string;
    ticketId?: string;
  };
}

export interface TaskOtelStore {
  span?: OtelSpanLike;
  policy: OtelEmissionPolicy;
  taskId: string;
  contextId: string;
  agentId: string;
  agentName: string;
  /** Active tool spans keyed by call id / tool name (when emitToolSpans). */
  toolSpans: Map<string, OtelSpanLike>;
}

const als = new AsyncLocalStorage<TaskOtelStore>();

export function getTaskOtelStore(): TaskOtelStore | undefined {
  return als.getStore();
}

export function runWithTaskOtelStore<T>(store: TaskOtelStore, fn: () => Promise<T>): Promise<T> {
  return als.run(store, fn);
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

function collectMetadata(ctx: RequestContext): Record<string, unknown> {
  const raw = ctx as unknown as Record<string, unknown>;
  const fromRequest = (raw.request as { params?: { metadata?: Record<string, unknown> } } | undefined)
    ?.params?.metadata;
  const fromMessage = (ctx.userMessage as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  const fromCtx = raw.metadata as Record<string, unknown> | undefined;
  const fromTask = (raw.task as Record<string, unknown> | undefined)?.metadata as
    | Record<string, unknown>
    | undefined;
  const fromTaskConfig = (raw.task as Record<string, unknown> | undefined)?.configuration as
    | Record<string, unknown>
    | undefined;
  return {
    ...(fromTaskConfig ?? {}),
    ...(fromTask ?? {}),
    ...(fromCtx ?? {}),
    ...(fromRequest ?? {}),
    ...(fromMessage ?? {}),
  };
}

/**
 * Extract orchestrator / gateway correlation ids from an A2A RequestContext.
 * Shared replacement for the Copilot/OpenCode private helpers.
 *
 * @see docs/otel-attribute-ownership.md
 */
export function extractA2ATraceContext(ctx: RequestContext): A2ATraceContext {
  const meta = collectMetadata(ctx);
  const conversationId =
    pickString(meta.conversation_id, meta.conversationId, meta["gen_ai.conversation.id"]) ||
    ctx.contextId ||
    uuidv4();
  const sessionId = pickString(meta.session_id, meta.sessionId, meta["session.id"]);

  return {
    traceId:
      pickString(meta.trace_id, meta.traceId) ||
      ctx.contextId ||
      uuidv4(),
    parentAgentId: pickString(meta.parent_agent_id, meta.parentAgentId) ?? null,
    metadata:
      (meta.propagated_metadata as Record<string, unknown>) ||
      (meta.propagatedMetadata as Record<string, unknown>) ||
      {},
    conversationId,
    sessionId,
    gateway: {
      passkey: pickString(meta.passkey, meta.pass_key, meta.passKey),
      spectrumId: pickString(meta.spectrum_id, meta.spectrumId),
      ticketId: pickString(meta.ticket_id, meta.ticketId),
    },
  };
}

/**
 * W3C carrier for backend passthrough.
 *
 * When `@opentelemetry/api` is installed and a real context is active, injects
 * `traceparent` / `tracestate`. Otherwise returns `{}`.
 */
export function getW3cTraceContext(): W3cTraceContext {
  try {
    const api = require("@opentelemetry/api") as {
      context: { active: () => unknown };
      propagation: {
        inject: (ctx: unknown, carrier: Record<string, string>) => void;
      };
    };
    const carrier: Record<string, string> = {};
    api.propagation.inject(api.context.active(), carrier);
    const out: W3cTraceContext = {};
    if (carrier.traceparent) out.traceparent = carrier.traceparent;
    if (carrier.tracestate) out.tracestate = carrier.tracestate;
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge W3C `traceparent` / `tracestate` into outbound HTTP headers
 * (sub-agent calls, skillmap bridge, etc.) without clobbering auth headers.
 *
 * Returns a **new** object. Empty when no active OTel context is injectable.
 */
export function injectW3cTraceHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const w3c = getW3cTraceContext();
  const out = { ...headers };
  if (w3c.traceparent) out.traceparent = w3c.traceparent;
  if (w3c.tracestate) out.tracestate = w3c.tracestate;
  return out;
}
