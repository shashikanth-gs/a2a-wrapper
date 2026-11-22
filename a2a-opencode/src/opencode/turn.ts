/**
 * One turn of an OpenCode session: the OpenCode-specific half of `provider.run`.
 *
 * Subscribes to the server's event stream, sends the prompt, maps what the server says (text, tool calls, usage, permission
 * requests, questions) to what core publishes (status text, trace artifacts, the response artifact, usage, interactions) and
 * ends the turn with `complete` / `fail`. Everything A2A (the bus, the task state, the cancel ordering, the queue) is core's.
 *
 * ### Steering (OpenCode 2.x only)
 *
 * A 2.x server admits every prompt into a durable per-session inbox and delivers it at a step boundary (`steer`) or when the work
 * in hand is done (`queue`). `steer` sends the message with `delivery: "steer"` and waits `timeouts.steerAck` for the server's
 * `session.inbox.delivered` event for its inbox item:
 *
 * - delivered in time (the server folded it into the running turn): `inserted`.
 * - not yet: `queued` with the inbox id as the handle. When `inbox.delivered` arrives while the execution is still running, the
 *   message was folded into it (`settleSteer(handle, "inserted")`). When the execution ended first and the server starts the
 *   message as its own execution, the turn splits there like a held turn (`beginHeldTurn`). A message that is never delivered is
 *   cancelled in the inbox and handed back to core (`settleSteer(handle, "requeue")`).
 *
 * `interrupt` keeps parked inbox items (they run in the next turn's execution, which is where `inbox.delivered` then settles them);
 * `cancel` cancels them and drops the handles.
 */

import {
  corePartsText,
  RunObservability,
  annotateSessionOnTaskSpan,
  createResponseStream,
  type AbortOutcome,
  type AbortReason,
  type AskOptions,
  type CoreInteractionRequest,
  type CoreInteractionResult,
  type CoreMessage,
  type CoreRequest,
  type CoreTaskRun,
  type EventTransport,
  type EventTransportFn,
  type ResponseStream,
  type SteerOutcome,
} from "@a2a-wrapper/core";
import { v4 as uuidv4 } from "uuid";
import type { AgentConfig } from "../config/types.js";
import { createDeferred, sleep } from "../utils/deferred.js";
import { logger } from "../utils/logger.js";
import { OpenCodeAuthError, type OpenCodeBackend, type PromptBody } from "./backend.js";
import { EventStreamManager } from "./event-stream.js";
import {
  legacyPermissionReply,
  legacyQuestionAnswers,
  nobodyWasAsked,
  permissionInteraction,
  permissionReply,
  questionAnswers,
  questionInteraction,
} from "./interactions.js";
import { sanitize, truncate } from "./trace-data.js";
import type { MessageWithParts, OpenCodeEvent, Part as OpenCodePart, PermissionRequest, QuestionRequest } from "./types.js";
import { usageRecordFromMessage } from "./usage.js";

const log = logger.child("turn");

/** How long `steer` waits for the server to say it delivered the message. */
export const DEFAULT_STEER_ACK_MS = 5_000;
/** How long `abort` waits for the session to go idle after asking the server to stop it. */
export const ABORT_IDLE_WAIT_MS = 3_000;

/** The text of the failure as the caller sees it (the same wording the wrapper has always used). */
export function describeFailure(error: unknown, baseUrl: string | undefined): { message: string; code: "auth" | "unavailable" | "backend" } {
  const msg = (error as Error)?.message ?? String(error);
  const isConnErr = msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("HTTP 0") || msg.includes("fetch failed") || msg.includes("connect");
  if (isConnErr) {
    return { message: `Cannot reach OpenCode server at ${baseUrl}. Is OpenCode running? Start it with: opencode serve`, code: "unavailable" };
  }
  return { message: `Error: ${msg}`, code: error instanceof OpenCodeAuthError ? "auth" : "backend" };
}

/** The text of the last assistant message of a transcript. */
export function extractResponseText(msgs: ReadonlyArray<{ info: unknown; parts: OpenCodePart[] }>): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const info = msgs[i]!.info as Record<string, unknown>;
    if (info?.role === "assistant") {
      return msgs[i]!.parts
        .filter((p) => p.type === "text")
        .map((p) => ((p as Record<string, unknown>).text as string) ?? "")
        .join("\n")
        .trim();
    }
  }
  return "";
}

