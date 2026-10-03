/**
 * Agent Configuration — Type Definitions
 *
 * All configurable aspects of an A2A Claude agent deployment.
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

// ─── Claude Backend Config ──────────────────────────────────────────────────

export type ClaudePermissionMode = "acceptEdits" | "dontAsk" | "plan" | "bypassPermissions";

export interface ClaudeMarketplaceSourceConfig {
  /** Source kind — e.g. "github", "git", "url", "npm", "directory". */
  source: string;
  // Forward-compatible passthrough for source-specific fields (repo, url, ref,
  // sha, path, package, headers, …). Every string value supports ${ENV_VAR}.
  [key: string]: unknown;
}

export interface ClaudeMarketplaceConfig {
  /** Where to fetch the marketplace from. */
  source: ClaudeMarketplaceSourceConfig;
  // Forward-compatible passthrough for installLocation, autoUpdate, …
  [key: string]: unknown;
}

/** Reasoning effort level. Maps to SDK `Options.effort`. */
export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Extended thinking behavior. Maps to SDK `Options.thinking`.
 *
 * - "adaptive" — Claude decides when and how much to think (newer models)
 * - "enabled"  — fixed thinking token budget (older models)
 * - "disabled" — no extended thinking
 */
export type ClaudeThinkingConfig =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" }
  | { type: "disabled" };

/**
 * Structured output configuration. Maps 1:1 onto SDK `Options.outputFormat`.
 * `type: "json_schema"` is the only value the SDK supports; `schema` is a JSON
 * Schema object the model's output is constrained to match.
 */
export type ClaudeOutputFormat = {
  type: "json_schema";
  schema: Record<string, unknown>;
};

/**
 * Claude Agent SDK connection and execution settings.
 * Fields map 1:1 onto @anthropic-ai/claude-agent-sdk Options (see spec §3.1).
 */
export interface ClaudeConfig {
  /** Absolute path to the workspace Claude operates on. Required at runtime. Supports ${ENV_VAR}. */
  workingDirectory?: string;
  /** Model (e.g. "claude-sonnet-5"). Supports ${CLAUDE_MODEL}. SDK default when omitted. */
  model?: string;
  /** Fallback model when the primary is overloaded/unavailable. */
  fallbackModel?: string;
  /**
   * Reasoning effort level. Overridable via the CLAUDE_EFFORT environment
   * variable. SDK default when omitted. Silently downgraded by the SDK on
   * models that do not support the requested level.
   */
  effort?: ClaudeEffortLevel;
  /** Extended thinking behavior. SDK default when omitted. */
  thinking?: ClaudeThinkingConfig;
  /**
   * Structured JSON output. When set, the model is constrained to return JSON
   * matching `schema`; the parsed object is published as a data part on the
   * `response` artifact alongside the text. SDK default (freeform text) when
   * omitted. Maps 1:1 onto SDK `Options.outputFormat`.
   */
  outputFormat?: ClaudeOutputFormat;
  /**
   * Permission mode. "default" and "auto" are rejected — they require an
   * interactive approver / classifier, incompatible with headless A2A.
   * @default "acceptEdits"
   */
  permissionMode?: ClaudePermissionMode;
  /** Tools auto-allowed without prompting. */
  allowedTools?: string[];
  /** Tools removed from the model's context entirely. */
  disallowedTools?: string[];
  /** Appended to the claude_code preset system prompt (developerInstructions analog). */
  systemPromptAppend?: string;
  /** Full system prompt replacement. Mutually exclusive with systemPromptAppend. */
  customSystemPrompt?: string;
  /**
   * Filesystem settings sources to load. Default [] = full isolation from
   * host ~/.claude and project settings. Include "project" to load CLAUDE.md.
   */
  settingSources?: Array<"user" | "project" | "local">;
  /**
   * Plugin marketplaces to register for the session, keyed by marketplace id.
   * Maps to the SDK's `settings.extraKnownMarketplaces`, so the SDK fetches and
   * installs the plugins itself — no pre-baked plugin directories required.
   * Pin every marketplace by `ref` or `sha`: plugin hooks and bundled MCP
   * servers execute at the session's permission mode.
   */
  marketplaces?: Record<string, ClaudeMarketplaceConfig>;
  /**
   * Plugins to enable, keyed `"<plugin-id>@<marketplace-id>"`, where the
   * marketplace id must appear in `marketplaces`. Maps to the SDK's
   * `settings.enabledPlugins`. Startup fails if an enabled plugin does not
   * load — see the plugin preflight in the executor.
   */
  enabledPlugins?: Record<string, boolean>;
  /** Max conversation turns per query (runaway protection). */
  maxTurns?: number;
  /** Max budget in USD per query. */
  maxBudgetUsd?: number;
  /** Additional directories Claude can access. Supports ${ENV_VAR} per entry. */
  additionalDirectories?: string[];
  /** Opaque SDK sandbox settings passthrough (OS-level command sandboxing). */
  sandbox?: Record<string, unknown>;
  /** Override the path to the Claude executable. */
  executablePathOverride?: string;
  /** Must be true when permissionMode is "bypassPermissions". */
  dangerouslyAllowBypassPermissions?: boolean;
  /** Filename for the pre-built domain context file within workingDirectory. @default "context.md" */
  contextFile?: string;
  /** Default prompt used when buildContext() is called without an explicit prompt. */
  contextPrompt?: string;
}

