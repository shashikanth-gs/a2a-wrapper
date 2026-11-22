/**
 * One turn of a Copilot session: the Copilot-specific half of `provider.run`.
 *
 * Sends the prompt, maps the session's events to what core publishes (status text, trace artifacts, the response artifact,
 * usage) and ends the turn with `complete` / `fail`. Everything A2A (the bus, the task state, the cancel ordering, the
 * queue) is core's; this file only knows the Copilot SDK.
 *
 * ### Steering and held messages
 *
 * `steer` sends the message with `mode: "immediate"` and a `clientTurnId`. Copilot reports how it delivered a message
 * with a `user.message` event that echoes the `clientTurnId`, but only when the message is CONSUMED (at the next model-call
 * boundary, which can be long after the send). So `steer` waits a short while for that echo:
 *
 * - `delivery: "steering"` within the window: folded into the running turn, answered `inserted`.
 * - `delivery: "queued"` / `"idle"` (it became its own run), or no echo yet: answered `queued` with a handle. The message
 *   is held by Copilot; when its `user.message` arrives the turn splits there: the segment so far is completed and
 *   `beginHeldTurn(handle)` hands the rest of the output to the message's own turn, which ends at `session.idle`.
 *
 * ### Why a turn can outlive `session.idle` of a segment
 *
 * `session.idle` means "nothing left to do" (no queued message, no background task), not "the first answer is done", so one
 * `provider.run` call may carry several segments; it returns when the last one ends.
 */

import {
  corePartsText,
  RunObservability,
  annotateSessionOnTaskSpan,
  createResponseStream,
  type AbortOutcome,
  type AbortReason,
  type CoreInteractionRequest,
  type CoreInteractionResult,
  type CoreMessage,
  type CoreTaskRun,
  type CoreRequest,
  type EventTransport,
  type EventTransportFn,
  type ResponseStream,
  type SteerOutcome,
  type UsageCallRecord,
  type ContextWindowSnapshot,
} from "@a2a-wrapper/core";
import type { AgentConfig } from "../config/types.js";
import { createDeferred } from "../utils/deferred.js";
import { logger } from "../utils/logger.js";
import type { McpEvidenceHooks } from "./mcp-hooks.js";
import type { CopilotSession } from "./types.js";

const log = logger.child("turn");

/** How long `steer` waits for Copilot to say how it delivered the message. */
export const DEFAULT_STEER_ACK_MS = 5_000;
/** How long `abort` waits for the session to go idle after `session.abort()`. */
export const ABORT_IDLE_WAIT_MS = 3_000;

/**
 * Heuristic: detect when an assistant "response" is actually a tool call serialized as plain text. Models without proper
 * native function-calling support (common with small/local Ollama models) print tool calls into the text channel as JSON
 * like `{"name":"view","arguments":{...}}` instead of using the structured tool-call protocol the CLI expects.
 *
 * Returns true only for a JSON object that has a string `name` plus an `arguments`/`parameters` object — the canonical
 * OpenAI tool-call shape — so ordinary JSON answers from the model are not misclassified.
 */
export function looksLikeRawToolCall(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  const hasName = typeof obj.name === "string";
  const hasArgs =
    (typeof obj.arguments === "object" && obj.arguments !== null) ||
    (typeof obj.parameters === "object" && obj.parameters !== null);
  return hasName && hasArgs;
}

/** The text of the failure as the caller sees it (the same wording the wrapper has always used). */
export function describeFailure(error: unknown, cliUrl: string | undefined): { message: string; code: "auth" | "unavailable" | "backend" } {
  const msg = (error as Error)?.message ?? String(error);
  const isConnErr = msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("connect") || msg.includes("socket");
  const isAuthErr = msg.includes("onPermissionRequest") || msg.toLowerCase().includes("permission") || msg.includes("handler is required");
  if (isAuthErr) return { message: "GITHUB_TOKEN not set. Run `gh auth login` or set GITHUB_TOKEN env var.", code: "auth" };
  if (isConnErr && cliUrl) return { message: `Cannot reach GitHub Copilot CLI server at ${cliUrl}. Is it running?`, code: "unavailable" };
  return { message: `Error: ${msg}`, code: "backend" };
}

/** What a turn needs from the provider. */
export interface TurnOptions {
  config: Required<AgentConfig>;
  session: CopilotSession;
  hooks: McpEvidenceHooks;
  request: CoreRequest;
  run: CoreTaskRun;
  customTransport?: EventTransport | EventTransportFn;
  /** `ask`: permission requests and questions go to the client. `auto`: the headless default. */
  interactions: "auto" | "ask";
  steerAckMs?: number;
  /** Was the session resumed or reused rather than created for this turn? */
  reused: boolean;
}