/** What a turn needs from the provider. */
export interface TurnOptions {
  config: Required<AgentConfig>;
  backend: OpenCodeBackend;
  request: CoreRequest;
  run: CoreTaskRun;
  sessionId: string;
  prompt: PromptBody;
  customTransport?: EventTransport | EventTransportFn;
  /** The runtime asks the A2A client (`ask`), or nobody is asked and the wrapper's own auto-reply applies (`auto`). */
  interactions: "auto" | "ask";
  steerAckMs?: number;
  /** Was the session resumed rather than created for this turn? */
  reused: boolean;
}

/** One output segment: the turn itself, then one per held message that starts its own execution. */
interface Segment {
  view: CoreTaskRun;
  obs: RunObservability;
  response: ResponseStream;
  text: string;
  timedOut: boolean;
}

export class OpenCodeTurn {
  private readonly cfg: Required<AgentConfig>;
  private readonly backend: OpenCodeBackend;
  private readonly request: CoreRequest;
  private readonly sessionId: string;
  private readonly directory: string | undefined;
  private seg: Segment;
  private stream: EventStreamManager | null = null;
  /** Settles the streaming wait: idle, a timeout or an error. Re-armed when a held turn starts. */
  private done = createDeferred<void>();
  /** Settles when any segment's signal aborts (cancel or interrupt). */
  private readonly stopped = createDeferred<void>();
  private stopReason: AbortReason | undefined;
  private ended = false;
  private promptSent = false;
  /** The server said the execution ended (`session.idle`): no message can be folded into it any more. */
  private idleSeen = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingFinishes: Promise<void>[] = [];
  private readonly messageRoles = new Map<string, string>();
  private readonly countedMessages = new Set<string>();
  private readonly pendingToolCalls = new Map<string, { callId: string; args: unknown; startTime: number }>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly steerAckMs: number;
  private promptInboxId: string | undefined;
  /** An idle that says the execution was interrupted counts only after our own prompt was delivered (a late one is the previous turn's). */
  private ownSeen = false;
  // ── steering ──
  /** Inbox ids the server delivered. */
  private readonly delivered = new Set<string>();
  private readonly deliveryWaiters = new Map<string, () => void>();
  /** Handles answered `queued` and not yet settled. */
  private readonly held = new Map<string, { message: CoreMessage }>();
  private heldDelivered: ((handle: string) => void) | undefined;
  // ── interactions ──
  private readonly handledAsks = new Set<string>();
  private readonly pendingAsks = new Map<string, AbortController>();
  private pausedAsks = 0;

  constructor(private readonly opts: TurnOptions) {
    this.cfg = opts.config;
    this.backend = opts.backend;
    this.request = opts.request;
    this.sessionId = opts.sessionId;
    this.directory = opts.config.opencode.projectDirectory || undefined;
    this.steerAckMs = opts.steerAckMs ?? DEFAULT_STEER_ACK_MS;
    this.seg = this.newSegment(opts.run);
    // `done` may be rejected after the wait ended (a stop won the race): that must not be an unhandled rejection.
    this.done.promise.catch(() => {});
  }

  /** The view of the segment that is producing output now. */
  get view(): CoreTaskRun {
    return this.seg.view;
  }

  private newSegment(view: CoreTaskRun): Segment {
    const obs = new RunObservability({
      agentName: this.cfg.agentCard.name,
      backend: "opencode",
      request: this.request,
      run: view,
      events: this.cfg.events,
      ...(this.opts.customTransport ? { customTransport: this.opts.customTransport } : {}),
      warn: (m, d) => log.warn(m, d as Record<string, unknown> | undefined),
    });
    const seg: Segment = {
      view,
      obs,
      response: createResponseStream(view, { chunks: this.cfg.features.streamArtifactChunks === true }),
      text: "",
      timedOut: false,
    };
    // A cancel or an interrupt aborts the signal of whichever segment is live.
    const onAbort = (): void => {
      this.stopReason = (view.signal.reason ?? "cancel") as AbortReason;
      this.stopped.resolve();
    };
    if (view.signal.aborted) onAbort();
    else view.signal.addEventListener("abort", onAbort, { once: true });
    return seg;
  }

  // ─── Running the turn ─────────────────────────────────────────────────────

