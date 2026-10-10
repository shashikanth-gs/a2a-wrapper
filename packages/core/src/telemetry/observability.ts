/**
 * Hook B — shared execution observability bootstrap for wrappers.
 *
 * Replaces copy-pasted `resolveTransport` + `AgentEventEmitter` + local
 * `extractTraceContext` blocks in each executor.
 *
 * @module telemetry/observability
 */

import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { EventsConfig } from "../config/types.js";
import {
  AgentEventEmitter,
  resolveTransport,
  type EventTransport,
  type EventTransportFn,
} from "../events/transport.js";
import { slugAgentId } from "./attributes.js";
import { extractA2ATraceContext, getTaskOtelStore, type A2ATraceContext } from "./context.js";

export interface CreateExecutionObservabilityOptions {
  /** `agentCard.name` */
  agentName: string;
  ctx: RequestContext;
  bus: ExecutionEventBus;
  events?: EventsConfig;
  customTransport?: EventTransport | EventTransportFn;
}

export interface ExecutionObservability {
  emitter: AgentEventEmitter;
  traceContext: A2ATraceContext;
  agentId: string;
  agentName: string;
}

/**
 * Build per-execute sideband emitter + A2A trace context (orchestrator metadata).
 */
export function createExecutionObservability(
  opts: CreateExecutionObservabilityOptions,
): ExecutionObservability {
  const agentName = opts.agentName;
  const agentId = slugAgentId(agentName);
  const traceContext = extractA2ATraceContext(opts.ctx);
  const { taskId, contextId } = opts.ctx;
  const transport = resolveTransport(
    opts.events,
    opts.bus,
    taskId,
    contextId,
    opts.customTransport,
  );
  const emitter = new AgentEventEmitter({
    agentId,
    agentName,
    traceId: traceContext.traceId,
    parentAgentId: traceContext.parentAgentId,
    transport,
  });
  return { emitter, traceContext, agentId, agentName };
}

/**
 * Hook C — annotate the active task span after session get-or-create.
 */
export function annotateSessionOnTaskSpan(opts: {
  reused: boolean;
  sessionId?: string;
}): void {
  const store = getTaskOtelStore();
  if (!store?.policy.enabled || !store.span) return;
  store.span.setAttribute("a2a.session.reused", opts.reused);
  if (opts.sessionId) store.span.setAttribute("a2a.session.id", opts.sessionId);
}
