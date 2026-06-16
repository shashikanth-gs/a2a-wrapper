/**
 * Agent Configuration — Type Definitions
 *
 * All configurable aspects of an A2A GitHub Copilot agent deployment.
 * A single JSON file (or programmatic object) drives the entire wrapper.
 */

import type {
  EventsConfig,
  MemoryConfig,
  SubAgentsConfig,
} from "@a2a-wrapper/core";

// ─── Agent Card Config ──────────────────────────────────────────────────────

/** A single skill exposed on the agent card. */
export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

/** Agent identity and capabilities advertised via the A2A Agent Card. */
export interface AgentCardConfig {
  /** Human-readable agent name */
  name: string;
  /** Agent description (shown to orchestrators / callers) */
  description: string;
  /** Protocol version (default: "0.3.0") */
  protocolVersion?: string;
  /** Agent software version (default: "1.0.0") */
  version?: string;
  /** Skills this agent exposes */
  skills?: SkillConfig[];
  /** Supported input modes (default: ["text"]) */
  defaultInputModes?: string[];
  /** Supported output modes (default: ["text"]) */
  defaultOutputModes?: string[];
  /** Enable streaming capability (default: true) */
  streaming?: boolean;
  /** Enable push notifications (default: false) */
  pushNotifications?: boolean;
  /**
   * Enable state transition history capability advertisement.
   * @deprecated This capability is not implemented in the A2A v1.0 spec and
   * was removed. Kept for backward compatibility only — value is ignored.
   * Default: false.
   */
  stateTransitionHistory?: boolean;
  /** Agent provider info */
  provider?: { organization: string; url?: string };
}

// ─── Server Config ──────────────────────────────────────────────────────────

/** Network and server settings. */
export interface ServerConfig {
  /** A2A server port (default: 3000) */
  port?: number;
  /** Bind address (default: "0.0.0.0") */
  hostname?: string;
  /**
   * Hostname advertised in agent card URLs (default: "localhost").
   * Set to machine IP or "host.containers.internal" for Docker.
   */
  advertiseHost?: string;
  /**
   * Protocol used in advertised URLs (default: "http").
   * Set to "https" when the agent is deployed behind TLS or a TLS-terminating
   * reverse proxy. The A2A spec requires HTTPS for production deployments.
   */
  advertiseProtocol?: "http" | "https";
}

// ─── Provider Config (BYOK) ─────────────────────────────────────────────────

/**
 * Azure-specific provider options.
 * Only relevant when `type` is "azure".
 */
export interface AzureProviderOptions {
  /**
   * Azure OpenAI API version.
   * Default: "2024-10-21"
   */
  apiVersion?: string;
}

/**
 * Custom LLM provider configuration (BYOK — Bring Your Own Key).
 *
 * When set, sessions use this provider instead of GitHub Copilot.
 * Omit entirely to use the default GitHub Copilot API (no BYOK).
 *
 * Supported providers and their recommended settings:
 *
 * | Provider          | type        | baseUrl                                | wireApi        |
 * |-------------------|-------------|----------------------------------------|----------------|
 * | GitHub Copilot    | (omit)      | (omit)                                 | (omit)         |
 * | Ollama (local)    | "openai"    | http://localhost:11434/v1              | "completions"  |
 * | OpenAI            | "openai"    | https://api.openai.com/v1              | "responses"    |
 * | Anthropic         | "anthropic" | https://api.anthropic.com              | (N/A)          |
 * | Azure OpenAI      | "azure"     | https://<resource>.openai.azure.com    | "completions"  |
 * | Azure AI Foundry  | "openai"    | https://<resource>.openai.azure.com/openai/v1/ | "responses" |
 * | vLLM / LiteLLM   | "openai"    | http://<host>:<port>/v1                | "completions"  |
 */
export interface ProviderConfig {
  /**
   * Provider type. Determines the API format and auth mechanism.
   *
   * - "openai"    — OpenAI Chat Completions API and any compatible endpoint
   *                 (Ollama, vLLM, LiteLLM, Azure AI Foundry, etc.)
   * - "azure"     — Native Azure OpenAI Service (*.openai.azure.com)
   * - "anthropic" — Anthropic Messages API (Claude models)
   *
   * Default: "openai"
   */
  type?: "openai" | "azure" | "anthropic";

  /**
   * Required. API endpoint base URL.
   *
   * - OpenAI / compatible: include the full path, e.g. https://api.openai.com/v1
   * - Ollama local: http://localhost:11434/v1
   * - Azure (native): just the host, e.g. https://my-resource.openai.azure.com
   *   (do NOT append /openai/v1 — the SDK constructs the path)
   * - Anthropic: https://api.anthropic.com
   */
  baseUrl: string;

