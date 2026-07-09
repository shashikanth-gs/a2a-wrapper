/**
 * a2a-antigravity — Public API
 */

export { AntigravityExecutor } from "./antigravity/executor.js";
export { BridgeClient } from "./antigravity/bridge-client.js";
export { EventMapper } from "./antigravity/event-mapper.js";
export { SessionManager } from "./antigravity/session-manager.js";
export { ANTIGRAVITY_BACKEND_PATHS } from "./antigravity/backend-paths.js";
export type {
  BridgeConfig,
  BridgeMessage,
  BridgeRequest,
  BridgeRunEvent,
  BridgeUsage,
} from "./antigravity/bridge-protocol.js";
export type {
  AgentConfig,
  AntigravityConfig,
  AntigravityProviderConfig,
  AntigravityCapabilitiesConfig,
  AntigravityPolicyConfig,
  FeatureFlags,
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpServerConfig,
} from "./config/types.js";
export { DEFAULTS } from "./config/defaults.js";
export { loadConfigFile, loadEnvOverrides, resolveConfig } from "./config/loader.js";
export { createA2AServer } from "./server/index.js";
export type { ServerHandle } from "./server/index.js";
