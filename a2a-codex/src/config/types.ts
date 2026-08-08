/**
 * Agent Configuration — Type Definitions
 *
 * All configurable aspects of an A2A Codex agent deployment.
 * A single JSON file (or programmatic object) drives the entire wrapper.
 */

import type {
  AgentCardConfig,
  EventsConfig,
  MemoryConfig,
  SubAgentsConfig,
} from "@a2a-wrapper/core";

// ─── Agent Card Config ──────────────────────────────────────────────────────

export type { AgentCardConfig, SkillConfig } from "@a2a-wrapper/core";

// ─── Server Config ──────────────────────────────────────────────────────────

export interface ServerConfig {
  port?: number;
  hostname?: string;
  /**
   * Hostname advertised in agent card URLs (default: "localhost").
   * Set to machine IP or "host.containers.internal" for Docker.
   */
  advertiseHost?: string;
  /**
   * Protocol used in advertised URLs (default: "http").
   * Set to "https" when deployed behind TLS or a TLS-terminating reverse proxy.
   */
  advertiseProtocol?: "http" | "https";
}

// ─── Codex Backend Config ───────────────────────────────────────────────────

/**
 * OpenAI Codex SDK connection and execution settings.
 *
 * All fields map to @openai/codex-sdk ThreadOptions or CodexOptions.
 * The `workingDirectory` field is required at runtime — it must resolve to an
 * existing Git repository directory (unless skipGitRepoCheck is true).
 */
export interface CodexConfig {
  /**
   * Absolute path to the Git repository Codex should operate on.
   * Required at runtime (validated by the executor). Supports ${ENV_VAR} substitution.
   */
  workingDirectory?: string;
  /**
   * Model to use (e.g. "o4-mini", "gpt-4o"). Falls back to Codex default when omitted.
   * Supports ${CODEX_MODEL} environment variable substitution.
   */
  model?: string;
  /**
   * Codex sandbox mode controlling filesystem access.
   * - "read-only"          — analysis and review tasks; no file writes
   * - "workspace-write"    — recommended default; writes scoped to workingDirectory
   * - "danger-full-access" — unrestricted; requires explicit opt-in and logs a warning
   * @default "workspace-write"
   */
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * Tool approval policy for shell commands and MCP tool calls.
   * - "never"      — auto-approve all (recommended for headless A2A operation)
   * - "on-failure" — approve only on command failure
   * - "untrusted"  — approve tools from untrusted sources
   * - "on-request" — blocked; interactive approvals are incompatible with headless A2A
   * @default "never"
   */
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  /**
   * Allow Codex to make outbound network requests.
   * Disabled by default for security. Enable only when explicitly required.
   * @default false
   */
  networkAccessEnabled?: boolean;
  /**
   * Web search access for Codex.
   * - "disabled" — no web search (default, secure)
   * - "cached"   — use cached search results only
   * - "live"     — live web search (requires networkAccessEnabled: true)
   * @default "disabled"
   */
  webSearchMode?: "disabled" | "cached" | "live";
  /**
   * Skip Codex's built-in Git repository validation check.
   * Leave false to ensure the workspace is a real git repo.
   * @default false
   */
  skipGitRepoCheck?: boolean;
  /**
   * Additional directories to make accessible to Codex beyond workingDirectory.
   * Each path supports ${ENV_VAR} substitution. Use with care.
   */
  additionalDirectories?: string[];
  /**
   * Instructions prepended to every Codex prompt as developer context.
   * Use to enforce coding standards, tool usage rules, and safety constraints.
   */
  developerInstructions?: string;
  /** Override the OpenAI API base URL (useful for corporate proxies). */
  baseUrl?: string;
  /** Override the path to the Codex CLI binary. */
  codexPathOverride?: string;
  /**
   * Additional Codex configuration overrides passed as CodexOptions.config.
   * Mapped to --config key=value CLI arguments. See Codex config reference.
   */
  configOverrides?: Record<string, unknown>;
  /**
   * Filename for the pre-built domain context file within workingDirectory.
   * @default "context.md"
   */
  contextFile?: string;
  /**
   * Default prompt used when buildContext() is called without an explicit prompt.
   */
  contextPrompt?: string;
}