  /** Run the turn to its end. Never throws: a failure ends the turn with `fail`. */
  async run(): Promise<void> {
    const { run } = this.opts;
    annotateSessionOnTaskSpan({ reused: this.opts.reused, sessionId: this.sessionId });
    try {
      // Fire and forget, as the lifecycle bookend always was: a slow collector must not delay the prompt.
      void this.seg.obs.start();
      // Canceled while the session was being opened: nothing was sent, so there is nothing to abort.
      if (run.signal.aborted) {
        await this.finishStopped();
        return;
      }
      await this.runStreaming();
    } catch (error) {
      await this.fail(error);
    } finally {
      this.ended = true;
      this.clearTimer();
      for (const ac of this.pendingAsks.values()) ac.abort();
      this.pendingAsks.clear();
      this.stream?.disconnect();
      this.stream = null;
    }
  }

  private async runStreaming(): Promise<void> {
    const dir = this.directory;
    const stream = new EventStreamManager(this.backend, {
      sessionFilter: this.sessionId,
      directory: dir,
      reconnect: { maxRetries: 5, initialDelay: 1_000 },
    });
    this.stream = stream;
    this.attachHandlers(stream);

    // `connect` never throws: a failing subscription is retried, and a stream that gave up is noticed below.
    await stream.connect();
    // The stream may have been stopped while it connected (the turn can be canceled at any time).
    if (this.opts.run.signal.aborted) {
      await this.finishStopped();
      return;
    }
    const streamLost = stream.waitUntilDone().then(() => (this.ended || this.stopReason !== undefined ? "closed" : "lost") as "closed" | "lost");

    await this.handlePending();
    if (this.opts.run.signal.aborted) {
      await this.finishStopped();
      return;
    }

    this.startTimer();
    const sent = await this.sendPrompt();
    if (!sent) return;

    for (;;) {
      const outcome = await Promise.race([
        this.done.promise.then(() => "done" as const),
        this.stopped.promise.then(() => "stopped" as const),
        streamLost,
      ]);
      this.clearTimer();
      if (this.stopReason !== undefined || outcome === "stopped") {
        await this.finishStopped();
        return;
      }
      if (outcome === "lost" && this.cfg.features.enablePollingFallback) {
        log.warn("Event stream lost — falling back to polling", { sessionId: this.sessionId });
        this.seg.text = await this.pollForCompletion();
        break;
      }
      // A steered message the server has not delivered yet may still start its own execution: give it a moment.
      if (this.held.size > 0 && !this.seg.timedOut) {
        const began = await this.waitForHeldExecution();
        if (began) {
          this.done = createDeferred<void>();
          this.done.promise.catch(() => {});
          this.idleSeen = false;
          this.startTimer();
          continue;
        }
      }
      break;
    }

    stream.disconnect();
    this.stream = null;
    await this.finishAll();
  }

  /** Send the prompt. Returns false when the turn ended (the prompt failed: the turn is already failed). */
  private async sendPrompt(): Promise<boolean> {
    try {
      const result = await this.backend.sessionPromptAsync(this.sessionId, this.opts.prompt, this.directory);
      this.promptSent = true;
      if (result && typeof result === "object" && result.inboxId) {
        this.promptInboxId = result.inboxId;
        if (this.delivered.has(result.inboxId)) this.ownSeen = true;
      }
      log.debug("Prompt sent", { taskId: this.request.taskId, sessionId: this.sessionId });
      return true;
    } catch (e) {
      this.clearTimer();
      if (this.stopReason !== undefined) {
        await this.finishStopped();
        return false;
      }
      await this.fail(e);
      return false;
    }
  }

  // ─── Event handlers ───────────────────────────────────────────────────────

