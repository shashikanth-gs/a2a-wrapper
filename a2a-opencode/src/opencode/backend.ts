/**
 * OpenCode Backend Interface
 *
 * The wrapper talks to OpenCode through this interface so it can support both
 * server API generations:
 *
 *  - {@link ./client.ts}    OpenCode 1.x  (`/session`, `/event`, ...)
 *  - {@link ./client-v2.ts} OpenCode 2.x  (`/api/*`, Basic auth, durable inbox)
 *
 * The *canonical shapes* used here are the OpenCode 1.x shapes the executor was
 * written against (events carry `properties`, messages are `{ info, parts }`,
 * permission rulesets are `{ permission, pattern, action }`). The 2.x driver
 * translates to and from them, so the executor, session manager, permission
 * handler and MCP manager stay independent of the server generation.
 */

import type {
  Session,
  SessionStatus,
  PermissionRuleset,
  PermissionRequest,
  QuestionRequest,
  MessageWithParts,
  PermissionReplyValue,
} from "./types.js";

/** A live event subscription. `stream` yields canonical (1.x-shaped) events. */
export interface EventStreamHandle {
  readonly stream: AsyncGenerator<unknown>;
  abort(): void;
}

/** Error thrown for any non-success OpenCode API response. */
export class OpenCodeApiError extends Error {
  readonly statusCode: number;
  readonly errorData: unknown;
  constructor(message: string, statusCode: number, errorData?: unknown) {
    super(message);
    this.name = "OpenCodeApiError";
    this.statusCode = statusCode;
    this.errorData = errorData;
  }
}

/** Thrown when an OpenCode 2.x server rejects our credentials (or none were supplied). */
export class OpenCodeAuthError extends Error {
  constructor(baseUrl: string, hadPassword: boolean) {
    super(
      hadPassword
        ? `OpenCode server at ${baseUrl} rejected the configured password. ` +
            `Check opencode.password / OPENCODE_SERVER_PASSWORD (and opencode.username if you changed it).`
        : `OpenCode server at ${baseUrl} requires authentication (OpenCode 2.x prints a server password at startup). ` +
            `Set opencode.password or the OPENCODE_SERVER_PASSWORD environment variable.`,
    );
    this.name = "OpenCodeAuthError";
  }
}

export interface SessionCreateOptions {
  title?: string;
  parentID?: string;
  /** Canonical (1.x-shaped) permission ruleset applied to the new session. */
  permission?: PermissionRuleset;
  /**
   * Model and agent for the session. 1.x takes these on every prompt (see
   * `sessionPromptAsync`); 2.x takes them when the session is created.
   */
  model?: { providerID: string; modelID: string };
  agent?: string;
}

export interface PromptBody {
  parts: Array<
    | { type: "text"; text: string; id?: string }
    | { type: "file"; mime: string; url: string; id?: string; filename?: string }
    | { type: "agent"; name: string; id?: string }
    | { type: "subtask"; prompt: string; description: string; agent: string; id?: string }
  >;
  model?: { providerID: string; modelID: string };
  agent?: string;
  system?: string;
}

/** Name → status map returned by MCP status queries. */
export type McpStatusMap = Record<string, { status: string; error?: string }>;

export interface OpenCodeBackend {
  /** Which server API generation this backend speaks. */
  readonly kind: "v1" | "v2";

  // Health
  health(): Promise<{ healthy: true; version: string }>;
  startHealthCheck(): void;
  stopHealthCheck(): void;
  cleanup(): void;

  // Project / agents
  projectCurrent(directory?: string): Promise<unknown>;
  agentList(directory?: string): Promise<unknown>;

  // Sessions
  sessionCreate(directory?: string, opts?: SessionCreateOptions): Promise<Session>;
  sessionGet(sessionID: string, directory?: string): Promise<Session>;
  sessionAbort(sessionID: string, directory?: string): Promise<boolean>;
  /** True when the session is not currently executing a prompt. */
  sessionIdle(sessionID: string, directory?: string): Promise<boolean>;

  // Messaging
  sessionMessages(sessionID: string, directory?: string, limit?: number): Promise<MessageWithParts[]>;
  sessionPromptAsync(sessionID: string, body: PromptBody, directory?: string): Promise<void>;

  // Permissions & questions
  permissionList(directory?: string): Promise<PermissionRequest[]>;
  permissionReply(requestID: string, reply: PermissionReplyValue, directory?: string, message?: string): Promise<void>;
  questionList(directory?: string): Promise<QuestionRequest[]>;
  questionReply(requestID: string, answers: string[][], directory?: string): Promise<void>;
  questionReject(requestID: string, directory?: string): Promise<void>;

  // Events
  subscribeEvents(directory?: string): Promise<EventStreamHandle>;

  // MCP
  mcpStatus(directory?: string): Promise<McpStatusMap | unknown>;
  mcpAdd(name: string, config: Record<string, unknown>, directory?: string): Promise<unknown>;
  mcpConnect(name: string, directory?: string): Promise<unknown>;
  mcpDisconnect(name: string, directory?: string): Promise<unknown>;
}

export type { SessionStatus };
