/**
 * a2a-codex — Public API
 *
 * Re-exports the provider, config types, and backend constants for
 * programmatic use without importing subdirectory modules directly.
 */

export { CodexProvider, SESSION_FORMAT } from "./codex/provider.js";
export type { CodexProviderOptions } from "./codex/provider.js";
export { EventMapper } from "./codex/event-mapper.js";
export { CODEX_BACKEND_PATHS } from "./codex/backend-paths.js";
export { CODEX_CAPABILITIES } from "./codex/capabilities.js";
export { createCodexClient } from "./codex/client-factory.js";
export type {
  CodexClientLike,
  CodexThreadLike,
  ThreadEventLike,
  ThreadItemLike,
} from "./codex/client-factory.js";
export type {
  AgentConfig,
  CodexConfig,
  FeatureFlags,
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpServerConfig,
} from "./config/types.js";
export { DEFAULTS } from "./config/defaults.js";
export { resolveConfig, loadConfigFile, loadEnvOverrides } from "./config/loader.js";
export { createA2AServer, registryOptionsOf, buildAgentCard } from "./server/index.js";
export type { ServerHandle, CodexServerOptions } from "./server/index.js";
