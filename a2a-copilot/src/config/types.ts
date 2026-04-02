/**
 * Agent Configuration — Type Definitions
 *
 * All configurable aspects of an A2A GitHub Copilot agent deployment.
 * A single JSON file (or programmatic object) drives the entire wrapper.
 */

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
  /** Enable on startup (default: true) */
  enabled?: boolean;
}

/** Configuration for an MCP server connected via SSE. */
export interface McpSseServerConfig {
  type: "sse";
  /** URL of the SSE MCP server endpoint (e.g. http://127.0.0.1:8001/sse) */
  url: string;
  /** Enable on startup (default: true) */
  enabled?: boolean;
}

/** Configuration for a stdio-based MCP server. */
export interface McpStdioServerConfig {
  type: "stdio";
  /** Command to launch the MCP server */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the spawned process */
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
}
