/**
 * OpenCode Module — Public API barrel
 *
 * Re-exports core OpenCode integration classes and event-publisher helpers
 * for programmatic use without importing subdirectory modules directly.
 */

export { OpenCodeClientWrapper, OpenCodeVersionError } from "./client.js";
export type { ClientConfig } from "./client.js";
export { OpenCodeClientV2 } from "./client-v2.js";
export type { ClientV2Config } from "./client-v2.js";
export { OpenCodeApiError, OpenCodeAuthError } from "./backend.js";
export type {
  OpenCodeBackend,
  EventStreamHandle,
  SessionCreateOptions,
  PromptBody,
  McpStatusMap,
} from "./backend.js";
export { createBackend, detectServerVersion } from "./backend-factory.js";
export type { BackendOptions, DetectedVersion } from "./backend-factory.js";

export { EventStreamManager } from "./event-stream.js";
export type { ReconnectConfig, EventStreamOptions } from "./event-stream.js";

export { PermissionHandler } from "./permission-handler.js";
export type { PermissionHandlerConfig } from "./permission-handler.js";

export { SessionManager } from "./session-manager.js";

export { OpenCodeExecutor } from "./executor.js";

export { registerMcpServers, getMcpStatus } from "./mcp-manager.js";
export type { McpRegistrationResult, McpManagerOptions } from "./mcp-manager.js";

export {
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
} from "@a2a-wrapper/core";

export type * from "./types.js";