/** One output segment: the turn itself, then one per held message that starts. */
interface Segment {
  view: CoreTaskRun;
  obs: RunObservability;
  response: ResponseStream;
  text: string;
  reasoning: string;
  timedOut: boolean;
}

export class CopilotTurn {
  private readonly cfg: Required<AgentConfig>;
  private readonly session: CopilotSession;
  private readonly request: CoreRequest;
  private seg: Segment;
  private readonly unsubs: Array<() => void> = [];
  /** Settles the streaming wait: idle, a timeout or an error. */
  private readonly done = createDeferred<void>();
  /** Settles when any segment's signal aborts (cancel or interrupt). */
  private readonly stopped = createDeferred<void>();
  private stopReason: AbortReason | undefined;
  private ended = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingFinishes: Promise<void>[] = [];
  /** Steers waiting for the `user.message` that says how Copilot delivered them. */
  private readonly echoWaiters = new Map<string, (delivery: string | undefined) => void>();
  /** Handles answered `queued` and not yet begun. */
  private readonly held = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly steerAckMs: number;

  constructor(private readonly opts: TurnOptions) {
    this.cfg = opts.config;
    this.session = opts.session;
    this.request = opts.request;
    this.steerAckMs = opts.steerAckMs ?? DEFAULT_STEER_ACK_MS;
    this.seg = this.newSegment(opts.run);
    // `done` may be rejected after the wait ended (a stop won the race): that must not be an unhandled rejection.
    this.done.promise.catch(() => {});
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  /** The view of the segment that is producing output now. */
  get view(): CoreTaskRun {
    return this.seg.view;
  }

  private newSegment(view: CoreTaskRun): Segment {
    const obs = new RunObservability({
      agentName: this.cfg.agentCard.name,
      backend: "copilot",
      request: this.request,
      run: view,
      events: this.cfg.events,
      ...(this.opts.customTransport ? { customTransport: this.opts.customTransport } : {}),
      trackUsage: this.cfg.features.trackUsage === true,
      warn: (m, d) => log.warn(m, d as Record<string, unknown> | undefined),
    });
    const seg: Segment = {
      view,
      obs,
      response: createResponseStream(view, { chunks: this.cfg.features.streamArtifactChunks === true }),
      text: "",
      reasoning: "",
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
    this.opts.hooks.setEmitter(this.seg.obs.emitter);
    annotateSessionOnTaskSpan({ reused: this.opts.reused, sessionId: this.sessionId });
    try {
      // Fire and forget, as the lifecycle bookend always was: a slow collector must not delay the prompt.
      void this.seg.obs.start();
      // Canceled while the session was being opened: nothing was sent, so there is nothing to abort.
      if (run.signal.aborted) {
        await this.finishStopped();
        return;
      }
      const prompt = corePartsText(this.request.input);
      log.info("Sending prompt", { taskId: this.request.taskId, sessionId: this.sessionId, len: prompt.length });
      if (this.cfg.copilot.streaming) await this.runStreaming(prompt);
      else await this.runBlocking(prompt);
    } catch (error) {
      await this.fail(error);
    } finally {
      this.ended = true;
      this.clearTimer();
      for (const u of this.unsubs.splice(0)) if (typeof u === "function") u();
      this.opts.hooks.clearEmitter();
      for (const w of this.idleWaiters) w();
      this.idleWaiters.clear();
    }
  }

  private subscribe(event: string, handler: (event: any) => void): void {
    this.unsubs.push(this.session.on(event, handler));
  }

  /** Streaming mode: listen to the session's events and complete on `session.idle`. */
  private async runStreaming(prompt: string): Promise<void> {
    this.attachCommonListeners();
    const taskId = this.request.taskId;

    this.subscribe("assistant.message_delta", (event) => {
      const delta = event?.data?.deltaContent ?? "";
      if (!delta) return;
      this.seg.text += delta;
      this.seg.response.delta(delta);
    });

    // Thinking / reasoning deltas are accumulated; the completed reasoning goes out as a trace.thinking event.
    this.subscribe("assistant.reasoning_delta", (event) => {
      const delta = event?.data?.deltaContent ?? "";
      if (delta) {
        this.seg.reasoning += delta;
        log.debug("Reasoning delta", { taskId, len: delta.length });
      }
    });

    // Final assistant message (safety net if deltas were empty)
    this.subscribe("assistant.message", (event) => {
      const content = event?.data?.content ?? "";
      if (content && !this.seg.text) this.seg.text = content;
    });

    this.subscribe("assistant.reasoning", (event) => {
      const content = event?.data?.content ?? this.seg.reasoning;
      if (content) {
        log.debug("Reasoning complete", { taskId, len: content.length });
        void this.seg.obs.emitter.emit("thinking", { content });
        this.seg.reasoning = "";
      }
    });

    this.subscribe("assistant.intent", (event) => {
      const intent = event?.data?.intent ?? "";
      if (intent) {
        log.debug("Intent", { taskId, intent });
        this.seg.view.progress(`Intent: ${intent}`);
      }
    });

    this.subscribe("tool.execution_start", (event) => {
      const toolName = event?.data?.toolName ?? event?.data?.mcpToolName ?? "unknown";
      log.info("Tool execution start", { taskId, toolName });
      this.seg.view.progress(`Executing ${toolName}...`);
    });

    this.subscribe("tool.execution_progress", (event) => {
      const msg = event?.data?.progressMessage ?? "";
      if (msg) this.seg.view.progress(msg);
    });

    this.subscribe("tool.execution_complete", (event) => {
      const toolCallId = event?.data?.toolCallId ?? "";
      const success = event?.data?.success ?? true;
      if (success) {
        log.info("Tool execution complete", { taskId, toolCallId });
        this.seg.view.progress("Tool completed");
      } else {
        const errMsg = event?.data?.error?.message ?? "Unknown error";
        log.warn("Tool execution failed", { taskId, toolCallId, error: errMsg });
        this.seg.view.progress(`Tool error: ${errMsg}`);
      }
    });

    this.subscribe("subagent.started", (event) => {
      const name = event?.data?.agentDisplayName ?? event?.data?.agentName ?? "subagent";
      this.seg.view.progress(`Delegating to ${name}...`);
    });
    this.subscribe("subagent.completed", (event) => {
      this.seg.view.progress(`${event?.data?.agentName ?? "subagent"} completed`);
    });
    this.subscribe("subagent.failed", (event) => {
      const name = event?.data?.agentName ?? "subagent";
      this.seg.view.progress(`${name} failed: ${event?.data?.error ?? "Unknown error"}`);
    });

    this.subscribe("session.error", (event) => {
      const msg: string = event?.data?.message ?? "Session error";
      // SDK may emit a timeout error from its internal sendAndWait — treat as graceful completion if we have any content
      if (msg.toLowerCase().includes("timeout")) {
        log.warn("SDK session timeout (treating as completion)", { taskId, error: msg, hasContent: !!this.seg.text });
        this.seg.timedOut = true;
        this.done.resolve();
      } else {
        log.error("Session error", { taskId, error: msg });
        this.done.reject(new Error(msg));
      }
    });

    this.subscribe("session.idle", () => this.done.resolve());

    this.startTimer();
    // Fire-and-forget send: completion is the session.idle listener (sendAndWait's 60s default is too short for tool-heavy turns).
    this.session
      .send({ prompt, clientTurnId: this.request.turnId })
      .catch((e: Error) => {
        // send() itself can fail (connection error etc.); a timeout still returns what we have
        if (e.message?.toLowerCase().includes("timeout")) {
          log.warn("send() timeout — resolving with partial content", { taskId });
          this.seg.timedOut = true;
          this.done.resolve();
        } else {
          this.done.reject(e);
        }
      });

    await Promise.race([this.done.promise, this.stopped.promise]);
    this.clearTimer();
    if (this.stopReason !== undefined) {
      await this.finishStopped();
      return;
    }
    await this.finishAll();
  }

  /** Non-streaming mode: `sendAndWait` returns the complete answer. */
  private async runBlocking(prompt: string): Promise<void> {
    this.attachCommonListeners();
    const timeoutMs = this.cfg.timeouts.prompt ?? 600_000;
    let promptTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      promptTimer = setTimeout(() => rej(new Error(`Prompt timeout after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      const sent = this.session.sendAndWait({ prompt }, timeoutMs);
      sent.catch(() => {}); // an abort() makes it reject; that is the cancel, not a failure
      const response = await Promise.race([sent, timeout, this.stopped.promise.then(() => "stopped" as const)]);
      if (response !== "stopped") this.seg.text = (response as { data?: { content?: string } } | undefined)?.data?.content ?? "";
    } catch (e) {
      // An abort() makes sendAndWait reject; that is the cancel, not a failure.
      if (this.stopReason === undefined) {
        if (!(e as Error).message.includes("timeout")) throw e;
        log.warn("Prompt timed out", { taskId: this.request.taskId, timeoutMs });
      }
    } finally {
      clearTimeout(promptTimer);
    }
    if (this.stopReason !== undefined) {
      await this.finishStopped();
      return;
    }
    await this.finishAll();
  }

  /** Listeners both modes need: usage and the delivery echo of steered messages. */
  private attachCommonListeners(): void {
    this.subscribe("assistant.usage", (event) => {
      const d = event?.data ?? {};
      const callRecord: UsageCallRecord = {
        model: d.model ?? "",
        inputTokens: d.inputTokens ?? 0,
        outputTokens: d.outputTokens ?? 0,
        cacheReadTokens: d.cacheReadTokens ?? 0,
        cacheWriteTokens: d.cacheWriteTokens ?? 0,
        reasoningTokens: d.reasoningTokens ?? 0,
        durationMs: d.duration ?? 0,
        timeToFirstTokenMs: d.timeToFirstTokenMs ?? null,
        cost: d.cost ?? null,
        apiEndpoint: d.apiEndpoint ?? null,
        initiator: d.initiator ?? null,
      };
      this.seg.obs.recordCall(callRecord);
    });

    this.subscribe("session.usage_info", (event) => {
      const d = event?.data ?? {};
      const snapshot: ContextWindowSnapshot = {
        currentTokens: d.currentTokens,
        tokenLimit: d.tokenLimit ?? null,
        conversationTokens: d.conversationTokens ?? null,
        systemTokens: d.systemTokens ?? null,
        toolDefinitionsTokens: d.toolDefinitionsTokens ?? null,
        messagesLength: d.messagesLength ?? null,
      };
      this.seg.obs.setContextWindow(snapshot);
    });

    this.subscribe("user.message", (event) => this.onUserMessage(event?.data?.clientTurnId, event?.data?.delivery));
    this.subscribe("session.idle", () => {
      for (const w of [...this.idleWaiters]) w();
      this.idleWaiters.clear();
    });
  }

  // ─── Finishing ────────────────────────────────────────────────────────────

  /** The answer text of a segment: partial-timeout note, fallbacks and the raw-tool-call guard, as the wrapper always did. */
  private finalText(seg: Segment): string {
    let text = seg.text;
    // If we timed out but have content, append a note
    if (seg.timedOut && text) text += "\n\n---\n*Response truncated: processing time limit reached.*";
    if (!text) text = seg.timedOut ? "The request timed out before a response was produced." : "No text response was returned.";

    // BYOK guard: some local models (via Ollama / vLLM, etc.) print the tool call as plain text instead of emitting a
    // structured one. Replace it with an actionable message rather than leaking raw tool-call JSON to the caller.
    if (this.cfg.copilot.provider && looksLikeRawToolCall(text)) {
      log.warn("Model emitted a tool call as plain text — likely a model that lacks native tool-calling support", {
        taskId: this.request.taskId,
        model: this.cfg.copilot.model,
        preview: text.slice(0, 120),
      });
      text =
        "The configured model returned a tool call as plain text instead of a usable " +
        "response. This usually means the model does not fully support the native " +
        "function-calling (tool) protocol required by the agent runtime. Try a model " +
        "with robust tool-calling support (e.g. qwen3.6, llama3.3, mistral-nemo).";
    }
    return text;
  }

  /** End one segment successfully: the response artifact, the lifecycle close and `complete` with `x-usage`. */
  private async finishSegment(seg: Segment): Promise<void> {
    const text = this.finalText(seg);
    seg.response.finish(text);
    const done = await seg.obs.finish();
    seg.view.complete({ ...(done.usage ? { usage: done.usage } : {}), meta: done.meta });
    log.info("Task completed", { taskId: this.request.taskId, len: text.length });
  }

  private async finishAll(): Promise<void> {
    // A message Copilot never delivered (the queue was drained or flushed): it will not run, so release it.
    for (const handle of [...this.held]) {
      this.held.delete(handle);
      try {
        this.seg.view.settleSteer(handle, "dropped");
      } catch {
        /* the run is gone */
      }
    }
    await Promise.all(this.pendingFinishes);
    await this.finishSegment(this.seg);
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
    const { message, code } = describeFailure(error, this.cfg.copilot.cliUrl);
    log.error("Execution failed", { taskId: this.request.taskId, error: (error as Error)?.message ?? String(error) });
    // Tokens spent before the failure still count toward accounting.
    await this.seg.obs.error(message);
    this.seg.view.fail({ message, code });
  }

  private startTimer(): void {
    this.clearTimer();
    const timeoutMs = this.cfg.timeouts.prompt ?? 600_000;
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

  // ─── Interactions (permission, ask_user) ──────────────────────────────────

  /** Ask through core. While the client decides, the prompt timer is paused: waiting for a person is not the model being slow. */
  async ask(request: CoreInteractionRequest): Promise<CoreInteractionResult> {
    this.clearTimer();
    try {
      return await this.seg.view.ask(request);
    } finally {
      if (!this.ended && this.cfg.copilot.streaming) this.startTimer();
    }
  }

  // ─── Steering ─────────────────────────────────────────────────────────────

  async steer(message: CoreMessage): Promise<SteerOutcome> {
    if (this.ended) return { state: "rejected", reason: "no-active-turn" };
    const text = corePartsText(message.parts);
    if (!text) return { state: "rejected", reason: "unsupported", detail: "only text can be steered into a Copilot turn" };
    const handle = `copilot-steer-${message.id}`;
    let echo!: (delivery: string | undefined) => void;
    const delivered = new Promise<string | undefined>((resolve) => {
      echo = resolve;
    });
    this.echoWaiters.set(handle, echo);
    try {
      await this.session.send({ prompt: text, mode: "immediate", clientTurnId: handle });
    } catch (e) {
      this.echoWaiters.delete(handle);
      return { state: "rejected", reason: "not-steerable", detail: (e as Error)?.message ?? String(e) };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delivery = await Promise.race([
      delivered,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.steerAckMs);
      }),
    ]);
    clearTimeout(timer);
    this.echoWaiters.delete(handle);

    if (delivery === "steering") return { state: "inserted" };

    // `queued` / `idle`: the message runs as its own Copilot run. No echo yet: Copilot has it and has not consumed it.
    this.held.add(handle);
    if (delivery !== undefined) setTimeout(() => this.beginHeld(handle), 0); // core registers the handle when this call returns
    return { state: "queued", handle };
  }

  /** A `user.message` arrived: did it answer a steer, or is it a held message starting? */
  private onUserMessage(clientTurnId: unknown, delivery: unknown): void {
    if (typeof clientTurnId !== "string") return;
    const waiter = this.echoWaiters.get(clientTurnId);
    if (waiter) {
      waiter(typeof delivery === "string" ? delivery : undefined);
      return;
    }
    if (!this.held.has(clientTurnId)) return;
    if (delivery === "steering") {
      // Copilot folded the message into the turn that is running NOW (the echo only came after the ack window): there is no
      // new turn. Tell core the message was delivered and stay in this segment.
      this.held.delete(clientTurnId);
      try {
        this.seg.view.settleSteer(clientTurnId, "inserted");
      } catch (e) {
        log.warn("settleSteer failed", { handle: clientTurnId, error: (e as Error).message });
      }
      return;
    }
    this.beginHeld(clientTurnId);
  }

  /** A held message starts: the segment so far is complete, the held message's own turn takes over the output. */
  private beginHeld(handle: string): void {
    if (!this.held.delete(handle) || this.ended) return;
    const prev = this.seg;
    let view: CoreTaskRun;
    try {
      view = prev.view.beginHeldTurn(handle);
    } catch (e) {
      log.warn("beginHeldTurn failed", { handle, error: (e as Error).message });
      return;
    }
    const next = this.newSegment(view);
    this.seg = next;
    this.opts.hooks.setEmitter(next.obs.emitter);
    this.pendingFinishes.push(
      this.finishSegment(prev).catch((e) => log.warn("finishing a segment failed", { error: (e as Error).message })),
    );
    void next.obs.start();
  }

  // ─── Abort ────────────────────────────────────────────────────────────────

  /**
   * Stop the turn in flight. `interrupt` keeps Copilot's native queue (the task goes on with the next turn); `cancel` and
   * `shutdown` flush it, because the task is going away.
   */
  async abort(reason: AbortReason): Promise<AbortOutcome> {
    if (this.ended) return { stopped: "confirmed", session: "reusable" };
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
    await this.session.abort();
    log.info("Session turn aborted", { taskId: this.request.taskId, sessionId: this.sessionId, reason });
    if (reason !== "interrupt") {
      try {
        await this.session.rpc?.queue?.clear?.();
      } catch (e) {
        log.debug("Clearing the native queue failed", { error: (e as Error).message });
      }
      for (const handle of [...this.held]) {
        this.held.delete(handle);
        try {
          this.seg.view.dropHeld(handle);
        } catch {
          /* the run is gone */
        }
      }
    }
    const confirmed = await idle;
    return { stopped: confirmed ? "confirmed" : "unconfirmed", session: "reusable" };
  }
}
