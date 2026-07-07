/**
 * Event Mapper — Claude SDKMessage → A2A Sideband
 *
 * Translates @anthropic-ai/claude-agent-sdk messages into A2A sideband events
 * published via AgentEventEmitter.
 *
 * Sanitization rules (applied to all emitted data):
 * - Redact fields matching SENSITIVE_KEYS
 * - Truncate tool output to MAX_OUTPUT_LENGTH characters
 * - Never emit file contents (only path + operation kind)
 * - Never emit raw environment variable values
 */

import type { AgentEventEmitter } from "@a2a-wrapper/core";
import type { AgentConfig } from "../config/types.js";
import type { SDKMessageLike } from "./client-factory.js";
import { logger } from "../utils/logger.js";

const log = logger.child("event-mapper");

const MAX_OUTPUT_LENGTH = 10_000;
const MAX_COMMAND_LENGTH = 500;

const SENSITIVE_KEYS = new Set([
  "token", "access_token", "authorization", "api_key", "apikey",
  "password", "secret", "credential", "private_key", "client_secret",
]);

const FILE_TOOLS: Record<string, string> = {
  Edit: "edit",
  Write: "write",
  NotebookEdit: "edit",
};

// ─── Sanitization Helpers ─────────────────────────────────────────────────────

export function sanitizeMessage(msg: unknown): string {
  if (typeof msg !== "string") return "An error occurred.";
  return msg
    .replace(/\b(api_?key|access_?token|private_?key|client_?secret|token|key|password|secret|credential|authorization)s?\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .substring(0, 2000);
}

function sanitizeData(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(sanitizeData);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "<redacted>" : sanitizeData(val);
  }
  return out;
}

function truncateOutput(output: unknown): string {
  const text =
    typeof output === "string"
      ? output
      : output === undefined || output === null
        ? ""
        : JSON.stringify(sanitizeData(output));
  if (text.length > MAX_OUTPUT_LENGTH) {
    return text.substring(0, MAX_OUTPUT_LENGTH) + `\n... [truncated, ${text.length} total chars]`;
  }
  return text;
}

// ─── EventMapper ─────────────────────────────────────────────────────────────

export class EventMapper {
  private readonly emitter: AgentEventEmitter;
  private readonly config: Required<AgentConfig>;

  constructor(emitter: AgentEventEmitter, config: Required<AgentConfig>) {
    this.emitter = emitter;
    this.config = config;
  }

  handleMessage(msg: SDKMessageLike): void {
    try {
      switch (msg.type) {
        case "system":
          this.handleSystem(msg);
          break;
        case "assistant":
          if (msg.parent_tool_use_id == null) this.handleAssistant(msg);
          break;
        case "user":
          if (msg.parent_tool_use_id == null) this.handleUser(msg);
          break;
        case "result":
          this.handleResult(msg);
          break;
        case "stream_event":
          break; // consumed by the executor for artifact deltas
        default:
          log.debug("Unhandled SDK message type", { type: msg.type });
      }
    } catch (err) {
      log.warn("EventMapper.handleMessage error", { error: (err as Error).message, type: msg.type });
    }
  }

  private handleSystem(msg: SDKMessageLike): void {
    if (msg.subtype === "init") {
      this.emitter.emit("agent_started", {
        backend: "claude",
        model: typeof msg.model === "string" ? msg.model : "",
      });
    } else if (msg.subtype === "permission_denied") {
      this.emitter.emit("decision", {
        backend: "claude",
        kind: "permission_denied",
        tool: typeof msg.tool_name === "string" ? msg.tool_name : "<tool>",
        message: sanitizeMessage(msg.message),
      });
    }
  }

