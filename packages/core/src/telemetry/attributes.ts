/**
 * Attribute builders for wrapper-owned spans.
 *
 * @module telemetry/attributes
 */

import type { A2ATraceContext } from "./context.js";

export function slugAgentId(agentName: string): string {
  return agentName.toLowerCase().replace(/\s+/g, "-");
}

export function buildTaskSpanAttributes(opts: {
  taskId: string;
  contextId: string;
  agentName: string;
  agentId?: string;
  wrapperName?: string;
  wrapperVersion?: string;
  protocolVersion?: string;
  parentAgentId?: string | null;
  orchestratorTraceId?: string;
}): Record<string, string | number | boolean> {
  const agentId = opts.agentId ?? slugAgentId(opts.agentName);
  const attrs: Record<string, string | number | boolean> = {
    "a2a.task.id": opts.taskId,
    "a2a.context.id": opts.contextId,
    "a2a.agent.id": agentId,
    "a2a.agent.name": opts.agentName,
    "gen_ai.agent.name": opts.agentName,
    "gen_ai.agent.id": agentId,
    "gen_ai.conversation.id": opts.contextId,
  };
  if (opts.wrapperName) attrs["a2a.wrapper.name"] = opts.wrapperName;
  if (opts.wrapperVersion) attrs["a2a.wrapper.version"] = opts.wrapperVersion;
  if (opts.protocolVersion) attrs["a2a.protocol.version"] = opts.protocolVersion;
  if (opts.parentAgentId) attrs["a2a.parent_agent.id"] = opts.parentAgentId;
  if (opts.orchestratorTraceId) attrs["a2a.orchestrator.trace_id"] = opts.orchestratorTraceId;
  return attrs;
}

export function agentIdentityFromCard(agentCard: { name: string }, trace?: A2ATraceContext) {
  const agentName = agentCard.name;
  const agentId = slugAgentId(agentName);
  return {
    agentId,
    agentName,
    parentAgentId: trace?.parentAgentId ?? null,
    orchestratorTraceId: trace?.traceId,
  };
}
