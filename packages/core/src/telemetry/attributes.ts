/**
 * Attribute builders for wrapper-owned spans.
 *
 * Default model (see docs/observability.md): **one wrapper span per inbound
 * request**. Correlation across turns / retries is via stable IDs
 * (`gen_ai.conversation.id`, `a2a.task.id`, `a2a.message.id`), not by
 * inventing extra span trees.
 *
 * @module telemetry/attributes
 */

import type { A2ATraceContext } from "./context.js";
import { getCorePackageVersion } from "./package-meta.js";

/** How this `execute` relates to the A2A task lifecycle. */
export type TaskInvocationKind =
  /** First wrapper span for this taskId in this process. */
  | "new"
  /** Orchestrator called again with an existing task (follow-up / input-required resume). */
  | "continue"
  /** Same task seen again without prior task object — typically client retry after failure. */
  | "retry";

export function slugAgentId(agentName: string): string {
  return agentName.toLowerCase().replace(/\s+/g, "-");
}

export function buildTaskSpanAttributes(opts: {
  taskId: string;
  contextId: string;
  agentName: string;
  agentId?: string;
  /**
   * Wrapper SDK package name (e.g. `"a2a-copilot"`). Emitted as
   * `a2a.wrapper.sdk` (and legacy `a2a.wrapper.name`).
   */
  wrapperName?: string;
  /**
   * Wrapper SDK package version. Emitted as `a2a.wrapper.sdk.version`
   * (and legacy `a2a.wrapper.version`).
   */
  wrapperVersion?: string;
  /**
   * `@a2a-wrapper/core` version. Defaults to the installed core package.json
   * version when omitted.
   */
  coreVersion?: string;
  protocolVersion?: string;
  parentAgentId?: string | null;
  orchestratorTraceId?: string;
  /** Override for gen_ai.conversation.id (gateway conversation); defaults to contextId. */
  conversationId?: string | null;
  /** Phoenix / generic session.id when distinct from conversation. */
  sessionId?: string | null;
  /** A2A inbound message id when present. */
  messageId?: string | null;
  /** Draft #254 method name; default message/send for executor path. */
  methodName?: string | null;
  /** 1-based count of wrapper execute() calls for this taskId in-process. */
  invocation?: number;
  invocationKind?: TaskInvocationKind;
  gateway?: {
    passkey?: string;
    spectrumId?: string;
    ticketId?: string;
  };
}): Record<string, string | number | boolean> {
  const agentId = opts.agentId ?? slugAgentId(opts.agentName);
  const conversationId = opts.conversationId || opts.contextId;
  const coreVersion = opts.coreVersion ?? getCorePackageVersion();
  const attrs: Record<string, string | number | boolean> = {
    "a2a.task.id": opts.taskId,
    "a2a.context.id": opts.contextId,
    "a2a.agent.id": agentId,
    "a2a.agent.name": opts.agentName,
    "gen_ai.agent.name": opts.agentName,
    "gen_ai.agent.id": agentId,
    // Platforms (Langfuse/Datadog/Phoenix) group multi-turn work by this id —
    // not by assuming one eternal parent span.
    "gen_ai.conversation.id": conversationId,
    // Draft semantic-conventions-genai#254 shared GenAI op for A2A invoke.
    "gen_ai.operation.name": "invoke_agent",
    "a2a.method.name": opts.methodName || "message/send",
    "a2a.wrapper.core.version": coreVersion,
  };
  const sessionId = opts.sessionId || conversationId;
  attrs["session.id"] = sessionId;
  if (opts.wrapperName) {
    // Preferred names — which a2a-* SDK package is serving this request.
    attrs["a2a.wrapper.sdk"] = opts.wrapperName;
    // Legacy aliases (same values) for early Phase 1–5 consumers.
    attrs["a2a.wrapper.name"] = opts.wrapperName;
  }
  if (opts.wrapperVersion) {
    attrs["a2a.wrapper.sdk.version"] = opts.wrapperVersion;
    attrs["a2a.wrapper.version"] = opts.wrapperVersion;
  }
  if (opts.protocolVersion) attrs["a2a.protocol.version"] = opts.protocolVersion;
  if (opts.parentAgentId) attrs["a2a.parent_agent.id"] = opts.parentAgentId;
  if (opts.orchestratorTraceId) attrs["a2a.orchestrator.trace_id"] = opts.orchestratorTraceId;
  if (opts.messageId) attrs["a2a.message.id"] = opts.messageId;
  if (opts.invocation !== undefined) attrs["a2a.task.invocation"] = opts.invocation;
  if (opts.invocationKind) attrs["a2a.task.invocation_kind"] = opts.invocationKind;
  if (opts.gateway?.passkey) attrs["a2a.gateway.passkey"] = opts.gateway.passkey;
  if (opts.gateway?.spectrumId) attrs["a2a.gateway.spectrum_id"] = opts.gateway.spectrumId;
  if (opts.gateway?.ticketId) attrs["a2a.gateway.ticket_id"] = opts.gateway.ticketId;
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
