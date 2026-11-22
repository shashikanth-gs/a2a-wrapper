/**
 * A scripted OpenCode server for tests: implements `OpenCodeBackend` (either generation) and plays back the canonical
 * (1.x-shaped) events a script emits after each prompt. Both the real 1.x client and the 2.x client produce these events,
 * so one script serves both. No network, no OpenCode.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** What a script can do once its prompt arrived. */
export interface ScriptCtx {
  /** The session the prompt went to. */
  sessionId: string;
  /** Emit one canonical event. */
  emit(event: unknown): void;
  /** The prompt body that triggered this script. */
  body: Json;
  /** Resolves after `ms`. */
  sleep(ms: number): Promise<void>;
  /** The fake itself, to read state or change it mid-script. */
  backend: FakeBackend;
}

export type Script = (ctx: ScriptCtx) => void | Promise<void>;

export interface FakeBackendOptions {
  kind?: "v1" | "v2";
  /** One script per prompt, in order (the last one repeats). */
  scripts?: Script[];
  /** Sessions that exist before the first prompt (id to title). */
  existingSessions?: string[];
  /** What `sessionMessages` returns. */
  messages?: (sessionId: string) => Json[];
  /** Make `sessionPromptAsync` fail. */
  failPrompt?: Error;
  /** Delay (ms) before the script of a prompt starts. Default 5. */
  scriptDelayMs?: number;
}

/** A pending permission or question the fake holds until it is replied to. */
export interface FakeReply {
  kind: "permission" | "question";
  id: string;
  reply?: string;
  message?: string;
  answers?: string[][];
  rejected?: boolean;
}

export class FakeBackend {
  readonly kind: "v1" | "v2";
  readonly sessions = new Map<string, { id: string; title?: string; opts?: Json }>();
  /** Every call, in order, as `name:arg`. */
  readonly calls: string[] = [];
  readonly prompts: Array<{ sessionId: string; body: Json; inboxId?: string; delivery?: string }> = [];
  readonly replies: FakeReply[] = [];
  /** Pending permissions / questions the fake reports from `permissionList` / `questionList`. */
  pendingPermissions: Json[] = [];
  pendingQuestions: Json[] = [];
  /** Items in the (v2) inbox, by id. */
  readonly inbox = new Map<string, { id: string; sessionId: string; text: string; delivery: string }>();
  /** Sessions that are executing a prompt now (what `sessionIdle` reads). */
  readonly busy = new Set<string>();
  /** Set by tests: what `sessionAbort` / `sessionInterrupt` does besides recording. */
  onAbort?: (sessionId: string, opts: { resume?: boolean }) => void | Promise<void>;
  /** Make `sessionAbort` report failure (throw). */
  abortError?: Error;
  /** `sessionIdle` stays false after an abort for this many ms (to exercise the unconfirmed outcome). */
  idleAfterAbortDelayMs = 0;
  private abortedAt = new Map<string, number>();

  private readonly scripts: Script[];
  private scriptIndex = 0;
  private readonly opts: FakeBackendOptions;
  private sessionSeq = 0;
  private inboxSeq = 0;
  private queue: unknown[] = [];
  private wake: (() => void) | undefined;
  private streamClosed = false;
  /** Number of event subscriptions opened. */
  subscriptions = 0;

  constructor(opts: FakeBackendOptions = {}) {
    this.opts = opts;
    this.kind = opts.kind ?? "v1";
    this.scripts = opts.scripts ?? [];
    for (const id of opts.existingSessions ?? []) this.sessions.set(id, { id });
  }

  // ── Test controls ───────────────────────────────────────────────────────

  /** Emit an event now, as if the server had. */
  emit(event: unknown): void {
    this.queue.push(event);
    this.wake?.();
  }

  setScripts(scripts: Script[]): void {
    this.scripts.splice(0, this.scripts.length, ...scripts);
    this.scriptIndex = 0;
  }

  // ── OpenCodeBackend ─────────────────────────────────────────────────────

  async health() { return { healthy: true as const, version: "test" }; }
  startHealthCheck() {}
  stopHealthCheck() {}
  cleanup() {}
  async projectCurrent() { return { id: "p" }; }
  async agentList() { return []; }

  async sessionCreate(directory?: string, opts?: Json) {
    this.calls.push(`sessionCreate`);
    const id = `ses_${++this.sessionSeq}`;
    this.sessions.set(id, { id, title: opts?.title, opts: { ...opts, directory } });
    return { id, title: opts?.title ?? "t" } as never;
  }

  async sessionGet(sessionID: string) {
    this.calls.push(`sessionGet:${sessionID}`);
    if (!this.sessions.has(sessionID)) throw notFound(sessionID);
    return { id: sessionID } as never;
  }

  async sessionAbort(sessionID: string) {
    this.calls.push(`sessionAbort:${sessionID}`);
    if (this.abortError) throw this.abortError;
    this.abortedAt.set(sessionID, Date.now());
    await this.onAbort?.(sessionID, {});
    return true;
  }

  async sessionInterrupt(sessionID: string, opts: { resume?: boolean } = {}) {
    this.calls.push(`sessionInterrupt:${sessionID}:${opts.resume ? "resume" : "noresume"}`);
    if (this.abortError) throw this.abortError;
    this.abortedAt.set(sessionID, Date.now());
    await this.onAbort?.(sessionID, opts);
    return true;
  }

  async sessionIdle(sessionID: string) {
    const at = this.abortedAt.get(sessionID);
    if (at !== undefined && Date.now() - at < this.idleAfterAbortDelayMs) return false;
    return !this.busy.has(sessionID);
  }

