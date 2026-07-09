/**
 * Event Mapper — neutral bridge events to core sideband/usage telemetry.
 */

import type { AgentEventEmitter, UsageCallRecord } from "@a2a-wrapper/core";
import type { AgentConfig } from "../config/types.js";
import type { BridgeRunEvent, BridgeUsage } from "./bridge-protocol.js";

const SENSITIVE_KEYS = new Set([
  "token",
  "access_token",
  "authorization",
  "api_key",
  "apikey",
  "password",
  "secret",
  "credential",
  "private_key",
  "client_secret",
]);

export function sanitizeMessage(msg: unknown): string {
  if (typeof msg !== "string") return "An error occurred.";
  return msg
    .replace(/\b(token|key|password|secret|credential)s?\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .substring(0, 2000);
}

function sanitizeData(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(sanitizeData);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "<redacted>" : sanitizeData(value);
  }
  return out;
}

export function usageToCallRecord(
  usage: BridgeUsage,
  modelFallback: string | undefined,
  durationFallbackMs = 0,
): UsageCallRecord {
  return {
    model: usage.model ?? modelFallback ?? "",
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    durationMs: usage.durationMs ?? durationFallbackMs,
    timeToFirstTokenMs: null,
    cost: null,
    apiEndpoint: null,
    initiator: "antigravity",
  };
}

export class EventMapper {
  private readonly emitter: AgentEventEmitter;
  private readonly config: Required<AgentConfig>;
  private readonly seenTools = new Set<string>();

  constructor(emitter: AgentEventEmitter, config: Required<AgentConfig>) {
    this.emitter = emitter;
    this.config = config;
  }

  async handleEvent(event: BridgeRunEvent): Promise<void> {
    if (event.kind === "thought_delta" && this.config.features.emitReasoning) {
      await this.emitter.emit("thinking", { content: event.text });
      return;
    }

    if (event.kind === "tool_call_start" && this.config.features.emitToolEvents) {
      const key = event.toolId ?? `${event.toolName}:${JSON.stringify(event.args ?? {})}`;
      if (this.seenTools.has(key)) return;
      this.seenTools.add(key);
      await this.emitter.emit("tool_call_start", {
        backend: "antigravity",
        toolKind: "antigravity",
        tool: event.toolName,
        itemId: event.toolId ?? null,
        args: sanitizeData(event.args ?? {}),
      });
      return;
    }

    if (event.kind === "completed") {
      await this.emitter.emit("agent_finished", {
        backend: "antigravity",
        usage: sanitizeData(event.usage ?? null),
      });
      return;
    }

    if (event.kind === "failed") {
      await this.emitter.emit("agent_error", {
        backend: "antigravity",
        code: event.code,
        message: sanitizeMessage(event.message),
      });
    }
  }
}
