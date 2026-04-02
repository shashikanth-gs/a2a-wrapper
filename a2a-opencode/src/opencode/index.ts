/**
 * OpenCode Module — Public API barrel
 *
 * Re-exports core OpenCode integration classes and event-publisher helpers
 * for programmatic use without importing subdirectory modules directly.
 */

export { OpenCodeClientWrapper, OpenCodeApiError } from "./client.js";
export type { ClientConfig, EventStreamHandle } from "./client.js";

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
} from "./event-publisher.js";

export type * from "./types.js";