  /**
   * API key for authentication. Optional for local providers (e.g. Ollama).
   *
   * Can also be set via environment variable COPILOT_PROVIDER_API_KEY.
   */
  apiKey?: string;

  /**
   * Bearer token for authentication. Sets the Authorization header directly.
   * Takes precedence over apiKey when both are set.
   * Use for services that require bearer token auth instead of an API key.
   */
  bearerToken?: string;

  /**
   * Wire API format used to communicate with the model endpoint.
   * Only applies to "openai" and "azure" provider types.
   * Anthropic always uses the Messages API regardless of this setting.
   *
   * - "completions" (default) — Chat Completions API (/chat/completions).
   *   Broadest model compatibility. Recommended for Ollama, vLLM, local models.
   * - "responses" — Responses API. Provides multi-turn state management,
   *   tool namespacing, and reasoning support.
   *   Recommended for OpenAI GPT-4+ and Azure AI Foundry (GPT-5 series).
   */
  wireApi?: "completions" | "responses";

  /**
   * Azure-specific options. Only relevant when type is "azure".
   */
  azure?: AzureProviderOptions;
}

// ─── Copilot SDK Connection Config ──────────────────────────────────────────

/** How the wrapper connects to and interacts with GitHub Copilot SDK. */
export interface CopilotConfig {
  /**
   * External Copilot CLI server URL (e.g. "localhost:4321").
   * If set, the SDK connects to this pre-running CLI server
   * instead of managing its own CLI process.
   */
  cliUrl?: string;
  /**
   * GitHub Personal Access Token for authentication.
   * Required in Docker containers where `gh` CLI is not available.
   * Maps to the SDK's `githubToken` option.
   */
  githubToken?: string;
  /** Default model for sessions (e.g. "gpt-4.1", "claude-sonnet-4.5") */
  model?: string;
  /** Enable streaming by default on sessions (default: true) */
  streaming?: boolean;
  /**
   * System prompt prepended to the first message of every session.
   * Use this to give the LLM its persona, role, and behavioral rules.
   */
  systemPrompt?: string;
  /**
   * How the system prompt is applied to the SDK-managed system message.
   *
   * - "append" (default): your prompt is appended after the SDK's built-in
   *   system message. The SDK's coding-assistant persona remains active.
   *   Safe choice when you want to add constraints without replacing the base.
   *
   * - "replace": your prompt completely replaces the SDK's system message.
   *   A production-ready preamble is automatically prepended to instruct the
   *   model to act as a deployed agent (no tool disclosure, no internal detail
   *   leakage). Use this when you need a clean, custom persona.
   */
  systemPromptMode?: "append" | "replace";
  /**
   * Filename for the pre-built domain context file in the workspace directory.
   * Default: "context.md"
   */
  contextFile?: string;
  /**
   * Default prompt sent to build the domain context file.
   * The LLM will write its findings to the contextFile.
   */
  contextPrompt?: string;
  /** Working directory for context file operations */
  workspaceDirectory?: string;
  /**
   * Custom LLM provider configuration (BYOK — Bring Your Own Key).
   *
   * When set, bypasses GitHub Copilot and connects directly to the specified
   * provider. Supports Ollama (local), OpenAI, Anthropic, Azure OpenAI,
   * Azure AI Foundry, vLLM, LiteLLM, and any OpenAI-compatible endpoint.
   *
   * Omit this field entirely to use the default GitHub Copilot API.
   *
   * Note: when provider is set, the `model` field is REQUIRED — the SDK
   * cannot auto-detect models from custom providers.
   */
  provider?: ProviderConfig;
}

// ─── Session Config ─────────────────────────────────────────────────────────

/** Session lifecycle management. */
export interface SessionConfig {
  /** Session title prefix (default: "A2A Session") */
  titlePrefix?: string;
  /** Reuse sessions by A2A contextId (default: true) */
  reuseByContext?: boolean;
  /** Session TTL in ms (default: 3_600_000 = 1 hour) */
  ttl?: number;
  /** Session cleanup interval in ms (default: 300_000 = 5 min) */
  cleanupInterval?: number;
}

// ─── Feature Flags ──────────────────────────────────────────────────────────

/** Feature toggles for runtime behavior. */
export interface FeatureFlags {
  /**
   * Stream artifact chunks individually (A2A spec-correct)
   * vs buffer and send single artifact (inspector-compatible).
   * Default: false (buffered).
   */
  streamArtifactChunks?: boolean;

  /** @see BaseFeatureFlags.trackUsage */
  trackUsage?: boolean;
}

// ─── Timeout Config ─────────────────────────────────────────────────────────

/** Timeout settings. */
export interface TimeoutConfig {
  /** Timeout for a single prompt in ms (default: 600_000 = 10 min) */
  prompt?: number;
}

// ─── Logging Config ─────────────────────────────────────────────────────────

