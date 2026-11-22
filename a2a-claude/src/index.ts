/**
 * a2a-claude — Public API
 */

export { ClaudeProvider } from "./claude/provider.js";
export type { ClaudeProviderOptions } from "./claude/provider.js";
export { EventMapper, sanitizeMessage } from "./claude/event-mapper.js";
export { CLAUDE_BACKEND_PATHS } from "./claude/backend-paths.js";
export { CLAUDE_CAPABILITIES } from "./claude/capabilities.js";
export { createClaudeClient, buildQueryOptions } from "./claude/client-factory.js";
export type {
  ClaudeClientLike,
  QueryLike,
  QueryOptionsLike,
  SDKMessageLike,
} from "./claude/client-factory.js";
export type {
  AgentConfig,
  ClaudeConfig,
  ClaudePermissionMode,
  FeatureFlags,
  InteractionsConfig,
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpServerConfig,
} from "./config/types.js";
export { DEFAULTS } from "./config/defaults.js";
export { resolveConfig, loadConfigFile, loadEnvOverrides } from "./config/loader.js";
export { createA2AServer, interactionPolicyOf, registryOptionsOf, buildAgentCard } from "./server/index.js";
export type { ServerHandle, ClaudeServerOptions } from "./server/index.js";
