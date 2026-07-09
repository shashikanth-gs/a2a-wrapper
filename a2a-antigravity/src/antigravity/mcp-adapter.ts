/**
 * MCP Adapter
 *
 * Validates wrapper MCP config and translates synthesized sub-agent bridge
 * descriptors into the same stdio shape consumed by the Python bridge.
 */

import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from "../config/types.js";
import type { SynthesizedMcpDescriptor } from "@a2a-wrapper/core";

const SUPPORTED_TYPES = new Set(["stdio", "http"]);
const RESERVED_KEYS = new Set(["a2a-subagents"]);

export function validateMcpServers(mcp: Record<string, McpServerConfig>): void {
  for (const [key, server] of Object.entries(mcp)) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `MCP server key "${key}" is reserved for the A2A sub-agent bridge. ` +
        "Rename your MCP server entry.",
      );
    }
    if (!SUPPORTED_TYPES.has(server.type)) {
      throw new Error(
        `MCP server "${key}" uses unsupported transport type "${server.type}". ` +
        "Supported: stdio, http.",
      );
    }
    if (
      "enabledTools" in server &&
      "disabledTools" in server &&
      server.enabledTools &&
      server.disabledTools
    ) {
      throw new Error(
        `MCP server "${key}" cannot set both enabledTools and disabledTools.`,
      );
    }
  }
}

export function toAntigravityMcpEntry(
  descriptor: SynthesizedMcpDescriptor,
): McpStdioServerConfig {
  return {
    type: "stdio",
    command: descriptor.command,
    args: descriptor.args,
    env: descriptor.env,
    enabled: true,
  };
}

export type { McpHttpServerConfig, McpStdioServerConfig };