/** Logging settings. */
export interface LoggingConfig {
  /** Log level: "debug" | "info" | "warn" | "error" (default: "info") */
  level?: string;
}

// ─── MCP Server Config ──────────────────────────────────────────────────────

/** Configuration for an MCP server connected via HTTP (streamable). */
export interface McpHttpServerConfig {
  type: "http";
  /** URL of the remote MCP server (e.g. http://127.0.0.1:8002/mcp) */
  url: string;
  /**
   * Optional HTTP headers sent with every request to this server.
   * Use for auth tokens, API keys, etc. Values support `${ENV_VAR}` (or
   * `$ENV_VAR`) substitution so secrets stay out of config.json — e.g.
   * `{ "Authorization": "Bearer ${LINEAR_API_KEY}" }`.
   */
  headers?: Record<string, string>;
  /** Enable on startup (default: true) */
  enabled?: boolean;
}

/** Configuration for an MCP server connected via SSE. */
export interface McpSseServerConfig {
  type: "sse";
  /** URL of the SSE MCP server endpoint (e.g. http://127.0.0.1:8001/sse) */
  url: string;
  /**
   * Optional HTTP headers sent with every request to this server.
   * Use for auth tokens, API keys, etc. Values support `${ENV_VAR}` (or
   * `$ENV_VAR`) substitution so secrets stay out of config.json — e.g.
   * `{ "Authorization": "Bearer ${NOTION_TOKEN}" }`.
   */
  headers?: Record<string, string>;
  /** Enable on startup (default: true) */
  enabled?: boolean;
}

/** Configuration for a stdio-based MCP server. */
export interface McpStdioServerConfig {
  type: "stdio";
  /** Command to launch the MCP server */
  command: string;
  /**
   * Arguments to pass to the command.
   * Values support `${ENV_VAR}` (or `$ENV_VAR`) substitution.
   */
  args?: string[];
  /**
   * Environment variables for the spawned process.
   * Values support `${ENV_VAR}` (or `$ENV_VAR`) substitution so secrets
   * stay out of config.json — e.g. `{ "API_KEY": "${MY_API_KEY}" }`.
   */
  env?: Record<string, string>;
  /** Enable on startup (default: true) */
  enabled?: boolean;
}

/** Union of MCP server configs. */
export type McpServerConfig = McpHttpServerConfig | McpSseServerConfig | McpStdioServerConfig;

// ─── Custom Agent Config ────────────────────────────────────────────────────

/** A custom agent definition passed to the Copilot SDK session. */
export interface CustomAgentConfig {
  name: string;
  displayName?: string;
  description?: string;
  prompt?: string;
}

// ─── Root Config ────────────────────────────────────────────────────────────

/**
 * Complete agent configuration.
 *
 * This is what a JSON config file (e.g. `agents/example/config.json`) maps to.
 * All fields are optional — sensible defaults are applied for everything.
 */
export interface AgentConfig {
  /** Agent card identity & capabilities */
  agentCard: AgentCardConfig;
  /** Network / server settings */
  server?: ServerConfig;
  /** Copilot SDK connection settings */
  copilot?: CopilotConfig;
  /** Session management */
  session?: SessionConfig;
  /** Feature flags */
  features?: FeatureFlags;
  /** Timeout settings */
  timeouts?: TimeoutConfig;
  /** Logging settings */
  logging?: LoggingConfig;
  /**
   * MCP servers to connect via Copilot SDK at session creation.
   * Keys are server names, values are server configs.
   */
  mcp?: Record<string, McpServerConfig>;
  /**
   * Custom agent definitions to register with Copilot sessions.
   */
  customAgents?: CustomAgentConfig[];
  /** Event transport configuration for sideband observability events. */
  events?: EventsConfig;
  /**
   * Optional memory configuration for persisting instructions and skills.
   * When present, the materializer writes these to backend-specific paths
   * in the workspace directory during executor initialization.
   */
  memory?: MemoryConfig;
  /**
   * Optional sub-agents to expose as MCP tools via the `a2a-mcp-skillmap`
   * bridge. When present, the parent agent spawns skillmap as a stdio MCP
   * server and registers it under the reserved `a2a-subagents` key in the
   * resolved {@link mcp} map. Sub-agents declared here become callable as
   * ordinary MCP tools by the Copilot SDK runtime.
   *
   * When this field is absent or `agents` is empty, the parent skips every
   * sub-agent code path with no side effects.
   *
   * @see {@link ../../../.kiro/specs/a2a-subagents/design.md}
   */
  subAgents?: SubAgentsConfig;
  /**
   * Directory containing the agent's config.json file.
   * Populated automatically by the CLI scaffold when a config file path is provided.
   * Used by the materializer for resolving relative paths in memory config.
   */
  configDir?: string;
}
