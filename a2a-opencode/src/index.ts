/**
 * Public API — a2a-opencode
 *
 * Re-exports everything consumers need for programmatic use.
 */

export { createA2AServer, interactionPolicyOf, registryOptionsOf, buildAgentCard } from "./server/index.js";
export type { ServerHandle, OpenCodeServerOptions } from "./server/index.js";

export { OpenCodeProvider, SESSION_FORMAT, toOpencodeMcpEntry } from "./opencode/provider.js";
export type { OpenCodeProviderOptions } from "./opencode/provider.js";
export { OpenCodeClientWrapper, OpenCodeApiError } from "./opencode/client.js";
export { EventStreamManager } from "./opencode/event-stream.js";

export { resolveConfig, loadConfigFile, loadEnvOverrides } from "./config/loader.js";
export type { AgentConfig, AgentCardConfig, ServerConfig, OpenCodeConfig, SessionConfig, FeatureFlags, TimeoutConfig, LoggingConfig, SkillConfig, InteractionsConfig, McpServerConfig, McpLocalServerConfig, McpRemoteServerConfig, McpOAuthServerConfig } from "./config/types.js";
export { DEFAULTS } from "./config/defaults.js";
export type { DefaultAgentConfig } from "./config/defaults.js";

export { registerMcpServers, getMcpStatus } from "./opencode/mcp-manager.js";
export type { McpRegistrationResult, McpManagerOptions } from "./opencode/mcp-manager.js";

export { logger, LogLevel, Logger } from "./utils/logger.js";
export { createDeferred, sleep } from "./utils/deferred.js";