  async sessionMessages(sessionID: string) {
    return (this.opts.messages?.(sessionID) ?? []) as never;
  }

  async sessionPromptAsync(sessionID: string, body: Json, _directory?: string) {
    this.calls.push(`prompt:${sessionID}`);
    if (this.opts.failPrompt) throw this.opts.failPrompt;
    const record: { sessionId: string; body: Json; inboxId?: string; delivery?: string } = { sessionId: sessionID, body };
    this.prompts.push(record);
    const script = this.scripts[Math.min(this.scriptIndex, this.scripts.length - 1)];
    this.scriptIndex++;
    if (script) {
      setTimeout(() => {
        void script({
          sessionId: sessionID,
          emit: (e) => this.emit(e),
          body,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          backend: this,
        });
      }, this.opts.scriptDelayMs ?? 5);
    }
    if (this.kind === "v2") {
      const id = `msg_in${++this.inboxSeq}`;
      record.inboxId = id;
      record.delivery = body.delivery ?? "steer";
      return { inboxId: id, delivery: record.delivery };
    }
    return undefined;
  }

  async inboxList(sessionID: string) {
    this.calls.push(`inboxList:${sessionID}`);
    return [...this.inbox.values()].filter((i) => i.sessionId === sessionID);
  }

  async inboxCancel(sessionID: string, inboxID: string) {
    this.calls.push(`inboxCancel:${inboxID}`);
    this.inbox.delete(inboxID);
    this.emit({ type: "session.inbox.cancelled", properties: { sessionID, inboxID } });
  }

  async permissionList() { return this.pendingPermissions as never; }
  async permissionReply(requestID: string, reply: string, _directory?: string, message?: string) {
    this.calls.push(`permissionReply:${requestID}:${reply}`);
    this.replies.push({ kind: "permission", id: requestID, reply, ...(message ? { message } : {}) });
    this.pendingPermissions = this.pendingPermissions.filter((p) => p.id !== requestID);
  }
  async questionList() { return this.pendingQuestions as never; }
  async questionReply(requestID: string, answers: string[][]) {
    this.calls.push(`questionReply:${requestID}`);
    this.replies.push({ kind: "question", id: requestID, answers });
    this.pendingQuestions = this.pendingQuestions.filter((q) => q.id !== requestID);
  }
  async questionReject(requestID: string) {
    this.calls.push(`questionReject:${requestID}`);
    this.replies.push({ kind: "question", id: requestID, rejected: true });
    this.pendingQuestions = this.pendingQuestions.filter((q) => q.id !== requestID);
  }

  async mcpStatus() { return {}; }
  async mcpAdd() { return undefined; }
  async mcpConnect() { return undefined; }
  async mcpDisconnect() { return undefined; }

  async subscribeEvents() {
    this.subscriptions++;
    this.streamClosed = false;
    const self = this;
    return {
      abort: () => { self.streamClosed = true; self.wake?.(); },
      stream: (async function* () {
        while (!self.streamClosed) {
          if (self.queue.length === 0) await new Promise<void>((r) => { self.wake = r; });
          while (self.queue.length) yield self.queue.shift();
        }
      })(),
    };
  }
}

function notFound(id: string): Error {
  const e = new Error(`session.get: HTTP 404 (${id})`) as Error & { statusCode: number; errorData: unknown; name: string };
  e.name = "OpenCodeApiError";
  e.statusCode = 404;
  e.errorData = { name: "NotFoundError" };
  return e;
}

// ─── Canonical event builders ───────────────────────────────────────────────

/** An assistant message as 1.x reports it (and as the 2.x client translates a finished step). */
export function assistant(id: string, over: Record<string, unknown> = {}, sessionId = "ses_1") {
  return {
    type: "message.updated",
    properties: {
      sessionID: sessionId,
      info: {
        id, sessionID: sessionId, role: "assistant", modelID: "big-pickle", providerID: "opencode", cost: 0,
        tokens: { input: 100, output: 10, reasoning: 2, cache: { read: 40, write: 0 } },
        time: { created: 1_000, completed: 1_500 },
        ...over,
      },
    },
  };
}

export const userMessage = (id: string, sessionId = "ses_1") => ({
  type: "message.updated",
  properties: { sessionID: sessionId, info: { id, sessionID: sessionId, role: "user", time: { created: 1 } } },
});

export const text = (delta: string, sessionId = "ses_1", messageID?: string) => ({
  type: "message.part.updated",
  properties: { sessionID: sessionId, delta, part: { type: "text", text: delta, ...(messageID ? { messageID } : {}) } },
});

export const toolRunning = (callID: string, tool: string, input: unknown = {}, sessionId = "ses_1") => ({
  type: "message.part.updated",
  properties: { sessionID: sessionId, part: { type: "tool", tool, callID, state: { status: "running", input, time: { start: 100 } } } },
});

export const toolCompleted = (callID: string, tool: string, output: unknown, sessionId = "ses_1") => ({
  type: "message.part.updated",
  properties: { sessionID: sessionId, part: { type: "tool", tool, callID, state: { status: "completed", output, time: { start: 100, end: 140 } } } },
});

export const toolError = (callID: string, tool: string, error: string, sessionId = "ses_1") => ({
  type: "message.part.updated",
  properties: { sessionID: sessionId, part: { type: "tool", tool, callID, state: { status: "error", error } } },
});

export const idle = (sessionId = "ses_1") => ({ type: "session.idle", properties: { sessionID: sessionId } });

export const sessionError = (error: unknown, sessionId = "ses_1") => ({ type: "session.error", properties: { sessionID: sessionId, error } });
