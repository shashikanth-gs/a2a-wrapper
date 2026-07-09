/**
 * Agent Configuration — Type Definitions
 *
 * Public wrapper config for an A2A Antigravity agent. Common A2A wrapper
 * concepts stay at the top level; Antigravity SDK/runtime settings live under
 * `antigravity`, with provider auth/routing isolated under
 * `antigravity.provider`.
 */

import type {
  EventsConfig,
  MemoryConfig,
  SubAgentsConfig,
} from "@a2a-wrapper/core";

// ─── Agent Card Config ──────────────────────────────────────────────────────

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

export interface AgentCardConfig {
  name: string;
  description: string;
  protocolVersion?: string;
  version?: string;
  skills?: SkillConfig[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  streaming?: boolean;
  pushNotifications?: boolean;
  /** @deprecated Kept for backward compatibility. Ignored by the agent card builder. */
  stateTransitionHistory?: boolean;
  provider?: { organization: string; url?: string };
}

// ─── Server Config ──────────────────────────────────────────────────────────

export interface ServerConfig {
  port?: number;
  hostname?: string;
  advertiseHost?: string;
  advertiseProtocol?: "http" | "https";
}

// ─── Antigravity Backend Config ─────────────────────────────────────────────

export interface AntigravityProviderConfig {
  /**
   * Model access mode.
   *
   * - "sdkDefault": omit auth/routing fields and let the SDK/env decide.
   * - "apiKey": Gemini Developer API / AI Studio key via apiKey or GEMINI_API_KEY.
   * - "adc": Vertex / Gemini Enterprise Agent Platform using ADC.
   */
  authMode?: "sdkDefault" | "apiKey" | "adc";
  /** Gemini API key. Prefer `${GEMINI_API_KEY}` or env-only SDK defaults. */
  apiKey?: string;
  /** Vertex / Gemini Enterprise Agent Platform project for authMode "adc". */
  project?: string;
  /** Vertex / Gemini Enterprise Agent Platform location for authMode "adc". */
  location?: string;
}

export interface AntigravityCapabilitiesConfig {
  /** Whether Antigravity subagent support is enabled. SDK default is used when omitted. */
  enableSubagents?: boolean;
  /** Built-in tools to expose. Mutually exclusive with disabledTools. */
  enabledTools?: string[];
  /** Built-in tools to hide. Mutually exclusive with enabledTools. */
  disabledTools?: string[];
  /** SDK compaction threshold. Omitted by default. */
  compactionThreshold?: number;
}

export interface AntigravityPolicyRuleConfig {
  decision: "allow" | "deny";
  tool: string;
}

export interface AntigravityPolicyConfig {
  /**
   * SDK policy posture.
   *
   * - "sdkDefault": omit policies and use LocalAgentConfig defaults.
   * - "allowAll": pass policy.allow_all().
   * - "denyAll": pass policy.deny_all().
   * - "custom": pass explicit allow/deny rules.
   */
  mode?: "sdkDefault" | "allowAll" | "denyAll" | "custom";
  rules?: AntigravityPolicyRuleConfig[];
}

export interface AntigravityConfig {
  /**
   * Convenience primary workspace. When set and `workspaces` is omitted, it is
   * passed to the SDK as the single workspace. Supports `${ENV_VAR}`.
   */
  workingDirectory?: string;
  /** Workspace allowlist passed to LocalAgentConfig.workspaces. Supports `${ENV_VAR}`. */
  workspaces?: string[];
  /** Text model name. Omitted by default so the SDK can choose its default. */
  model?: string;
  /** Appended system instructions. Omitted by default. */
  systemInstructions?: string;
  /** Persistent SDK save directory. Omitted by default. Supports `${ENV_VAR}`. */
  saveDir?: string;
  /** SDK app data directory. Must be absolute when set. Supports `${ENV_VAR}`. */
  appDataDir?: string;
  /** Existing SDK conversation id to resume. Omitted by default. */
  conversationId?: string;
  /** JSON schema object or path string for structured output. */
  responseSchema?: Record<string, unknown> | string;
  /** Skill directory paths to pass to Antigravity. Supports `${ENV_VAR}`. */
  skillsPaths?: string[];
  /** Python executable used for the private bridge. Default: python3. */
  pythonPath?: string;
  /** Override path to the private bridge.py. Mostly for tests/dev. */
  bridgePath?: string;
  provider?: AntigravityProviderConfig;
  capabilities?: AntigravityCapabilitiesConfig;
  policies?: AntigravityPolicyConfig;
}

// ─── Session Config ─────────────────────────────────────────────────────────

export interface SessionConfig {
  titlePrefix?: string;
  reuseByContext?: boolean;
  ttl?: number;
  cleanupInterval?: number;
}

// ─── Feature Flags ──────────────────────────────────────────────────────────

export interface FeatureFlags {
  streamArtifactChunks?: boolean;
  emitReasoning?: boolean;
  emitToolEvents?: boolean;
  trackUsage?: boolean;
}

// ─── Timeout Config ─────────────────────────────────────────────────────────

export interface TimeoutConfig {
  prompt?: number;
  bridgeStartup?: number;
}

// ─── Logging Config ─────────────────────────────────────────────────────────

export interface LoggingConfig {
  level?: string;
}

// ─── MCP Server Config ──────────────────────────────────────────────────────

export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  timeoutSeconds?: number;
  enabledTools?: string[];
  disabledTools?: string[];
}

export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeoutSeconds?: number;
  sseReadTimeoutSeconds?: number;
  terminateOnClose?: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | { type: string; [k: string]: unknown };

// ─── Root Config ────────────────────────────────────────────────────────────

export interface AgentConfig {
  agentCard: AgentCardConfig;
  server?: ServerConfig;
  antigravity?: AntigravityConfig;
  session?: SessionConfig;
  features?: FeatureFlags;
  timeouts?: TimeoutConfig;
  logging?: LoggingConfig;
  mcp?: Record<string, McpServerConfig>;
  events?: EventsConfig;
  memory?: MemoryConfig;
  subAgents?: SubAgentsConfig;
  /** Directory containing the loaded config file; set by CLI/loader. */
  configDir?: string;
}
