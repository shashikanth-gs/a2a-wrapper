/**
 * The Copilot SDK surface this wrapper uses, as narrow structural types.
 *
 * `@github/copilot-sdk` does not publish usable types for the session object, and the provider is tested against
 * fakes, so the provider depends on these interfaces and the real client satisfies them structurally.
 */

/** One Copilot SDK session event: `{ type, data }`. The handlers receive it untyped on purpose. */
export type CopilotEvent = { type?: string; data?: Record<string, unknown> } | undefined;

export interface CopilotSendParams {
  prompt: string;
  /** `"immediate"` folds the message into the turn in flight; `"enqueue"` (default) runs it after. */
  mode?: "enqueue" | "immediate";
  /** Echoed as `clientTurnId` on the `user.message` event that reports how the message was delivered. */
  clientTurnId?: string;
}

export interface CopilotSession {
  /** Unique identifier for this session, assigned by the Copilot SDK. */
  readonly sessionId: string;
  /** Subscribe to a session event; returns the unsubscribe function. */
  on(event: string, handler: (event: unknown) => void): () => void;
  /** Fire-and-forget send: resolves once the message is accepted; results arrive as events. */
  send(params: CopilotSendParams): Promise<unknown>;
  /** Blocking send: resolves with the complete assistant response (`{ data: { content } }`). */
  sendAndWait(params: { prompt: string }, timeoutMs?: number): Promise<{ data?: { content?: string } } | undefined>;
  /** Abort the message currently being processed. The session stays valid. */
  abort(): Promise<void>;
  /** Release SDK-side resources. Session data on disk is preserved for `resumeSession`. */
  disconnect(): Promise<void>;
  /** Experimental RPC surface; used to clear the native message queue on cancel when present. */
  rpc?: { queue?: { clear?: () => Promise<unknown> } };
}

export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  createSession(options: Record<string, unknown>): Promise<CopilotSession>;
  resumeSession(sessionId: string, options: Record<string, unknown>): Promise<CopilotSession>;
  /** `undefined` when the runtime has no such session. */
  getSessionMetadata?(sessionId: string): Promise<unknown | undefined>;
}