  private attachHandlers(stream: EventStreamManager): void {
    const props = (e: OpenCodeEvent): Record<string, unknown> => ((e as Record<string, unknown>).properties as Record<string, unknown>) ?? {};

    stream.on("message.updated", (event) => {
      const p = props(event);
      const info = p.info as Record<string, unknown> | undefined;
      if (info?.id && info?.role) this.messageRoles.set(info.id as string, info.role as string);
      // One completed assistant message == one LLM call. 1.x repeats the event for the same message, so count each message id once.
      if (info?.role === "assistant" && typeof info.id === "string" && !this.countedMessages.has(info.id)) {
        const record = usageRecordFromMessage(info);
        if (record) {
          this.countedMessages.add(info.id);
          this.seg.obs.recordCall(record);
        }
      }
    });

    stream.on("message.part.updated", (event) => this.onPart(props(event)));

    stream.on("session.idle", (event) => {
      const p = props(event);
      // 2.x: an `interrupted` end that arrives before our own prompt was delivered belongs to the execution we replaced.
      if (p.execution === "interrupted" && !this.ownSeen && this.backend.kind === "v2" && this.promptInboxId !== undefined) {
        log.debug("Ignoring an interruption that is not ours", { sessionId: this.sessionId });
        return;
      }
      log.info("Session idle", { taskId: this.request.taskId, sessionId: this.sessionId });
      this.idleSeen = true;
      for (const w of [...this.idleWaiters]) w();
      this.idleWaiters.clear();
      this.done.resolve();
    });

    stream.on("session.error", (event) => {
      const err = props(event).error;
      const msg = err ? JSON.stringify(err) : "Session error";
      log.error("Session error", { taskId: this.request.taskId, error: msg });
      this.done.reject(new Error(msg));
    });

    // The durable inbox (2.x): what became of the messages we sent while the session was busy.
    stream.on("session.inbox.delivered", (event) => this.onDelivered(String(props(event).inboxID ?? "")));
    stream.on("session.inbox.cancelled", (event) => this.onInboxCancelled(String(props(event).inboxID ?? "")));
    stream.on("session.execution.started", () => {
      this.idleSeen = false;
    });

    stream.on("permission.asked", (event) => {
      const req = props(event) as unknown as PermissionRequest;
      if (req?.id) void this.handlePermission(req);
    });
    stream.on("question.asked", (event) => {
      const req = props(event) as unknown as QuestionRequest;
      if (req?.id) void this.handleQuestion(req);
    });
    // Answered elsewhere (a reject cancels every pending request of the session; a person may answer in the TUI): withdraw the ask.
    const withdraw = (event: OpenCodeEvent): void => {
      const id = String(props(event).requestID ?? "");
      this.pendingAsks.get(id)?.abort();
    };
    stream.on("permission.replied", withdraw);
    stream.on("question.replied", withdraw);
    stream.on("question.rejected", withdraw);
  }

  private onPart(p: Record<string, unknown>): void {
    const part = p.part as OpenCodePart | undefined;
    if (!part) return;
    const seg = this.seg;
    const partAny = part as Record<string, unknown>;
    const msgId = partAny.messageID as string | undefined;
    const role = msgId ? this.messageRoles.get(msgId) : undefined;
    if (role === "user") return;

    if (part.type === "text") {
      const delta = (p.delta as string) ?? "";
      if (delta) {
        seg.text += delta;
        seg.response.delta(delta);
      }
      return;
    }
    if (part.type !== "tool") return;

    const state = partAny.state as Record<string, unknown> | undefined;
    const toolName = (partAny.tool as string) ?? "unknown";
    const status = state?.status as string;
    const callId = (partAny.callID as string) || "";
    const callKey = `${callId}:${toolName}`;
    const emitter = seg.obs.emitter;

    if (status === "running") {
      // Flush intermediate text as progress
      if (seg.text.trim()) {
        seg.view.progress(seg.text.trim());
        log.debug("Flushed intermediate text", { len: seg.text.trim().length, tool: toolName });
        seg.text = "";
      }
      seg.view.progress(`Executing ${toolName}...`);

      // Track for trace emission on completion
      const input = state?.input;
      const toolCallId = callId || uuidv4();
      this.pendingToolCalls.set(callKey, { callId: toolCallId, args: input ?? {}, startTime: Date.now() });
      void emitter.emit("tool_call_start", { toolCallId, toolName, arguments: truncate(sanitize(input ?? {})) });
    } else if (status === "completed") {
      const time = state?.time as Record<string, unknown> | undefined;
      const dur = time?.end && time?.start ? (time.end as number) - (time.start as number) : undefined;
      seg.view.progress(`Completed ${toolName}${dur ? ` (${dur}ms)` : ""}`);

      const tracked = this.pendingToolCalls.get(callKey);
      this.pendingToolCalls.delete(callKey);
      const toolCallId = tracked?.callId || callId || uuidv4();
      const durationMs = tracked ? Date.now() - tracked.startTime : (dur ?? 0);
      const output = state?.output;
      void emitter.emit("tool_call_end", {
        toolCallId,
        toolName,
        result: truncate(sanitize(output ?? "(no output captured)")),
        isError: false,
        durationMs,
      });
    } else if (status === "error") {
      const errMsg = (state?.error as string) ?? "Unknown error";
      seg.view.progress(`Error in ${toolName}: ${errMsg}`);

      const tracked = this.pendingToolCalls.get(callKey);
      this.pendingToolCalls.delete(callKey);
      const toolCallId = tracked?.callId || callId || uuidv4();
      const durationMs = tracked ? Date.now() - tracked.startTime : 0;
      void emitter.emit("tool_call_end", { toolCallId, toolName, result: errMsg, isError: true, durationMs });
    }
  }

