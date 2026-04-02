/**
 * Public API — a2a-copilot
 *
 * Re-exports everything consumers need for programmatic use.
 */

export { createA2AServer, buildAgentCard } from "./server/index.js";
export type { ServerHandle } from "./server/index.js";

export { CopilotExecutor } from "./copilot/executor.js";
export { SessionManager } from "./copilot/session-manager.js";

export {
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
} from "./copilot/event-publisher.js";

export { resolveConfig, loadConfigFile, loadEnvOverrides } from "./config/loader.js";
export type {
  AgentConfig,
  AgentCardConfig,
  ServerConfig,
  CopilotConfig,
  SessionConfig,
  FeatureFlags,
  TimeoutConfig,
  LoggingConfig,
  SkillConfig,
  McpServerConfig,
  McpHttpServerConfig,
  McpStdioServerConfig,
  CustomAgentConfig,
} from "./config/types.js";
export { DEFAULTS } from "./config/defaults.js";

export { logger, LogLevel, Logger } from "./utils/logger.js";
export { createDeferred, sleep } from "./utils/deferred.js";
