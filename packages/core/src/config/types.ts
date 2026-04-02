/**
 * Base Configuration Types
 *
 * Shared TypeScript interfaces for all configurable aspects of an A2A agent
 * wrapper deployment. These types unify the common configuration sections
 * found in both `a2a-copilot` and `a2a-opencode`, providing a single source
 * of truth for agent card identity, server networking, session lifecycle,
 * feature flags, timeouts, logging, and MCP server definitions.
 *
 * Wrapper-specific configuration (e.g. `CopilotConfig`, `OpenCodeConfig`) is
 * injected via the `TBackend` generic parameter on {@link BaseAgentConfig},
 * keeping this module completely decoupled from any particular backend.
 *
 * @module config/types
 */

// ─── Skill Config ───────────────────────────────────────────────────────────

/**
 * A single skill exposed on the agent card.
 *
 * Skills describe discrete capabilities the agent advertises to orchestrators
 * and callers via the A2A Agent Card. Each skill has a unique identifier,
 * human-readable metadata, and optional usage examples.
 */
export interface SkillConfig {
  /**
   * Unique identifier for this skill.
   * Used as the stable key when referencing the skill programmatically.
   */
  id: string;

  /**
   * Human-readable display name for the skill.
   * Shown in agent card UIs and orchestrator dashboards.
   */
  name: string;

  /**
   * Detailed description of what this skill does.
   * Helps orchestrators decide whether to route a task to this agent.
   */
  description: string;

  /**
   * Optional tags for categorization and discovery.
   * Orchestrators may use tags to filter or group agents by capability.
   */
  tags?: string[];

  /**
   * Optional example prompts demonstrating how to invoke this skill.
   * Included in the agent card only when non-empty.
   */
  examples?: string[];
}

// ─── Agent Card Config ──────────────────────────────────────────────────────

/**
 * Agent identity and capabilities advertised via the A2A Agent Card.
 *
 * This interface captures all fields that appear in the public-facing agent
 * card served at `/.well-known/agent-card.json`. Orchestrators and callers
 * use this metadata to discover the agent's name, supported modes,
 * streaming capability, and available skills.
 */
export interface AgentCardConfig {
  /**
   * Human-readable agent name.
   * Displayed in orchestrator UIs and agent discovery listings.
   */
  name: string;

  /**
   * Agent description shown to orchestrators and callers.
   * Should concisely explain the agent's purpose and domain expertise.
   */
  description: string;

  /**
   * A2A protocol version this agent supports.
   * @default "0.3.0"
   */
  protocolVersion?: string;

  /**
   * Agent software version string.
   * @default "1.0.0"
   */
  version?: string;

  /**
   * Skills this agent exposes to callers.
   * Each skill represents a discrete capability advertised in the agent card.
   */
  skills?: SkillConfig[];

  /**
   * Supported input content modes.
   * @default ["text"]
   */
  defaultInputModes?: string[];

  /**
   * Supported output content modes.
   * @default ["text"]
   */
  defaultOutputModes?: string[];

  /**
   * Whether the agent supports streaming responses.
   * @default true
   */
  streaming?: boolean;

  /**
   * Whether the agent supports push notifications.
   * @default false
   */
  pushNotifications?: boolean;

  /**
   * Enable state transition history capability advertisement.
   *
   * @deprecated This capability is not implemented in the A2A v1.0 spec and
   * was removed. Kept for backward compatibility only — value is ignored.
   * The agent card builder always sets this to `false`.
   * @default false
   */
  stateTransitionHistory?: boolean;

  /**
   * Agent provider information.
   * Identifies the organization responsible for this agent deployment.
   */
  provider?: {
    /** Organization name. */
    organization: string;
    /** Optional URL for the provider's website or documentation. */
    url?: string;
  };
}

// ─── Server Config ──────────────────────────────────────────────────────────

/**
 * Network and server settings for the A2A HTTP server.
 *
 * Controls the bind address, port, and the externally-advertised hostname
 * and protocol used when constructing agent card endpoint URLs.
 */
export interface ServerConfig {
  /**
   * TCP port the A2A server listens on.
   * @default 3000
   */
  port?: number;

  /**
   * Network interface bind address.
   * @default "0.0.0.0"
   */
  hostname?: string;

  /**
   * Hostname advertised in agent card endpoint URLs.
   * Set to the machine's public IP or `"host.containers.internal"` for Docker.
   * @default "localhost"
   */
  advertiseHost?: string;

  /**
   * Protocol used in advertised endpoint URLs.
   * Set to `"https"` when deployed behind TLS or a TLS-terminating reverse
   * proxy. The A2A spec requires HTTPS for production deployments.
   * @default "http"
   */
  advertiseProtocol?: "http" | "https";
}

// ─── Session Config ─────────────────────────────────────────────────────────

/**
 * Session lifecycle management settings.
 *
 * Controls how the session manager maps A2A `contextId` values to backend
 * sessions, including TTL-based expiration and periodic cleanup.
 */
export interface SessionConfig {
  /**
   * Prefix applied to session titles when creating new backend sessions.
   * @default "A2A Session"
   */
  titlePrefix?: string;

