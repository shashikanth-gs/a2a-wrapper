/**
 * MCP Evidence Hooks — Pure A2A Sideband Artifacts
 *
 * Captures tool arguments and results from the Copilot SDK's
 * onPreToolUse / onPostToolUse session hooks, then emits structured
 * A2A TaskArtifactUpdateEvent with `trace.*` artifact keys.
 *
 * These "sideband artifacts" flow through the A2A protocol itself —
 * no Kafka, no custom transport. The orchestrator receives them alongside
 * the normal response artifacts and forwards trace.* artifacts to its
 * event emitter (Kafka) for storage and UI display.
 *
 * Artifact key conventions:
 *   trace.mcp        — MCP tool call (request + response)
 *   trace.thought     — Agent reasoning / chain of thought
 *   trace.delegation  — Sub-agent delegation (child task link)
 *
 * The parent agent's LLM only reads `response` artifacts.
 * Everything prefixed with `trace.` is observability-only data.
 */

import { randomUUID } from "node:crypto";
import type { AgentEventEmitter } from "@a2a-wrapper/core";
import { logger } from "../utils/logger.js";

const log = logger.child("mcp-hooks");

/** Maximum serialized size (chars) for args/results stored in artifacts. */
const MAX_DATA_SIZE = 100_000;

const SENSITIVE_KEYS = new Set([
  "token",
  "access_token",
  "authorization",
  "api_key",
  "apikey",
  "password",
  "secret",
  "credential",
]);

// ─── Hooks class ────────────────────────────────────────────────────────────

export class McpEvidenceHooks {
  private emitter: AgentEventEmitter | null = null;
  /** Correlate start/end by session+toolName → { toolCallId, args, startTime }. */
  private activeToolCalls = new Map<
    string,
    { toolCallId: string; args: unknown; startTime: number }
  >();

  /**
   * Bind the emitter for the current execution.
   * Must be called before each prompt so trace events route correctly.
   */
  setEmitter(emitter: AgentEventEmitter): void {
    this.emitter = emitter;
  }

  /** Clear emitter after execution completes. */
  clearEmitter(): void {
    this.emitter = null;
    this.activeToolCalls.clear();
  }

  /**
   * Returns Copilot SDK session hooks object.
   *
   * Attach to session creation:
   *   client.createSession({ ..., hooks: mcpHooks.getHooks() })
   */
  getHooks(): Record<string, unknown> {
    return {
      onPreToolUse: async (
        input: unknown,
        invocation: unknown,
      ): Promise<Record<string, unknown>> => {
        const inp = input as Record<string, unknown>;
        const toolName = (inp.toolName as string) || "unknown";
        const toolArgs = (inp.toolArgs as Record<string, unknown>) || {};
        const toolCallId = randomUUID();
        const startTime = Date.now();

        // Track for correlation with onPostToolUse
        const sessionId =
          ((invocation as Record<string, unknown>)?.sessionId as string) || "";
        this.activeToolCalls.set(sessionId + ":" + toolName, {
          toolCallId,
          args: sanitize(toolArgs),
          startTime,
        });

        log.info("MCP tool call start", { toolName, toolCallId });

        // Emit tool_call_start event via transport
        if (this.emitter) {
          this.emitter.emit("tool_call_start", {
            toolCallId,
            toolName,
            arguments: truncate(sanitize(toolArgs)),
          });
        }

        // IMPORTANT: return permissionDecision to allow execution
        return { permissionDecision: "allow" };
      },

      onPostToolUse: async (
        input: unknown,
        invocation: unknown,
      ): Promise<null> => {
        const inp = input as Record<string, unknown>;
        const toolName = (inp.toolName as string) || "unknown";
        const toolResult = inp.toolResult;

        // Recover tracked data from activeToolCalls
        const sessionId =
          ((invocation as Record<string, unknown>)?.sessionId as string) || "";
        const key = sessionId + ":" + toolName;
        const tracked = this.activeToolCalls.get(key);
        const toolCallId = tracked?.toolCallId || randomUUID();
        const startTime = tracked?.startTime || Date.now();
        const durationMs = Date.now() - startTime;
        this.activeToolCalls.delete(key);

        const isError =
          toolResult instanceof Error ||
          (typeof toolResult === "object" &&
            toolResult !== null &&
            "error" in (toolResult as Record<string, unknown>));

        log.info("MCP tool call end", { toolName, toolCallId, isError, durationMs });

        // Emit tool_call_end event via transport
        if (this.emitter) {
          this.emitter.emit("tool_call_end", {
            toolCallId,
            toolName,
            result: truncate(sanitize(toolResult)),
            isError,
            durationMs,
          });
        }

        // Return null to pass through unchanged
        return null;
      },
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Redact sensitive keys from an object (deep). */
function sanitize(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(sanitize);

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = "<redacted>";
    } else {
      out[key] = sanitize(val);
    }
  }
  return out;
}

/** Truncate large data to prevent oversized A2A messages. */
function truncate(data: unknown): unknown {
  if (typeof data === "string" && data.length > MAX_DATA_SIZE) {
    return (
      data.substring(0, MAX_DATA_SIZE) +
      `... [truncated, total ${data.length} chars]`
    );
  }

  const json = safeJson(data);
  if (json.length > MAX_DATA_SIZE) {
    return {
      _truncated: true,
      _original_size: json.length,
      preview: json.substring(0, MAX_DATA_SIZE),
    };
  }
  return data;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"<unserializable>"';
  }
}
