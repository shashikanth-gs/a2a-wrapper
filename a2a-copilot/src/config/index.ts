/**
 * Config Module — Public API barrel
 *
 * Re-exports the config loader pipeline, DEFAULTS, and all TypeScript types
 * from a single import path for consumers and external integrators.
 */

export { resolveConfig, loadConfigFile, loadEnvOverrides } from "./loader.js";
export { DEFAULTS } from "./defaults.js";
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
} from "./types.js";