  // ─── Finishing ────────────────────────────────────────────────────────────

  /** The answer text of a segment: what streamed, else the transcript's last assistant message, else a fixed note. */
  private async finalText(seg: Segment): Promise<string> {
    let text = seg.text;
    if (!text) {
      try {
        text = extractResponseText(await this.backend.sessionMessages(this.sessionId, this.directory));
      } catch (e) {
        log.debug("Transcript fallback failed", { error: (e as Error).message });
      }
    }
    return text || "No text response was returned.";
  }

  /** End one segment successfully: the response artifact, the lifecycle close and `complete` with `x-usage`. */
  private async finishSegment(seg: Segment, last: boolean): Promise<void> {
    // A held turn's segment ends when the next one starts: its text is what it streamed (the transcript is the whole session).
    const text = last ? await this.finalText(seg) : seg.text || "No text response was returned.";
    seg.response.finish(text);
    // `usage` is null when no LLM call was observed (for example the stream was lost and polling was used) rather than a
    // misleading zero-call summary.
    const done = await seg.obs.finish({ usage: seg.obs.usageIfAny() });
    seg.view.complete({ ...(done.usage ? { usage: done.usage } : {}), meta: done.meta });
    log.info("Task completed", { taskId: this.request.taskId, len: text.length });
  }

  private async finishAll(): Promise<void> {
    await this.settleHeldAtEnd();
    await Promise.all(this.pendingFinishes);
    await this.finishSegment(this.seg, true);
  }

  /** Canceled or interrupted: core has published what it publishes; only the lifecycle bookend is ours. */
  private async finishStopped(): Promise<void> {
    log.info("Execution stopped", { taskId: this.request.taskId, reason: this.stopReason ?? "cancel" });
    await Promise.all(this.pendingFinishes);
    await this.seg.obs.error(this.stopReason === "interrupt" ? "Turn interrupted" : "Task canceled");
  }

  /** The turn failed: close the lifecycle with the same text the caller sees, then fail. */
  private async fail(error: unknown): Promise<void> {
    if (this.stopReason !== undefined || this.opts.run.signal.aborted) {
      // The failure is a side effect of the abort (core already published `canceled`).
      log.info("Execution ended by cancellation", { taskId: this.request.taskId, error: (error as Error)?.message });
      await this.seg.obs.error(this.stopReason === "interrupt" ? "Turn interrupted" : "Task canceled").catch(() => {});
      return;
    }
    const { message, code } = describeFailure(error, this.cfg.opencode.baseUrl);
    log.error("Execution failed", { taskId: this.request.taskId, error: (error as Error)?.message ?? String(error) });
    // Tokens spent before the failure still count toward accounting.
    await this.seg.obs.error(message);
    this.seg.view.fail({ message, code });
  }

