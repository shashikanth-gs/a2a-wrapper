/**
 * Hook D — apply OTel policy when AgentEvents are emitted.
 * Sideband transport is unchanged; this only annotates / opens spans.
 *
 * @module telemetry/emitter-bridge
 */

import type { EventType } from "../events/transport.js";
import { getOtelTracer } from "./api.js";
import { getTaskOtelStore } from "./context.js";

function toolKey(data: Record<string, unknown>): string {
  return String(data.callId ?? data.toolCallId ?? data.tool_use_id ?? data.tool ?? data.name ?? "tool");
}

/**
 * Called from {@link AgentEventEmitter.emit} after the transport send.
 * Never throws to the caller.
 */
export function observeAgentEvent(eventType: EventType, data: Record<string, unknown>): void {
  try {
    const store = getTaskOtelStore();
    if (!store?.policy.enabled) return;

    const span = store.span;
    if (store.policy.annotateLifecycleOnTaskSpan && span) {
      if (
        eventType === "agent_started" ||
        eventType === "agent_finished" ||
        eventType === "agent_error" ||
        eventType === "decision" ||
        eventType === "thinking"
      ) {
        span.addEvent?.(eventType, {
          "a2a.event.type": eventType,
        });
      }
      if (eventType === "agent_error") {
        span.setStatus?.({ code: 2, message: String(data.message ?? data.error ?? "agent_error") });
      }
    }

    if (!store.policy.emitToolSpans) return;

    const tracer = getOtelTracer();
    if (!tracer) return;

    if (eventType === "tool_call_start") {
      const key = toolKey(data);
      const toolName = String(data.tool ?? data.name ?? key);
      const child = tracer.startSpan(`a2a.mcp.tool ${toolName}`, {
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          "a2a.tool.name": toolName,
          ...(data.toolKind ? { "a2a.tool.kind": String(data.toolKind) } : {}),
          ...(data.server ? { "a2a.mcp.server": String(data.server) } : {}),
          ...(data.delegation === true ? { "a2a.delegation": true } : {}),
        },
      });
      store.toolSpans.set(key, child);
    } else if (eventType === "tool_call_end") {
      const key = toolKey(data);
      const child = store.toolSpans.get(key);
      if (child) {
        if (data.error || data.success === false) {
          child.setStatus?.({ code: 2, message: String(data.error ?? "tool_error") });
        }
        child.end();
        store.toolSpans.delete(key);
      }
    }
  } catch {
    /* never break sideband emission */
  }
}
