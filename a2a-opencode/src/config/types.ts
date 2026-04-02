/**
 * Agent Configuration — Type Definitions
 *
 * All configurable aspects of an A2A OpenCode agent deployment.
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

// ─── OpenCode Connection Config ─────────────────────────────────────────────

/** How the wrapper connects to and interacts with OpenCode. */
export interface OpenCodeConfig {
  /** OpenCode server base URL (default: "http://localhost:4096") */
  baseUrl?: string;
  /** Target project directory for all OpenCode API calls */
  projectDirectory?: string;
  /** Default model (e.g. "github-copilot/claude-sonnet-4.5") */
  model?: string;
  /** Default agent (e.g. "code-assistant") */
  agent?: string;
  /**
   * System prompt prepended to the first message of every session.
   * Use this to give the LLM its persona, role, and behavioral rules.
   */
  systemPrompt?: string;
  /**
   * How the system prompt is applied when injected into the first user message.
   *
   * - "append" (default): system prompt is injected as-is before the first user message.
   *
   * - "replace": a production-ready preamble is automatically prepended to your prompt
   *   that prevents tool/internals disclosure and enforces clean agent persona.
   *   Use this for production deployments.
   */
  systemPromptMode?: "append" | "replace";
  /**
   * Filename for the pre-built domain context file in the workspace directory.
   * Default: "context.md"
   */
  contextFile?: string;
  /**
   * Default prompt sent to OpenCode to build the domain context file.
   * The LLM will write its findings to the contextFile in the workspace.
   * Agent-specific: e.g. "Explore the workspace, list all files, summarise what each module does."
   */
  contextPrompt?: string;
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
  /** Auto-approve all permission requests (default: true) */
  autoApprovePermissions?: boolean;
  /** Auto-answer question requests (default: true) */
  autoAnswerQuestions?: boolean;
  /**
   * Stream artifact chunks individually (A2A spec-correct)
   * vs buffer and send single artifact (inspector-compatible).
   * Default: false (buffered).
   */
  streamArtifactChunks?: boolean;
  /** Enable polling fallback when SSE fails (default: true) */
  enablePollingFallback?: boolean;
}

// ─── Timeout Config ─────────────────────────────────────────────────────────

/** Timeout settings. */
export interface TimeoutConfig {
  /** Timeout for a single prompt in ms (default: 300_000 = 5 min) */
  prompt?: number;
  /** Polling interval in ms for fallback (default: 2_000) */
  pollingInterval?: number;
  /** Health check interval in ms (default: 30_000). 0 to disable. */
  healthCheck?: number;
}

// ─── Logging Config ─────────────────────────────────────────────────────────

/** Logging settings. */
export interface LoggingConfig {
  /** Log level: "debug" | "info" | "warn" | "error" (default: "info") */
  level?: string;
}

// ─── MCP Server Config ──────────────────────────────────────────────────────

/** Configuration for a local (stdio) MCP server. */
export interface McpLocalServerConfig {
  type: "local";
  /** Command and arguments to launch the server */
  command: string[];
  /** Environment variables passed to the spawned process */
  environment?: Record<string, string>;
  /** Enable on startup (default: true) */
  enabled?: boolean;
  /** Request timeout in ms (default: 5000) */
  timeout?: number;
}

/** OAuth config for remote MCP servers that require OAuth2 authentication. */
export interface McpOAuthServerConfig {
  /** OAuth client ID. Omit to attempt dynamic client registration (RFC 7591). */
  clientId?: string;
  /** OAuth client secret (if required by the authorization server) */
  clientSecret?: string;
  /** OAuth scopes to request during authorization */
  scope?: string;
}

/** Configuration for a remote (HTTP/SSE) MCP server. */
export interface McpRemoteServerConfig {
  type: "remote";
  /** URL of the remote MCP server (e.g. http://127.0.0.1:8080/sse) */
  url: string;
  /** Enable on startup (default: true) */
  enabled?: boolean;
  /** Extra headers sent with every request (e.g. { "Authorization": "Bearer <token>" }) */
  headers?: Record<string, string>;
  /** OAuth authentication config. Set to false to disable OAuth auto-detection. */
  oauth?: McpOAuthServerConfig | false;
  /** Request timeout in ms (default: 5000) */
  timeout?: number;
}

/** Union of local and remote MCP server configs. */
export type McpServerConfig = McpLocalServerConfig | McpRemoteServerConfig;

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
  /** OpenCode connection settings */
  opencode?: OpenCodeConfig;
  /** Session management */
  session?: SessionConfig;
  /** Feature flags */
  features?: FeatureFlags;
  /** Timeout settings */
  timeouts?: TimeoutConfig;
  /** Logging settings */
  logging?: LoggingConfig;
  /**
   * MCP servers to register with OpenCode at startup.
   * Keys are server names, values are local or remote configs.
   */
  mcp?: Record<string, McpServerConfig>;
}
