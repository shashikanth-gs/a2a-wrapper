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

/**
 * Does this error say the server has no such session? 1.x answers 404 (`NotFoundError`), 2.x a tagged `SessionNotFoundError`
 * (the 2.x client maps it to a 404 {@link OpenCodeApiError}).
 */
export function isSessionNotFound(error: unknown): boolean {
  if (error instanceof OpenCodeApiError) {
    if (error.statusCode === 404) return true;
    const data = error.errorData as { name?: string; _tag?: string } | undefined;
    return data?._tag === "SessionNotFoundError" || data?.name === "NotFoundError";
  }
  const e = error as { name?: string; statusCode?: number; errorData?: { name?: string; _tag?: string } } | undefined;
  return e?.statusCode === 404 || e?.errorData?._tag === "SessionNotFoundError" || e?.errorData?.name === "NotFoundError";
}

/** How an OpenCode 2.x server takes a prompt: `steer` at the next step boundary, `queue` after the work in hand. */
export type PromptDelivery = "steer" | "queue";

/** What a 2.x server answers a prompt with: the durable inbox item it was admitted as. */
export interface PromptResult {
  /** The id of the inbox item (the handle of a steered message). */
  inboxId?: string;
  delivery?: PromptDelivery;
}

/** One undelivered item of a 2.x session inbox. */
export interface InboxEntry {
  id: string;
  delivery?: string;
  text?: string;
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
  /** 2.x only: how the server delivers the prompt when the session is busy (default: the server's, `steer`). */
  delivery?: PromptDelivery;
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
  /** Stop the session's running work. 1.x: `POST /session/:id/abort`. 2.x: `POST /api/session/:id/interrupt?resume=false` (parked inbox items stay parked). */
  sessionAbort(sessionID: string, directory?: string): Promise<boolean>;
  /** True when the session is not currently executing a prompt. */
  sessionIdle(sessionID: string, directory?: string): Promise<boolean>;

  // Messaging
  sessionMessages(sessionID: string, directory?: string, limit?: number): Promise<MessageWithParts[]>;
  /** Send a prompt. 2.x answers with the inbox item the prompt was admitted as; 1.x answers nothing. */
  sessionPromptAsync(sessionID: string, body: PromptBody, directory?: string): Promise<PromptResult | void>;

  // Durable inbox (2.x only: absent on 1.x, which has no native steering)
  inboxList?(sessionID: string, directory?: string): Promise<InboxEntry[]>;
  inboxCancel?(sessionID: string, inboxID: string, directory?: string): Promise<void>;

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
