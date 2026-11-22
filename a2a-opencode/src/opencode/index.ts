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
export { OpenCodeApiError, OpenCodeAuthError, isSessionNotFound } from "./backend.js";
export type {
  OpenCodeBackend,
  EventStreamHandle,
  InboxEntry,
  SessionCreateOptions,
  PromptBody,
  PromptDelivery,
  PromptResult,
  McpStatusMap,
} from "./backend.js";
export { createBackend, detectServerVersion } from "./backend-factory.js";
export type { BackendOptions, DetectedVersion } from "./backend-factory.js";

export { EventStreamManager } from "./event-stream.js";
export type { ReconnectConfig, EventStreamOptions } from "./event-stream.js";

export { OpenCodeProvider, SESSION_FORMAT, toOpencodeMcpEntry } from "./provider.js";
export type { OpenCodeProviderOptions } from "./provider.js";
export { OpenCodeTurn } from "./turn.js";
export { usageRecordFromMessage } from "./usage.js";
export { AUTO_ALLOW_PERMISSIONS, ASK_PERMISSIONS, sessionPermissions } from "./sessions.js";

export { registerMcpServers, getMcpStatus } from "./mcp-manager.js";
export type { McpRegistrationResult, McpManagerOptions } from "./mcp-manager.js";

export type * from "./types.js";
