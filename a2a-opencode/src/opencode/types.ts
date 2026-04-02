/**
 * OpenCode Types
 *
 * Re-exports from @opencode-ai/sdk/v2. Import from here so SDK
 * upgrades are isolated to this single file.
 */

// ─── Core Data Models ───────────────────────────────────────────────────────
export type {
  Session,
  SessionStatus,
  UserMessage,
  AssistantMessage,
  Message,
  FileDiff,
  Todo,
} from "@opencode-ai/sdk/v2";

// ─── Parts ──────────────────────────────────────────────────────────────────
export type {
  TextPart,
  ToolPart,
  ToolState,
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  ReasoningPart,
  StepStartPart,
  StepFinishPart,
  FilePart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
  Part,
} from "@opencode-ai/sdk/v2";

// ─── Input Part Types ───────────────────────────────────────────────────────
export type {
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
} from "@opencode-ai/sdk/v2";

// ─── Error Types ────────────────────────────────────────────────────────────
export type {
  ProviderAuthError,
  UnknownError,
  MessageOutputLengthError,
  MessageAbortedError,
  ApiError,
  BadRequestError,
  NotFoundError,
} from "@opencode-ai/sdk/v2";

// ─── Event Types ────────────────────────────────────────────────────────────
export type {
  Event as OpenCodeEvent,
  EventMessageUpdated,
  EventMessageRemoved,
  EventMessagePartUpdated,
  EventMessagePartRemoved,
  EventPermissionAsked,
  EventPermissionReplied,
  EventSessionStatus,
  EventSessionIdle,
  EventSessionCreated,
  EventSessionUpdated,
  EventSessionError,
  EventSessionCompacted,
  EventTodoUpdated,
  EventServerConnected,
  EventCommandExecuted,
  EventFileEdited,
  EventQuestionAsked,
  EventQuestionReplied,
  EventQuestionRejected,
} from "@opencode-ai/sdk/v2";

// ─── Permission & Question Models ───────────────────────────────────────────
export type {
  PermissionRequest,
  PermissionRule,
  PermissionRuleset,
  PermissionAction,
  QuestionRequest,
  QuestionInfo,
  QuestionOption,
  QuestionAnswer,
} from "@opencode-ai/sdk/v2";

// ─── Project / Agent / Provider ─────────────────────────────────────────────
export type {
  Project,
  Agent,
  Provider,
  Model,
} from "@opencode-ai/sdk/v2";

// ─── MCP ────────────────────────────────────────────────────────────────────
export type {
  McpStatus,
  McpStatusConnected,
  McpStatusDisabled,
  McpStatusFailed,
  McpStatusNeedsAuth,
  McpStatusNeedsClientRegistration,
} from "@opencode-ai/sdk/v2";

// ─── SDK Client ─────────────────────────────────────────────────────────────
export {
  type OpencodeClientConfig,
  OpencodeClient,
  createOpencodeClient,
} from "@opencode-ai/sdk/v2";

// ─── Wrapper-Specific Types ─────────────────────────────────────────────────

/** Permission reply values accepted by the OpenCode API. */
export type PermissionReplyValue = "once" | "always" | "reject";

/** Message with its parts, as returned by GET /session/{id}/message. */
export interface MessageWithParts {
  info: import("@opencode-ai/sdk/v2").Message;
  parts: import("@opencode-ai/sdk/v2").Part[];
}

/** Path information returned by GET /path. */
export interface PathInfo {
  home: string;
  state: string;
  config: string;
  worktree: string;
  directory: string;
}
