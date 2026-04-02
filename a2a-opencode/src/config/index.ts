/**
 * Config Module — Public API barrel
 *
 * Re-exports the config loader pipeline, DEFAULTS, and all TypeScript types
 * from a single import path for consumers and external integrators.
 */
export type {
  AgentConfig,
  AgentCardConfig,
  SkillConfig,
  ServerConfig,
  OpenCodeConfig,
  SessionConfig,
  FeatureFlags,
  TimeoutConfig,
  LoggingConfig,
} from "./types.js";

export { DEFAULTS } from "./defaults.js";
export { resolveConfig, loadConfigFile, loadEnvOverrides } from "./loader.js";