  private startTimer(): void {
    this.clearTimer();
    if (this.pausedAsks > 0) return;
    const timeoutMs = this.cfg.timeouts.prompt ?? 300_000;
    this.timer = setTimeout(() => {
      log.warn("Prompt timeout — resolving with partial content", { taskId: this.request.taskId, timeoutMs, hasContent: !!this.seg.text });
      this.seg.timedOut = true;
      this.done.resolve(); // resolve gracefully: return partial content
    }, timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ─── Polling fallback ─────────────────────────────────────────────────────

  private async pollForCompletion(): Promise<string> {
    const sessionId = this.sessionId;
    const dir = this.directory;
    log.info("Polling fallback", { sessionId });
    const start = Date.now();
    const lastTool = new Map<string, string>();
    const view = this.seg.view;
    const timeout = this.cfg.timeouts.prompt ?? 300_000;

    while (Date.now() - start < timeout && this.stopReason === undefined) {
      await sleep(this.cfg.timeouts.pollingInterval ?? 2_000);
      await this.handlePending();

      try {
        if (await this.backend.sessionIdle(sessionId, dir)) {
          return extractResponseText(await this.backend.sessionMessages(sessionId, dir));
        }
      } catch { /* fall through */ }

      try {
        const msgs: MessageWithParts[] = await this.backend.sessionMessages(sessionId, dir);
        for (const msg of msgs) {
          const info = msg.info as unknown as Record<string, unknown>;
          if (info?.role !== "assistant") continue;
          for (const part of msg.parts) {
            if (part.type === "tool") {
              const p = part as unknown as Record<string, unknown>;
              const st = p.state as Record<string, unknown> | undefined;
              const key = `${p.tool as string}-${p.callID as string}`;
              const cur = st?.status as string;
              if (cur && cur !== lastTool.get(key)) {
                lastTool.set(key, cur);
                if (cur === "running") view.progress(`Executing ${p.tool as string}...`);
                else if (cur === "completed") view.progress(`Completed ${p.tool as string}`);
                else if (cur === "error") view.progress(`Error in ${p.tool as string}`);
              }
            }
          }
          const time = info?.time as Record<string, unknown> | undefined;
          if (time?.completed) return extractResponseText(msgs);
        }
      } catch (e) {
        log.warn("Poll failed", { error: (e as Error).message });
      }
    }

    log.warn("Polling timed out", { sessionId });
    try {
      return extractResponseText(await this.backend.sessionMessages(sessionId, dir));
    } catch { return ""; }
  }

  // ─── Interactions (permission, question) ──────────────────────────────────

  /** Ask through core. While the client decides, the prompt timer is paused: waiting for a person is not the model being slow. */
  async ask(request: CoreInteractionRequest, opts?: AskOptions): Promise<CoreInteractionResult> {
    this.clearTimer();
    this.pausedAsks++;
    try {
      return await this.seg.view.ask(request, opts);
    } finally {
      this.pausedAsks--;
      if (!this.ended && this.pausedAsks === 0 && this.promptSent) this.startTimer();
    }
  }

  private get autoApprove(): boolean {
    return this.cfg.features.autoApprovePermissions !== false;
  }

  private get autoAnswer(): boolean {
    return this.cfg.features.autoAnswerQuestions !== false;
  }

  /** A permission request: ask through core, or (nobody is asked) answer as the wrapper always did. */
  private async handlePermission(req: PermissionRequest): Promise<void> {
    if (this.handledAsks.has(req.id)) return;
    this.handledAsks.add(req.id);
    const ac = new AbortController();
    this.pendingAsks.set(req.id, ac);
    let reply: { reply: ReturnType<typeof legacyPermissionReply>; message?: string };
    try {
      const result = await this.ask(permissionInteraction(req), { signal: ac.signal });
      if (this.opts.interactions !== "ask" && nobodyWasAsked(result)) reply = { reply: legacyPermissionReply(this.autoApprove) };
      else reply = permissionReply(result);
    } catch (e) {
      log.warn("Permission request failed", { id: req.id, error: (e as Error).message });
      reply = this.opts.interactions === "ask" ? { reply: "reject" } : { reply: legacyPermissionReply(this.autoApprove) };
    } finally {
      this.pendingAsks.delete(req.id);
    }
    // Answered elsewhere while we waited (the ask was withdrawn): the server no longer needs our reply.
    if (ac.signal.aborted && !this.ended) return;
    log.info("Handling permission", { id: req.id, permission: req.permission, reply: reply.reply });
    try {
      await this.backend.permissionReply(req.id, reply.reply, this.directory, reply.message);
    } catch (e) {
      this.handledAsks.delete(req.id);
      log.error("Permission handling failed", { id: req.id, error: (e as Error).message });
    }
  }

  /** A question (the question tool, or a 2.x form): ask through core, or (nobody is asked) answer as the wrapper always did. */
  private async handleQuestion(req: QuestionRequest): Promise<void> {
    if (this.handledAsks.has(req.id)) return;
    this.handledAsks.add(req.id);
    const ac = new AbortController();
    this.pendingAsks.set(req.id, ac);
    let answers: string[][] | undefined;
    try {
      const result = await this.ask(questionInteraction(req), { signal: ac.signal });
      if (this.opts.interactions !== "ask" && nobodyWasAsked(result)) answers = this.autoAnswer ? legacyQuestionAnswers(req) : undefined;
      else answers = questionAnswers(result, req);
    } catch (e) {
      log.warn("Question failed", { id: req.id, error: (e as Error).message });
      answers = this.opts.interactions !== "ask" && this.autoAnswer ? legacyQuestionAnswers(req) : undefined;
    } finally {
      this.pendingAsks.delete(req.id);
    }
    if (ac.signal.aborted && !this.ended) return;
    log.info("Handling question", { id: req.id, count: req.questions?.length ?? 0, answered: answers !== undefined });
    try {
      if (answers) await this.backend.questionReply(req.id, answers, this.directory);
      else await this.backend.questionReject(req.id, this.directory);
    } catch (e) {
      this.handledAsks.delete(req.id);
      log.error("Question handling failed", { id: req.id, error: (e as Error).message });
    }
  }

  /** Safety net: requests the stream missed (it was reconnecting) are still pending on the server. Only this session's. */
  private async handlePending(): Promise<void> {
    try {
      const [perms, qs] = await Promise.all([
        this.backend.permissionList(this.directory),
        this.backend.questionList(this.directory),
      ]);
      for (const p of perms) if (p.sessionID === this.sessionId) void this.handlePermission(p);
      for (const q of qs) if (q.sessionID === this.sessionId) void this.handleQuestion(q);
    } catch (e) {
      log.warn("Pending poll failed", { error: (e as Error).message });
    }
  }

  // ─── Steering ─────────────────────────────────────────────────────────────

  /**
   * Fold a message into the running turn with the server's native `steer` delivery (2.x). Honest about what is known: `inserted`
   * only once the server said it delivered the item; otherwise `queued` with the inbox id, settled later by the stream.
   */
  async steer(message: CoreMessage): Promise<SteerOutcome> {
    if (this.ended || !this.promptSent || this.idleSeen) return { state: "rejected", reason: "no-active-turn" };
    const text = corePartsText(message.parts);
    if (!text) return { state: "rejected", reason: "unsupported", detail: "only text can be steered into an OpenCode turn" };
    let handle: string;
    try {
      const result = await this.backend.sessionPromptAsync(
        this.sessionId,
        { parts: [{ type: "text", text }], delivery: "steer" },
        this.directory,
      );
      handle = (result && typeof result === "object" && result.inboxId) || `opencode-steer-${message.id}`;
    } catch (e) {
      return { state: "rejected", reason: "not-steerable", detail: (e as Error)?.message ?? String(e) };
    }
    if (this.delivered.has(handle)) return { state: "inserted" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delivered = await new Promise<boolean>((resolve) => {
      this.deliveryWaiters.set(handle, () => resolve(true));
      timer = setTimeout(() => resolve(false), this.steerAckMs);
    });
    clearTimeout(timer);
    this.deliveryWaiters.delete(handle);
    if (delivered) return { state: "inserted" };
    this.held.set(handle, { message });
    return { state: "queued", handle };
  }

  /** `inbox.delivered`: our prompt started, a steer was folded in, or a held message starts. */
  private onDelivered(inboxId: string): void {
    if (!inboxId) return;
    this.delivered.add(inboxId);
    if (inboxId === this.promptInboxId) this.ownSeen = true;
    const waiter = this.deliveryWaiters.get(inboxId);
    if (waiter) {
      waiter();
      return;
    }
    if (!this.held.has(inboxId)) return;
    if (!this.idleSeen) {
      // The execution is still running: the server folded the message into it. No new turn.
      this.held.delete(inboxId);
      try {
        this.seg.view.settleSteer(inboxId, "inserted");
      } catch (e) {
        log.warn("settleSteer failed", { handle: inboxId, error: (e as Error).message });
      }
      return;
    }
    this.heldDelivered?.(inboxId);
  }

  /** `inbox.cancelled`: a held message was removed from the inbox (by us or by someone else). */
  private onInboxCancelled(inboxId: string): void {
    if (!this.held.has(inboxId)) return;
    this.held.delete(inboxId);
    try {
      this.seg.view.settleSteer(inboxId, "dropped");
    } catch { /* the run is gone */ }
  }

  /**
   * The execution ended with steered messages the server has not delivered. A steer wakes the session, so a delivered one starts
   * its own execution: wait a moment, and split the turn there. Returns true when a held message began its own turn.
   */
  private async waitForHeldExecution(): Promise<boolean> {
    const handle = await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.heldDelivered = undefined;
        resolve(undefined);
      }, this.steerAckMs);
      this.heldDelivered = (h) => {
        clearTimeout(timer);
        this.heldDelivered = undefined;
        resolve(h);
      };
      // Already delivered while we were finishing?
      for (const h of this.held.keys()) {
        if (this.delivered.has(h)) {
          clearTimeout(timer);
          this.heldDelivered = undefined;
          resolve(h);
          return;
        }
      }
    });
    if (handle === undefined || !this.held.delete(handle)) return false;
    const prev = this.seg;
    let view: CoreTaskRun;
    try {
      view = prev.view.beginHeldTurn(handle);
    } catch (e) {
      log.warn("beginHeldTurn failed", { handle, error: (e as Error).message });
      return false;
    }
    this.seg = this.newSegment(view);
    this.pendingFinishes.push(
      this.finishSegment(prev, false).catch((e) => log.warn("finishing a segment failed", { error: (e as Error).message })),
    );
    void this.seg.obs.start();
    return true;
  }

  /** Steered messages that never ran: take them out of the inbox and hand them back to core (it runs them as the next turn). */
  private async settleHeldAtEnd(): Promise<void> {
    for (const handle of [...this.held.keys()]) {
      this.held.delete(handle);
      let outcome: "requeue" | "inserted" | "dropped" = "requeue";
      try {
        if (this.backend.inboxCancel) await this.backend.inboxCancel(this.sessionId, handle, this.directory);
        else outcome = "dropped";
      } catch (e) {
        // Not in the inbox any more: the server delivered it after all.
        outcome = this.delivered.has(handle) ? "inserted" : "dropped";
        log.debug("Cancelling a held inbox item failed", { handle, error: (e as Error).message });
      }
      try {
        this.seg.view.settleSteer(handle, outcome);
      } catch { /* the run is gone */ }
    }
  }

  // ─── Abort ────────────────────────────────────────────────────────────────

  /**
   * Stop the turn in flight. The server stops the session's work and the session stays valid for the next turn. `cancel` and
   * `shutdown` also take the steered messages we hold out of the inbox (the task is going away); `interrupt` leaves them, they
   * run in the next execution.
   */
  async abort(reason: AbortReason): Promise<AbortOutcome> {
    if (this.ended || !this.promptSent) return { stopped: "confirmed", session: "reusable" };
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<boolean>((resolve) => {
      const waiter = (): void => resolve(true);
      this.idleWaiters.add(waiter);
      idleTimer = setTimeout(() => {
        this.idleWaiters.delete(waiter);
        resolve(false);
      }, ABORT_IDLE_WAIT_MS);
      idleTimer.unref?.();
    });
    void idle.then(() => clearTimeout(idleTimer));
    await this.backend.sessionAbort(this.sessionId, this.directory);
    log.info("Session aborted", { taskId: this.request.taskId, sessionId: this.sessionId, reason });
    if (reason !== "interrupt") {
      for (const handle of [...this.held.keys()]) {
        this.held.delete(handle);
        try {
          await this.backend.inboxCancel?.(this.sessionId, handle, this.directory);
        } catch (e) {
          log.debug("Cancelling a held inbox item failed", { handle, error: (e as Error).message });
        }
        try {
          this.seg.view.dropHeld(handle);
        } catch { /* the run is gone */ }
      }
    }
    // Confirmed when the server says the session is idle: the stream's idle event, else the server's own status.
    const confirmed = await Promise.race([idle, this.pollIdle(ABORT_IDLE_WAIT_MS)]);
    return { stopped: confirmed ? "confirmed" : "unconfirmed", session: "reusable" };
  }

  private async pollIdle(budgetMs: number): Promise<boolean> {
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      try {
        if (await this.backend.sessionIdle(this.sessionId, this.directory)) return true;
      } catch { /* keep trying until the budget is spent */ }
      await sleep(150);
    }
    return false;
  }
}
