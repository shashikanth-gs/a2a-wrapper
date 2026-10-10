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

/**
 * Extract orchestrator-propagated trace metadata from an A2A RequestContext.
 * Shared replacement for the Copilot/OpenCode private helpers.
 */
export function extractA2ATraceContext(ctx: RequestContext): A2ATraceContext {
  const raw = ctx as unknown as Record<string, unknown>;
  const meta =
    (raw.metadata as Record<string, unknown>) ||
    ((raw.task as Record<string, unknown>)?.metadata as Record<string, unknown>) ||
    ((raw.task as Record<string, unknown>)?.configuration as Record<string, unknown>) ||
    {};

  return {
    traceId:
      (meta.trace_id as string) ||
      (meta.traceId as string) ||
      ctx.contextId ||
      uuidv4(),
    parentAgentId:
      (meta.parent_agent_id as string) ||
      (meta.parentAgentId as string) ||
      null,
    metadata:
      (meta.propagated_metadata as Record<string, unknown>) ||
      (meta.propagatedMetadata as Record<string, unknown>) ||
      {},
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
