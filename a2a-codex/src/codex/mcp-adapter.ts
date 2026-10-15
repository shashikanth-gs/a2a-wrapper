/**
 * MCP Adapter
 *
 * Validates user-supplied MCP server configs and translates them to the
 * @openai/codex-sdk TOML-based configuration format (passed via CodexOptions.config).
 *
 * Security: The "a2a-subagents" key is reserved. User config cannot overwrite it.
 * Unsupported transports (SSE, unknown) fail loudly at startup.
 */

import type { McpServerConfig, McpStdioServerConfig, McpHttpServerConfig } from "../config/types.js";
import type { SynthesizedMcpDescriptor } from "@a2a-wrapper/core";

// ─── Constants ───────────────────────────────────────────────────────────────

const SUPPORTED_TYPES = new Set(["stdio", "http"]);
const RESERVED_KEYS = new Set(["a2a-subagents"]);

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate all MCP server entries at startup.
 * Throws with a clear error for any unsupported transport or reserved key conflict.
 */
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
          ? "Legacy SSE-only transport is not supported by the Codex SDK. " +
            "Use a Streamable HTTP (type: \"http\") server instead."
          : `Unknown transport type "${server.type}". Supported: stdio, http.`;
      throw new Error(
        `MCP server "${key}" uses unsupported transport type "${server.type}". ${hint}`,
      );
    }
  }
}

// ─── Sub-Agent Bridge Adapter ────────────────────────────────────────────────

/**
 * Translate the a2a-mcp-skillmap SynthesizedMcpDescriptor to a stdio
 * McpStdioServerConfig that can be merged into config.mcp.
 */
export function toCodexMcpEntry(descriptor: SynthesizedMcpDescriptor): McpStdioServerConfig {
  return {
    type: "stdio",
    command: descriptor.command,
    args: descriptor.args,
    env: descriptor.env,
    enabled: true,
    // Headless: the bridge is configured by the operator via `subAgents`, so
    // its tools are pre-approved. Otherwise Codex rejects delegation calls
    // with "MCP tool call requires approval, but approval policy is never".
    defaultToolsApprovalMode: "approve",
  };
}

/** Add per-server / per-tool MCP approval settings to an SDK entry. */
function applyApprovalModes(
  entry: Record<string, unknown>,
  s: { defaultToolsApprovalMode?: string; toolApprovalModes?: Record<string, string> },
): void {
  if (s.defaultToolsApprovalMode) {
    entry.default_tools_approval_mode = s.defaultToolsApprovalMode;
  }
  if (s.toolApprovalModes && Object.keys(s.toolApprovalModes).length > 0) {
    const tools: Record<string, unknown> = {};
    for (const [name, mode] of Object.entries(s.toolApprovalModes)) {
      tools[name] = { approval_mode: mode };
    }
    entry.tools = tools;
  }
}

// ─── SDK Config Translation ──────────────────────────────────────────────────

/**
 * Translate the resolved mcp map into the flat object passed as
 * CodexOptions.config.mcp_servers (maps to TOML [mcp_servers.*] entries).
 *
 * Only enabled servers are included.
 */
export function buildMcpConfig(
  mcp: Record<string, McpServerConfig>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, server] of Object.entries(mcp)) {
    const srv = server as Record<string, unknown>;
    if (srv.enabled === false) continue;

    if (server.type === "stdio") {
      const s = server as McpStdioServerConfig;
      const entry: Record<string, unknown> = {
        command: s.command,
        args: s.args ?? [],
        enabled: s.enabled ?? true,
      };
      if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
      if (s.startupTimeoutSec !== undefined) entry.startup_timeout_sec = s.startupTimeoutSec;
      if (s.toolTimeoutSec !== undefined) entry.tool_timeout_sec = s.toolTimeoutSec;
      if (s.enabledTools && s.enabledTools.length > 0) entry.enabled_tools = s.enabledTools;
      if (s.disabledTools && s.disabledTools.length > 0) entry.disabled_tools = s.disabledTools;
      applyApprovalModes(entry, s);
      result[key] = entry;
    } else if (server.type === "http") {
      const s = server as McpHttpServerConfig;
      const entry: Record<string, unknown> = {
        url: s.url,
        enabled: s.enabled ?? true,
      };
      if (s.headers && Object.keys(s.headers).length > 0) {
        // If Authorization: Bearer <token> is present, use bearer_token pattern
        const auth = s.headers["Authorization"] ?? s.headers["authorization"];
        const bearerMatch = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/) : null;
        if (bearerMatch) {
          // Pass the token value directly — the SDK accepts http_headers
          entry.http_headers = s.headers;
        } else {
          entry.http_headers = s.headers;
        }
      }
      if (s.toolTimeoutSec !== undefined) entry.tool_timeout_sec = s.toolTimeoutSec;
      applyApprovalModes(entry, s);
      result[key] = entry;
    }
  }

  return result;
}
