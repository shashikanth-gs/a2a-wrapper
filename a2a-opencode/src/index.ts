/**
 * Public API — a2a-opencode
 *
 * Re-exports everything consumers need for programmatic use.
 */

export { createA2AServer, buildAgentCard } from "./server/index.js";
export type { ServerHandle } from "./server/index.js";

export { OpenCodeExecutor } from "./opencode/executor.js";
export { OpenCodeClientWrapper, OpenCodeApiError } from "./opencode/client.js";
export { EventStreamManager } from "./opencode/event-stream.js";
export { PermissionHandler } from "./opencode/permission-handler.js";
export { SessionManager } from "./opencode/session-manager.js";

export {
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
} from "./opencode/event-publisher.js";

export { resolveConfig, loadConfigFile, loadEnvOverrides } from "./config/loader.js";
export type { AgentConfig, AgentCardConfig, ServerConfig, OpenCodeConfig, SessionConfig, FeatureFlags, TimeoutConfig, LoggingConfig, SkillConfig, McpServerConfig, McpLocalServerConfig, McpRemoteServerConfig, McpOAuthServerConfig } from "./config/types.js";
export { DEFAULTS } from "./config/defaults.js";

export { registerMcpServers, getMcpStatus } from "./opencode/mcp-manager.js";
export type { McpRegistrationResult, McpManagerOptions } from "./opencode/mcp-manager.js";

export { logger, LogLevel, Logger } from "./utils/logger.js";
export { createDeferred, sleep } from "./utils/deferred.js";