  /**
   * Whether to reuse existing sessions for the same A2A `contextId`.
   * When enabled, subsequent requests with the same contextId are routed
   * to the previously created backend session.
   * @default true
   */
  reuseByContext?: boolean;

  /**
   * Session time-to-live in milliseconds.
   * Sessions exceeding this age are removed during the next cleanup cycle.
   * @default 3_600_000 (1 hour)
   */
  ttl?: number;

  /**
   * Interval in milliseconds between session cleanup sweeps.
   * @default 300_000 (5 minutes)
   */
  cleanupInterval?: number;
}

// ─── Feature Flags ──────────────────────────────────────────────────────────

/**
 * Base feature flags shared across all wrapper projects.
 *
 * Contains only the flags that are common to every A2A wrapper. Individual
 * wrapper projects extend this interface with backend-specific flags
 * (e.g. `autoApprovePermissions` in a2a-opencode).
 */
export interface BaseFeatureFlags {
  /**
   * Whether to stream artifact chunks individually (A2A spec-correct behavior)
   * or buffer and send a single artifact (inspector-compatible).
   * @default false (buffered)
   */
  streamArtifactChunks?: boolean;
}

// ─── Timeout Config ─────────────────────────────────────────────────────────

/**
 * Timeout settings for various agent operations.
 *
 * Unifies timeout fields from both wrapper projects into a single interface.
 * All values are in milliseconds.
 */
export interface TimeoutConfig {
  /**
   * Maximum time to wait for a single prompt/request to complete.
   * @default 300_000 (5 minutes)
   */
  prompt?: number;

  /**
   * Polling interval for fallback transport when SSE is unavailable.
   * @default 2_000 (2 seconds)
   */
  pollingInterval?: number;

  /**
   * Interval between health check pings. Set to `0` to disable.
   * @default 30_000 (30 seconds)
   */
  healthCheck?: number;
}

// ─── Logging Config ─────────────────────────────────────────────────────────

/**
 * Logging settings for the agent runtime.
 *
 * Controls the minimum log level emitted by the {@link Logger} instance.
 */
export interface LoggingConfig {
  /**
   * Minimum log level: `"debug"`, `"info"`, `"warn"`, or `"error"`.
   * @default "info"
   */
  level?: string;
}

// ─── MCP Server Config ──────────────────────────────────────────────────────

/**
 * Base MCP server configuration with a type discriminator.
 *
 * Provides the minimal shared shape for MCP server entries. Each wrapper
 * project defines its own concrete MCP server config types (e.g. stdio,
 * HTTP, SSE, remote) that extend or satisfy this base interface.
 */
export interface BaseMcpServerConfig {
  /**
   * Transport type discriminator.
   * Wrapper projects use this to distinguish between server kinds
   * (e.g. `"stdio"`, `"http"`, `"sse"`, `"local"`, `"remote"`).
   */
  type: string;

  /**
   * Whether this MCP server is enabled on startup.
   * @default true
   */
  enabled?: boolean;
}

// ─── Root Config ────────────────────────────────────────────────────────────

/**
 * Base agent configuration parameterized by backend-specific config.
 *
 * This generic interface represents the complete, resolved configuration for
 * an A2A agent wrapper. It includes all shared sections (agent card, server,
 * session, features, timeouts, logging, MCP) plus a generic `backend` field
 * that each wrapper project fills with its own backend-specific type
 * (e.g. `CopilotConfig`, `OpenCodeConfig`).
 *
 * Wrapper projects compose their full config type as:
 * ```typescript
 * type AgentConfig = BaseAgentConfig<CopilotConfig>;
 * ```
 *
 * @typeParam TBackend - Wrapper-specific backend configuration type.
 *   Defaults to `Record<string, unknown>` for contexts where the backend
 *   type is not yet known or not relevant.
 */
export interface BaseAgentConfig<TBackend = Record<string, unknown>> {
  /**
   * Agent card identity and capabilities advertised via the A2A protocol.
   * Drives the contents of `/.well-known/agent-card.json`.
   */
  agentCard: AgentCardConfig;

  /**
   * Network and server settings controlling bind address, port, and
   * externally-advertised endpoint URLs.
   */
  server: ServerConfig;

  /**
   * Backend-specific configuration section.
   * Replaces the project-specific `copilot` / `opencode` fields from the
   * original wrapper projects, enabling full type safety via generics.
   */
  backend: TBackend;

  /**
   * Session lifecycle management settings including TTL, cleanup interval,
   * and contextId-based session reuse.
   */
  session: SessionConfig;

  /**
   * Base feature flags shared across all wrappers.
   * Wrapper projects may extend {@link BaseFeatureFlags} with additional
   * backend-specific flags.
   */
  features: BaseFeatureFlags;

  /**
   * Timeout settings for prompt execution, polling, and health checks.
   */
  timeouts: TimeoutConfig;

  /**
   * Logging configuration controlling the minimum log level.
   */
  logging: LoggingConfig;

  /**
   * MCP servers to register with the backend at startup.
   * Keys are server names, values are server configurations satisfying
   * the {@link BaseMcpServerConfig} base interface.
   */
  mcp: Record<string, BaseMcpServerConfig>;
}