  private handleAssistant(msg: SDKMessageLike): void {
    const features = this.config.features;
    const inner = msg.message as Record<string, unknown> | undefined;
    const content = inner?.content;
    if (!Array.isArray(content)) return;

    for (const rawBlock of content) {
      const block = rawBlock as Record<string, unknown>;

      if (block.type === "thinking") {
        if (features.emitThinkingEvents && typeof block.thinking === "string" && block.thinking) {
          this.emitter.emit("thinking", { content: block.thinking });
        }
        continue;
      }

      if (block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      const input = (block.input ?? {}) as Record<string, unknown>;
      const itemId = typeof block.id === "string" ? block.id : "";

      // File changes and todos are decisions, not tool_call events.
      if (name in FILE_TOOLS) {
        if (features.emitFileChangeEvents) {
          const path = typeof input.file_path === "string"
            ? input.file_path
            : typeof input.notebook_path === "string" ? input.notebook_path : "<unknown>";
          this.emitter.emit("decision", {
            backend: "claude",
            kind: "file_change",
            changes: [{ path, kind: FILE_TOOLS[name] }],
          });
        }
        continue;
      }

      if (name === "TodoWrite") {
        if (features.emitTodoEvents) {
          const todos = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
          this.emitter.emit("decision", {
            backend: "claude",
            kind: "todo_list",
            items: todos.map((t) => ({
              text: typeof t.content === "string" ? t.content : String(t.content ?? ""),
              completed: t.status === "completed",
            })),
          });
        }
        continue;
      }

      if (!features.emitToolEvents) continue;

      if (name === "Bash") {
        this.emitter.emit("tool_call_start", {
          backend: "claude",
          toolKind: "shell",
          command: typeof input.command === "string" ? input.command.substring(0, MAX_COMMAND_LENGTH) : "<command>",
          itemId,
        });
      } else if (name.startsWith("mcp__")) {
        const rest = name.slice("mcp__".length);
        const sep = rest.indexOf("__");
        const server = sep >= 0 ? rest.slice(0, sep) : rest;
        const tool = sep >= 0 ? rest.slice(sep + 2) : "";
        const isDelegation = server === "a2a-subagents";
        this.emitter.emit("tool_call_start", {
          backend: "claude",
          toolKind: isDelegation ? "a2a_subagent" : "mcp",
          server,
          tool,
          itemId,
          ...(isDelegation ? { delegation: true } : {}),
        });
      } else {
        this.emitter.emit("tool_call_start", {
          backend: "claude",
          toolKind: "builtin",
          tool: name,
          itemId,
        });
      }
    }
  }

  private handleUser(msg: SDKMessageLike): void {
    if (!this.config.features.emitToolEvents) return;
    const inner = msg.message as Record<string, unknown> | undefined;
    const content = inner?.content;
    if (!Array.isArray(content)) return;

    for (const rawBlock of content) {
      const block = rawBlock as Record<string, unknown>;
      if (block.type !== "tool_result") continue;
      this.emitter.emit("tool_call_end", {
        backend: "claude",
        itemId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
        output: truncateOutput(block.content),
        status: block.is_error === true ? "error" : "completed",
      });
    }
  }

  private handleResult(msg: SDKMessageLike): void {
    if (msg.subtype === "success") {
      this.emitter.emit("agent_finished", {
        backend: "claude",
        usage: sanitizeData(msg.usage) ?? null,
        totalCostUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
        numTurns: typeof msg.num_turns === "number" ? msg.num_turns : null,
      });
      return;
    }

    const reasons: Record<string, string> = {
      error_max_turns: "Turn limit reached (max_turns).",
      error_max_budget_usd: "Budget limit reached (max_budget_usd).",
      error_during_execution: "Error during execution.",
      error_max_structured_output_retries: "Structured output retries exhausted.",
    };
    const errs = Array.isArray(msg.errors) ? (msg.errors as unknown[]).map((e) => sanitizeMessage(String(e))) : [];
    this.emitter.emit("agent_error", {
      backend: "claude",
      message: reasons[String(msg.subtype)] ?? `Execution failed (${String(msg.subtype)}).`,
      ...(errs.length > 0 ? { errors: errs } : {}),
    });
  }
}