// ─── Session Config ─────────────────────────────────────────────────────────

export interface SessionConfig {
  titlePrefix?: string;
  /** Reuse sessions by A2A contextId (default: true) */
  reuseByContext?: boolean;
  /**
   * Session TTL in ms, measured from when the session was created — not from
   * last use. 0 or less disables session expiry entirely, so a contextId keeps
   * resuming the same Claude session indefinitely.
   * @default 0
   */
  ttl?: number;
  /**
   * How often the background sweep reclaims expired sessions, in ms. The sweep
   * only ever runs when `ttl > 0`; 0 or less disables it, leaving expiry to the
   * lazy check in `getOrCreate`. Defaults to 0 to match `ttl` — set both if you
   * want expired sessions reclaimed without waiting for the context to be
   * looked up again.
   * @default 0
   */
  cleanupInterval?: number;
}


// ─── Feature Flags ──────────────────────────────────────────────────────────

export interface FeatureFlags {
  /** Stream artifact chunks (A2A spec-correct) vs single buffered artifact. Default: false. */
  streamArtifactChunks?: boolean;
  /** Publish thinking summaries as sideband events. Default: true. */
  emitThinkingEvents?: boolean;
  /** Publish tool_call_start/end sideband events. Default: true. */
  emitToolEvents?: boolean;
  /** Publish file change metadata as sideband events. Default: true. */
  emitFileChangeEvents?: boolean;
  /** Publish todo-list updates as sideband events. Default: true. */
  emitTodoEvents?: boolean;
  /** Publish rate-limit status changes as sideband events. Default: true. */
  emitRateLimitEvents?: boolean;
  /**
   * Hold the A2A Task open in `working` while Claude has background work in
   * flight, completing it only once a turn ends with nothing left running.
   * Default: true. Set false to complete the Task at the first SDK result, as
   * before.
   *
   * This governs the completion decision only. Queries are issued in
   * streaming-input mode either way — that is what keeps the CLI subprocess
   * alive past the first result, and it is not switchable.
   */
  holdTaskForBackgroundWork?: boolean;
  /** Publish background-task set changes as sideband events. Default: true. */
  emitBackgroundTaskEvents?: boolean;
}

// ─── Timeout Config ─────────────────────────────────────────────────────────

export interface TimeoutConfig {
  /**
   * Timeout for a single prompt in ms (default: 600_000 = 10 min).
   * Set to `0` (or any value <= 0) to disable the timeout entirely, letting a
   * turn run until it completes. See the README for the caveat about turns
   * being serialized per context.
   */
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
  /** Claude Agent SDK settings. */
  claude?: ClaudeConfig;
  session?: SessionConfig;
  features?: FeatureFlags;
  timeouts?: TimeoutConfig;
  logging?: LoggingConfig;
  /** MCP servers. The key "a2a-subagents" is reserved for the sub-agent bridge. */
  mcp?: Record<string, McpServerConfig>;
  events?: EventsConfig;
  memory?: MemoryConfig;
  subAgents?: SubAgentsConfig;
  /** Populated automatically by the CLI loader. Do not set manually. */
  configDir?: string;
}
