/**
 * @a2a-wrapper/core — Public API
 *
 * Barrel export for the shared A2A wrapper infrastructure package. Every
 * symbol re-exported here is part of the public API surface and is covered
 * by semantic versioning guarantees.
 *
 * Wrapper projects should import exclusively from `@a2a-wrapper/core`
 * rather than reaching into internal module paths. This allows the core
 * package to reorganise internals without breaking downstream consumers.
 *
 * A2A SDK types that wrapper projects commonly reference are re-exported
 * here behind core-owned names. This isolates downstream code from SDK
 * major-version upgrades — only this barrel file needs updating when the
 * SDK ships breaking type changes.
 *
 * @module @a2a-wrapper/core
 * @packageDocumentation
 */

// ─── Utilities ──────────────────────────────────────────────────────────────

export { LogLevel, Logger, createLogger } from "./utils/logger.js";
export { type Deferred, createDeferred, sleep } from "./utils/deferred.js";
export { deepMerge, substituteEnvTokens } from "./utils/deep-merge.js";

// ─── Configuration ──────────────────────────────────────────────────────────

export type {
  SkillConfig,
  AgentCardConfig,
  ServerConfig,
  SessionConfig,
  BaseFeatureFlags,
  TimeoutConfig,
  LoggingConfig,
  BaseMcpServerConfig,
  BaseAgentConfig,
} from "./config/types.js";

export { loadConfigFile, resolveConfig } from "./config/loader.js";

// ─── Events ─────────────────────────────────────────────────────────────────

export {
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
  publishTraceArtifact,
  publishThoughtArtifact,
} from "./events/event-publisher.js";

// ─── Server ─────────────────────────────────────────────────────────────────

export { buildAgentCard, type BuildAgentCardInput } from "./server/agent-card.js";

export {
  createA2AServer,
  type ServerOptions,
  type ServerHandle,
} from "./server/factory.js";

// ─── Session ────────────────────────────────────────────────────────────────

export { BaseSessionManager, type SessionEntry } from "./session/base-session-manager.js";

// ─── Executor ───────────────────────────────────────────────────────────────

export type { A2AExecutor } from "./executor/types.js";

// ─── CLI ────────────────────────────────────────────────────────────────────

export {
  createCli,
  type CliOptions,
  parseCommonArgs,
  type CommonArgsResult,
} from "./cli/scaffold.js";

// ─── A2A SDK Type Re-exports ────────────────────────────────────────────────
//
// Core-owned aliases for commonly used A2A SDK types. Wrapper projects
// import these from `@a2a-wrapper/core` instead of directly from the SDK,
// so that a major SDK upgrade only requires changes in this file.
// ────────────────────────────────────────────────────────────────────────────

/** @see {@link https://github.com/a2a-js/a2a-js | @a2a-js/sdk} */
export type { AgentCard } from "@a2a-js/sdk";

/** @see {@link https://github.com/a2a-js/a2a-js | @a2a-js/sdk} */
export type { TaskState, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from "@a2a-js/sdk";

/** @see {@link https://github.com/a2a-js/a2a-js | @a2a-js/sdk/server} */
export type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
