/**
 * MCP Adapter
 *
 * Validates user-supplied MCP server configs and translates them to the
 * @anthropic-ai/claude-agent-sdk mcpServers option shape.
 *
 * Security: The "a2a-subagents" key is reserved. User config cannot occupy it.
 * Unsupported transports fail loudly at startup.
 */

import type { McpServerConfig, McpStdioServerConfig, McpHttpServerConfig } from "../config/types.js";
import type { SynthesizedMcpDescriptor } from "@a2a-wrapper/core";

const SUPPORTED_TYPES = new Set(["stdio", "http"]);
const RESERVED_KEYS = new Set(["a2a-subagents"]);

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateMcpServers(mcp: Record<string, McpServerConfig>): void {
  for (const [key, server] of Object.entries(mcp)) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `MCP server key "${key}" is reserved for the A2A sub-agent bridge (a2a-mcp-skillmap). ` +
        `Rename your MCP server entry to a different key.`,
      );
    }
    if (!SUPPORTED_TYPES.has(server.type)) {
      const hint =
        server.type === "sse"
          ? 'Use a Streamable HTTP (type: "http") server instead of legacy SSE.'
          : `Unknown transport type "${server.type}". Supported: stdio, http.`;
      throw new Error(
        `MCP server "${key}" uses unsupported transport type "${server.type}". ${hint}`,
      );
    }
  }
}

// ─── Sub-Agent Bridge Adapter ────────────────────────────────────────────────

export function toClaudeMcpEntry(descriptor: SynthesizedMcpDescriptor): McpStdioServerConfig {
  return {
    type: "stdio",
    command: descriptor.command,
    args: descriptor.args,
    env: descriptor.env,
    enabled: true,
  };
}

// ─── SDK Option Translation ──────────────────────────────────────────────────

/**
 * Translate the resolved mcp map into the object passed as Options.mcpServers.
 * Only enabled servers are included. Wrapper-only fields (enabled, timeouts,
 * tool lists) are stripped — the SDK receives only what it understands.
 */
export function buildMcpServers(
  mcp: Record<string, McpServerConfig>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, server] of Object.entries(mcp)) {
    const srv = server as Record<string, unknown>;
    if (srv.enabled === false) continue;

    if (server.type === "stdio") {
      const s = server as McpStdioServerConfig;
      const entry: Record<string, unknown> = { type: "stdio", command: s.command };
      if (s.args && s.args.length > 0) entry.args = s.args;
      if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
      result[key] = entry;
    } else if (server.type === "http") {
      const s = server as McpHttpServerConfig;
      const entry: Record<string, unknown> = { type: "http", url: s.url };
      if (s.headers && Object.keys(s.headers).length > 0) entry.headers = s.headers;
      result[key] = entry;
    }
  }

  return result;
}