// ─── Session Config ─────────────────────────────────────────────────────────

export interface SessionConfig {
  titlePrefix?: string;
  /** Reuse sessions by A2A contextId (default: true) */
  reuseByContext?: boolean;
  /** Session TTL in ms (default: 3_600_000 = 1 hour) */
  ttl?: number;
  /** Session cleanup interval in ms (default: 300_000 = 5 min) */
  cleanupInterval?: number;
}

// ─── Feature Flags ──────────────────────────────────────────────────────────

export interface FeatureFlags {
  /**
   * Stream artifact chunks individually (A2A spec-correct) vs buffer and send
   * single artifact (inspector-compatible). Default: false (buffered).
   */
  streamArtifactChunks?: boolean;
  /** Publish reasoning summaries as thinking sideband events. Default: true. */
  emitReasoningSummaries?: boolean;
  /** Publish shell command start/end as tool_call sideband events. Default: true. */
  emitCommandEvents?: boolean;
  /** Publish file change metadata as sideband events. Default: true. */
  emitFileChangeEvents?: boolean;
}

// ─── Timeout Config ─────────────────────────────────────────────────────────

export interface TimeoutConfig {
  /** Timeout for a single prompt in ms (default: 600_000 = 10 min) */
  prompt?: number;
}

// ─── Logging Config ─────────────────────────────────────────────────────────

export interface LoggingConfig {
  level?: string;
}

// ─── MCP Server Config ──────────────────────────────────────────────────────

export interface McpStdioServerConfig {
  type: "stdio";
  /** Command to launch the MCP server. */
  command: string;
  /** Arguments. Values support ${ENV_VAR} substitution. */
  args?: string[];
  /** Environment variables for the spawned process. Values support ${ENV_VAR} substitution. */
  env?: Record<string, string>;
  enabled?: boolean;
  /** MCP server startup timeout in seconds. */
  startupTimeoutSec?: number;
  /** Per-tool call timeout in seconds. */
  toolTimeoutSec?: number;
  /** Allowlist of tool names to expose. If set, only these tools are accessible. */
  enabledTools?: string[];
  /** Denylist of tool names to block. */
  disabledTools?: string[];
}

export interface McpHttpServerConfig {
  type: "http";
  /** URL of the Streamable HTTP MCP server. */
  url: string;
  /**
   * HTTP headers sent with every request.
   * Values support ${ENV_VAR} substitution.
   * Use for bearer tokens: { "Authorization": "Bearer ${TOKEN}" }
   */
  headers?: Record<string, string>;
  enabled?: boolean;
  toolTimeoutSec?: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | { type: string; [k: string]: unknown };

// ─── Root Config ────────────────────────────────────────────────────────────

/**
 * Complete agent configuration.
 *
 * This is what a JSON config file (e.g. `agents/example/config.json`) maps to.
 * All fields except `agentCard` are optional — sensible secure defaults are applied.
 */
export interface AgentConfig {
  agentCard: AgentCardConfig;
  server?: ServerConfig;
  /** Codex SDK connection and execution settings. */
  codex?: CodexConfig;
  session?: SessionConfig;
  features?: FeatureFlags;
  timeouts?: TimeoutConfig;
  logging?: LoggingConfig;
  /**
   * MCP servers to register with Codex at startup.
   * Keys are server names; values are stdio or http server configs.
   * The key "a2a-subagents" is reserved for the sub-agent bridge.
   */
  mcp?: Record<string, McpServerConfig>;
  events?: EventsConfig;
  memory?: MemoryConfig;
  subAgents?: SubAgentsConfig;
  /**
   * Directory containing the agent's config.json file.
   * Populated automatically by the CLI loader. Do not set manually.
   */
  configDir?: string;
}
