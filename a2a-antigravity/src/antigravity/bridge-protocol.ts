/**
 * Private Node ↔ Python bridge protocol.
 *
 * This is not a public API. It intentionally carries neutral Antigravity
 * events instead of A2A/Core types so TypeScript remains the owner of wrapper
 * semantics and Python stays a thin SDK adapter.
 */

import type { AntigravityConfig, McpServerConfig } from "../config/types.js";

export const BRIDGE_PROTOCOL_VERSION = 1;

export interface BridgeConfig {
  antigravity: AntigravityConfig;
  mcp?: Record<string, McpServerConfig>;
  logLevel?: string;
}

export type BridgeRequest =
  | {
      protocolVersion: 1;
      id: string;
      command: "initialize";
      config: BridgeConfig;
    }
  | {
      protocolVersion: 1;
      id: string;
      command: "open_session";
      sessionId: string;
      contextId: string;
      config: BridgeConfig;
    }
  | {
      protocolVersion: 1;
      id: string;
      command: "run";
      taskId: string;
      sessionId: string;
      prompt: string;
    }
  | {
      protocolVersion: 1;
      id: string;
      command: "cancel";
      taskId: string;
    }
  | {
      protocolVersion: 1;
      id: string;
      command: "close_session";
      sessionId: string;
    }
  | {
      protocolVersion: 1;
      id: string;
      command: "shutdown";
    };

export interface BridgeAck {
  kind: "ack";
  requestId: string;
  ok: true;
}

export interface BridgeRequestError {
  kind: "ack";
  requestId: string;
  ok: false;
  code: string;
  message: string;
  details?: unknown;
}

export interface BridgeUsage {
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  durationMs?: number | null;
}

export type BridgeRunEvent =
  | {
      kind: "session_opened";
      sessionId: string;
      conversationId?: string | null;
    }
  | {
      kind: "text_delta";
      taskId: string;
      text: string;
    }
  | {
      kind: "thought_delta";
      taskId: string;
      text: string;
    }
  | {
      kind: "tool_call_start";
      taskId: string;
      toolName: string;
      toolId?: string | null;
      args?: Record<string, unknown>;
    }
  | {
      kind: "usage";
      taskId: string;
      usage: BridgeUsage;
    }
  | {
      kind: "structured_output";
      taskId: string;
      output: unknown;
    }
  | {
      kind: "completed";
      taskId: string;
      text?: string;
      usage?: BridgeUsage;
      structuredOutput?: unknown;
    }
  | {
      kind: "canceled";
      taskId: string;
      message?: string;
    }
  | {
      kind: "failed";
      taskId?: string;
      code: string;
      message: string;
      details?: unknown;
    }
  | {
      kind: "log";
      level: "debug" | "info" | "warn" | "error";
      message: string;
      data?: Record<string, unknown>;
    };

export type BridgeMessage = BridgeAck | BridgeRequestError | BridgeRunEvent;

export function parseBridgeMessage(line: string): BridgeMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`BRIDGE_PROTOCOL_ERROR: invalid JSONL message: ${msg}`);
  }

  if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
    throw new Error("BRIDGE_PROTOCOL_ERROR: message missing kind");
  }
  return parsed as BridgeMessage;
}
