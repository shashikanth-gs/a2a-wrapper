/**
 * One turn of a Claude session: the Claude-specific half of `provider.run`.
 *
 * Opens a streaming-input `query()` (resuming the context's session when core hands one over), maps the SDK messages to what
 * core publishes (status text, trace artifacts, the response artifact, usage) and ends the turn with `complete` / `fail`.
 * Everything A2A (the bus, the task state, the cancel ordering, the queue) is core's; this file only knows the Claude Agent SDK.
 *
 * ### Rounds
 *
 * A turn can span several SDK results ("rounds"): while Claude has background work in flight after a result, the task is held
 * `working` (one response artifact per round) and completes at the result that leaves nothing running.
 *
 * ### Steering
 *
 * `steer` pushes the message into the running query's input with `priority: "next"`: the CLI folds it into the running turn at
 * the next tool boundary. The CLI says what became of it with `command_lifecycle` messages and `user_message_uuids` on the
 * results:
 *
 * - `started` before the running turn's result, or the uuid listed in that result: folded in, `inserted`.
 * - no word within `timeouts.steerAck`: answered `queued{handle}`. If the turn ends first the message runs as its own turn:
 *   its `started` arrives after the result, the turn splits there (`beginHeldTurn`) and its output is that turn's. A late
 *   fold-in is `settleSteer(handle, "inserted")`.
 *
 * The CLI's own queue lives in the process, so an interrupt (which ends the process and resumes the session in a new one) drops
 * messages that were still waiting; they are settled `dropped`.
 */

import { randomUUID } from "node:crypto";
import {
  RunObservability,
  applyUsageCallToActiveSpan,
  applyUsageSummaryToActiveSpan,
  corePartsText,
  createDeferred,
  createResponseStream,
  usageSummaryToCoreUsage,
  SESSION_NOT_FOUND,
  type AbortOutcome,
  type AbortReason,
  type CoreMessage,
  type CoreRequest,
  type CoreTaskRun,
  type CoreUsage,
  type EventTransport,
  type EventTransportFn,
  type ModelUsage,
  type SteerOutcome,
} from "@a2a-wrapper/core";

import type { AgentConfig } from "../config/types.js";
import { logger } from "../utils/logger.js";
import { BackgroundTaskTracker } from "./background-tasks.js";
import type {
  CanUseToolLike,
  ClaudeClientLike,
  QueryLike,
  SDKMessageLike,
} from "./client-factory.js";
import { buildQueryOptions } from "./client-factory.js";
import { EventMapper, sanitizeMessage } from "./event-mapper.js";
import { InputQueue } from "./input-queue.js";
import {
  UNAVAILABLE_MESSAGE,
  permissionInteraction,
  permissionResult,
  questionInteraction,
  questionItems,
  questionResult,
} from "./interactions.js";
import { RateLimitTracker, rateLimitMetadata, renderRateLimitMessage } from "./rate-limit-tracker.js";
import type { RateLimitSnapshot } from "./rate-limit-tracker.js";
import { addByModel, resultUsage, totalsFromMeta, type UsageTotals } from "./usage.js";

const log = logger.child("turn");

/** How long `steer` waits for the CLI to say the message was folded in. */
export const DEFAULT_STEER_ACK_MS = 5_000;
/** How long `abort` waits for the query to end after it was stopped. */
export const ABORT_END_WAIT_MS = 3_000;
/** How long a graceful `interrupt` of the turn is given before the process is ended anyway. */
const INTERRUPT_GRACE_MS = 2_000;
/** How long the turn waits for a queued steered message to start when the CLI reports queued turns (else `steerAck`). */
const HELD_QUEUED_WAIT_MS = 60_000;

const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: "Turn limit reached (max_turns).",
  error_max_budget_usd: "Budget limit reached (max_budget_usd).",
  error_during_execution: "Error during execution.",
  error_max_structured_output_retries: "Structured output retries exhausted.",
};

/** Does this message say the CLI has no such session? (what `resume` of an unknown session ends with) */
export function isNoConversation(text: string): boolean {
  return /no conversation found/i.test(text);
}

export interface TurnOptions {
  config: Required<AgentConfig>;
  client: ClaudeClientLike;
  request: CoreRequest;
  run: CoreTaskRun;
  customTransport?: EventTransport | EventTransportFn;
  /** Store the session in the context binding and resume it (`session.reuseByContext`, `session.ttl`). */
  reuse: boolean;
  /** Install `canUseTool`: a person or a rule can answer permission requests and questions. */
  interactive: boolean;
  steerAckMs?: number;
  /** 0 for the first turn of the task, then 1, 2, ... (a queued message or an interrupt starts another turn of the same task). */
  turnOrdinal?: number;
}

/** One output segment: the turn itself, then one per steered message that started its own turn. */
interface Segment {
  view: CoreTaskRun;
  obs: RunObservability;
  mapper: EventMapper;
  /** 0 for the turn itself. */
  index: number;
  round: number;
  streamStarted: boolean;
  finalText: string;
  structured: unknown;
  lastResult: SDKMessageLike | null;
  byModel: Record<string, ModelUsage>;
  /** `complete` was called for it. */
  completed: boolean;
}

/** A steered message the turn has not seen the end of. */
interface Steer {
  uuid: string;
  handle: string;
  /** How many results had been seen when it was sent. */
  resultsAtPush: number;
  state: "pending" | "held";
  answer(outcome: "inserted" | "queued" | "dropped"): void;
}

export class ClaudeTurn {
  private readonly cfg: Required<AgentConfig>;
  private readonly request: CoreRequest;
  private readonly input = new InputQueue();
  private readonly abortController = new AbortController();
  private query: QueryLike | undefined;
  private seg: Segment;
  private segments = 0;
  private readonly streaming: boolean;
  private readonly holdEnabled: boolean;
  private readonly steerAckMs: number;
  private readonly promptTimeout: number;
  private readonly backgroundTasks = new BackgroundTaskTracker();
  private readonly rateLimits = new RateLimitTracker();
  private readonly steers = new Map<string, Steer>();
  /** Results seen so far (all rounds and segments). */
  private results = 0;
  private ended = false;
  private timedOut = false;
  private stopReason: AbortReason | undefined;
  private stopP: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heldTimer: ReturnType<typeof setTimeout> | undefined;
  private pausedAsks = 0;
  private readonly finished = createDeferred<void>();
  /** The session id this turn knows the binding names. */
  private boundRef: string | undefined;
  private sessionId: string | undefined;
  /** The last cumulative usage reading and the session it belongs to (kept in the binding's meta). */
  private totals: UsageTotals | undefined;
  private totalsSid: string | undefined;

  constructor(private readonly opts: TurnOptions) {
    this.cfg = opts.config;
    this.request = opts.request;
    this.streaming = this.cfg.features.streamArtifactChunks === true;
    this.holdEnabled = this.cfg.features.holdTaskForBackgroundWork !== false;
    this.steerAckMs = opts.steerAckMs ?? DEFAULT_STEER_ACK_MS;
    this.promptTimeout = this.cfg.timeouts.prompt ?? 600_000;
    this.boundRef = opts.request.session?.ref;
    this.totals = this.boundRef ? totalsFromMeta(opts.request.session?.meta) : undefined;
    this.totalsSid = this.totals ? this.boundRef : undefined;
    this.seg = this.newSegment(opts.run);
    // A cancel or an interrupt aborts the signal of whichever segment is live.
    const onAbort = (): void => {
      void this.stop((opts.run.signal.reason ?? "cancel") as AbortReason);
    };
    if (opts.run.signal.aborted) onAbort();
    else opts.run.signal.addEventListener("abort", onAbort, { once: true });
  }

  private newSegment(view: CoreTaskRun): Segment {
    const obs = new RunObservability({
      agentName: this.cfg.agentCard.name,
      backend: "claude",
      request: this.request,
      run: view,
      events: this.cfg.events,
      ...(this.opts.customTransport ? { customTransport: this.opts.customTransport } : {}),
      trackUsage: false,
      warn: (m, d) => log.warn(m, d as Record<string, unknown> | undefined),
    });
    return {
      view,
      obs,
      mapper: new EventMapper(obs.emitter, this.cfg),
      index: this.segments++,
      round: 1,
      streamStarted: false,
      finalText: "",
      structured: undefined,
      lastResult: null,
      byModel: {},
      completed: false,
    };
  }

  /**
   * The id of the response artifact of the segment's current round: `response-<taskId>-<round>`, as it always was for the first
   * turn of a task. Another turn of the task (a queued message) and a steered message that starts its own turn get their own ids,
   * so a later answer never replaces an earlier one.
   */
  private artifactId(seg: Segment): string {
    const ordinal = this.opts.turnOrdinal ?? 0;
    const turn = ordinal > 0 ? `-t${ordinal}` : "";
    const segment = seg.index > 0 ? `-s${seg.index}` : "";
    return `response-${this.request.taskId}${turn}${segment}-${seg.round}`;
  }

  // ─── Running the turn ─────────────────────────────────────────────────────

  /** Run the turn to its end. Never throws: a failure ends the turn with `fail`. */
  async run(): Promise<void> {
    const { run } = this.opts;
    let rateLimited: RateLimitSnapshot | null = null;
    let resultError: string | null = null;
    let opened = false;
    const resumeRef = this.request.session?.ref;

    try {
      // Canceled while the session was being opened: nothing was sent, so there is nothing to abort.
      if (run.signal.aborted) return;

      const prompt = corePartsText(this.request.input);
      log.info("Executing task", { taskId: this.request.taskId, contextId: this.request.contextId, promptLen: prompt.length });
      this.input.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: prompt } });
      this.startTimer();

      const options = buildQueryOptions(this.cfg, {
        resume: resumeRef,
        abortController: this.abortController,
        ...(this.opts.interactive ? { canUseTool: this.canUseTool } : {}),
      });
      // Streaming input, not a string: a string prompt makes the SDK close the CLI's stdin on the first result, ending the
      // process before any background-task wake or steered message could arrive.
      const q = this.opts.client.runQuery(this.input, options);
      this.query = q;

      for await (const msg of q as AsyncIterable<SDKMessageLike>) {
        if (this.stopReason !== undefined) break;

        // Resuming a session the CLI does not have ends with an error result and no init: report it before anything was
        // published, so core forgets the binding and runs the turn again fresh.
        if (!opened) {
          if (resumeRef && msg.type === "result" && msg.subtype !== "success" && isNoConversation(errorText(msg))) {
            this.end();
            run.fail({ message: `Claude has no session ${resumeRef}`, code: SESSION_NOT_FOUND });
            return;
          }
          opened = true;
        }

        const verdict = this.rateLimits.observe(msg);
        if (verdict.kind !== "none") this.seg.mapper.handleRateLimit(verdict);
        if (verdict.kind === "rejected") {
          rateLimited = verdict.snapshot;
          break;
        }

        if (this.backgroundTasks.observe(msg)) this.seg.mapper.handleBackgroundTasks(this.backgroundTasks.snapshot());

        if (msg.type === "command_lifecycle") {
          this.onLifecycle(msg);
          continue;
        }

        if (msg.type === "system" && msg.subtype === "init") this.onInit(msg);

        // Safety-system refusal with no fallback model → fail the task with a generic message (spec §4.4). Never echo details.
        if (msg.type === "system" && msg.subtype === "model_refusal_no_fallback") {
          resultError = "Request declined by model safety system.";
        }

        const seg = this.seg;
        if (this.streaming && msg.type === "stream_event" && msg.parent_tool_use_id == null) {
          const event = msg.event as Record<string, unknown> | undefined;
          const delta = event?.delta as Record<string, unknown> | undefined;
          if (event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
            seg.streamStarted = true;
            this.responseStream(seg, true).delta(delta.text);
          }
        }

        if (msg.type !== "result") {
          seg.mapper.handleMessage(msg);
          continue;
        }

        // ── A result message: decide whether this ends the A2A Task ──
        this.results++;
        if (msg.subtype === "success" && typeof msg.result === "string") {
          seg.finalText = msg.result;
          seg.structured = msg.structured_output;
        } else if (msg.subtype !== "success") {
          resultError = RESULT_ERRORS[String(msg.subtype)] ?? `Execution failed (${String(msg.subtype)}).`;
        }
        seg.lastResult = msg;
        if (msg.subtype === "success") this.recordUsage(seg, msg);

        this.settleFolded(msg);
        const holding = this.holdEnabled && resultError === null && this.backgroundTasks.size > 0;
        seg.mapper.handleResult(msg, { held: holding });

        if (resultError !== null) {
          // The CLI stays alive on streaming input, so an error result would hang the loop unless we close the stream ourselves.
          this.input.close();
          break;
        }

        // This round's output, closed either way so the next round starts a fresh artifact.
        this.publishRound(seg);
        seg.streamStarted = false;

        if (holding) {
          seg.view.progress(seg.finalText || undefined, { backgroundTasks: this.backgroundTasks.snapshot() });
          seg.finalText = "";
          seg.structured = undefined;
          seg.round += 1;
          continue;
        }

        // Steered messages that have not started: this segment ends, the task goes on with the message's own turn.
        const waiting = this.holdPending();
        if (waiting > 0) {
          this.completeSegment(seg, false);
          this.armHeldTimer(waiting, msg);
          continue;
        }

        this.completeSegment(seg, true);
        this.input.close();
        break;
      }

      if (this.stopReason !== undefined) {
        this.finishStopped();
        return;
      }

      if (rateLimited) {
        this.endRateLimited(rateLimited);
        return;
      }

      if (resultError) {
        this.failTurn(sanitizeMessage(resultError), "backend");
        return;
      }

      if (this.abortController.signal.aborted) {
        // An abort can end the iterator CLEANLY rather than throwing: the catch's abort handling does not run, so it is here.
        if (this.timedOut) this.failTimeout();
        return;
      }

      if (!this.ended) {
        const seg = this.seg;
        this.dropAllHeld("the session ended before the message started");
        if (seg.completed) {
          // The turn already completed and only a steered message was awaited, which never started.
          this.end();
        } else {
          // The iterator ended while we were still holding (the CLI died, or it closed input on us). Complete with whatever the
          // last round left rather than hanging until the prompt timeout.
          log.info("SDK iterator ended while the task was still held open", {
            taskId: this.request.taskId,
            liveBackgroundTasks: this.backgroundTasks.size,
          });
          this.publishRound(seg);
          // This is the round that completes the task, so it owes the `agent_finished` bookend; the mapper's latch keeps it to one.
          seg.mapper.emitFinishedBookend(seg.lastResult);
          this.completeSegment(seg, true);
        }
      }
    } catch (err) {
      // A detected rate limit outranks whatever the teardown threw: the `break` awaits iterator.return().
      if (rateLimited) {
        log.info("Rate limit ended the turn; ignoring teardown error", {
          taskId: this.request.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.endRateLimited(rateLimited);
        return;
      }
      // A throw from the teardown after the terminal event must not produce a second, contradictory one.
      if (this.ended) {
        log.debug("Ignoring teardown error after the task was already terminal", {
          taskId: this.request.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (this.stopReason !== undefined) {
        this.finishStopped();
        return;
      }
      const text = err instanceof Error ? err.message : String(err);
      if (!opened && resumeRef && isNoConversation(text)) {
        this.end();
        run.fail({ message: `Claude has no session ${resumeRef}`, code: SESSION_NOT_FOUND });
        return;
      }
      const isAbort = err instanceof Error && (err.name === "AbortError" || err.message.includes("abort") || err.message.includes("canceled"));
      if (isAbort && this.timedOut) this.failTimeout();
      else if (isAbort) log.info("Task execution aborted", { taskId: this.request.taskId });
      else {
        const msg = sanitizeMessage(text);
        log.error("Task execution failed", { taskId: this.request.taskId, error: msg });
        this.failTurn(msg, "backend");
      }
    } finally {
      // The input stream parks forever if this never closes, keeping the CLI subprocess alive. Every exit path lands here.
      this.input.close();
      this.clearTimer();
      this.clearHeldTimer();
      this.dropAllHeld("the turn ended");
      this.finished.resolve();
    }
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  /** `system/init`: the session id is known. Bind it before anything is published, so a restart mid-turn can resume it. */
  private onInit(msg: SDKMessageLike): void {
    const sid = typeof msg.session_id === "string" ? msg.session_id : undefined;
    if (!sid) return;
    this.sessionId = sid;
    if (this.opts.reuse && sid !== this.boundRef) {
      this.seg.view.bind({ ref: sid });
      this.boundRef = sid;
    }
  }

  private recordUsage(seg: Segment, msg: SDKMessageLike): void {
    const sid = typeof msg.session_id === "string" ? msg.session_id : this.sessionId;
    const series = sid ?? "session";
    const ru = resultUsage(msg, this.cfg.claude.model, series, this.totalsSid === series ? this.totals : undefined);
    this.totals = ru.totals;
    this.totalsSid = series;
    seg.obs.recordCall(ru.call);
    // Optional: otel.annotateUsageCalls — per-call span events (noisy; off by default).
    applyUsageCallToActiveSpan(ru.call);
    addByModel(seg.byModel, ru.byModel);
    // Keep the cumulative reading with the binding, so the next turn's difference is exact (also after a restart).
    if (this.opts.reuse && sid) {
      try {
        seg.view.bind({ ref: sid, meta: { usageTotals: JSON.parse(JSON.stringify(ru.totals)) } });
      } catch (e) {
        log.warn("Could not store the usage total with the session binding", { error: (e as Error).message });
      }
    }
  }

  // ─── Output ───────────────────────────────────────────────────────────────

  private responseStream(seg: Segment, chunks: boolean) {
    return createResponseStream(seg.view, { chunks, id: this.artifactId(seg) });
  }

  /** This round's output artifact. */
  private publishRound(seg: Segment): void {
    if (this.streaming && seg.streamStarted) {
      this.responseStream(seg, true).finish(seg.finalText, seg.structured);
    } else if (seg.finalText) {
      this.responseStream(seg, false).finish(seg.finalText, seg.structured);
    }
  }

  /**
   * End one segment successfully: `complete` with `x-usage` (and core's usage key, with the per-model breakdown).
   * `terminal`: nothing follows (no steered message is still to start), so the turn is over.
   */
  private completeSegment(seg: Segment, terminal: boolean): void {
    if (terminal) this.end();
    seg.completed = true;
    let meta: Record<string, unknown> = {};
    let usage: CoreUsage | undefined;
    try {
      const summary = seg.obs.accumulator.summary();
      // OTel: task-span rollup only, never a second LLM span / token metric.
      applyUsageSummaryToActiveSpan(summary);
      meta = { "x-usage": summary };
      usage = usageSummaryToCoreUsage(summary);
      if (Object.keys(seg.byModel).length > 0) usage = { ...usage, byModel: seg.byModel };
    } catch (e) {
      log.warn("accumulator.summary() failed, omitting x-usage from the final event", { error: (e as Error).message });
    }
    seg.view.complete({ ...(usage ? { usage } : {}), meta: meta as never });
    log.info("Task completed", { taskId: this.request.taskId });
  }

  private end(): void {
    this.ended = true;
  }

  private failTurn(message: string, code: "backend" | "timeout"): void {
    this.end();
    this.dropAllHeld("the turn failed");
    this.seg.view.fail({ message, code });
  }

  private failTimeout(): void {
    const msg = `Prompt timed out after ${this.promptTimeout}ms.`;
    log.error("Task execution timed out", { taskId: this.request.taskId });
    this.failTurn(msg, "timeout");
  }

  /** The rate-limit ending: always terminal. Waiting out a reset is never our call; a new task on the same contextId continues. */
  private endRateLimited(snapshot: RateLimitSnapshot): void {
    // Tear down the subprocess. `query.interrupt()` is not needed: the `break` already closed the iterator, so there is no
    // in-flight consumer left to interrupt, and abort() is what actually stops the subprocess.
    this.abortController.abort();
    const seg = this.seg;
    // Already-sent chunks would otherwise leave the client's artifact open forever. finalText is "" here: no success result
    // arrives on this path.
    if (this.streaming && seg.streamStarted) this.responseStream(seg, true).finish(seg.finalText);
    this.end();
    this.dropAllHeld("the turn ended on a rate limit");
    seg.view.fail({
      message: renderRateLimitMessage(snapshot),
      code: "rate_limit",
      retryable: true,
      meta: rateLimitMetadata(snapshot) as never,
    });
  }

  /** Canceled or interrupted: core has published what it publishes; nothing is ours to say (as it always was). */
  private finishStopped(): void {
    log.info("Execution stopped", { taskId: this.request.taskId, reason: this.stopReason ?? "cancel" });
  }

  // ─── Timer ────────────────────────────────────────────────────────────────

  /**
   * A prompt timeout of 0 (or any value <= 0) disables the bound entirely: the turn runs until the SDK iterator completes.
   * Without this guard setTimeout would coerce such a delay to the next tick and abort at once. The timer is armed once, at turn
   * start, so for a held-open task it bounds the whole task including the idle gaps between SDK turns (and restarts after a
   * person answered a permission request: waiting for a person is not the model being slow).
   */
  private startTimer(): void {
    this.clearTimer();
    if (this.promptTimeout <= 0 || this.ended) return;
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.abortController.abort();
    }, this.promptTimeout);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ─── Interactions ─────────────────────────────────────────────────────────

  /** `canUseTool`: a permission request or an `AskUserQuestion`, asked through the running turn. Never rejects. */
  private readonly canUseTool: CanUseToolLike = async (toolName, input, opts) => {
    const items = toolName === "AskUserQuestion" ? questionItems(input) : undefined;
    const request = items ? questionInteraction(items) : permissionInteraction(toolName, input, opts);
    this.pausedAsks++;
    this.clearTimer();
    try {
      const result = await this.seg.view.ask(request, { signal: opts.signal });
      return items ? questionResult(result, input, items) : permissionResult(result, input);
    } catch (e) {
      log.warn("Permission request failed", { error: (e as Error).message });
      return { behavior: "deny", message: UNAVAILABLE_MESSAGE };
    } finally {
      this.pausedAsks--;
      if (this.pausedAsks === 0 && !this.ended && this.stopReason === undefined) this.startTimer();
    }
  };

  // ─── Steering ─────────────────────────────────────────────────────────────

  async steer(message: CoreMessage): Promise<SteerOutcome> {
    if (this.ended || this.input.closed || this.stopReason !== undefined) return { state: "rejected", reason: "no-active-turn" };
    const text = corePartsText(message.parts);
    if (!text) return { state: "rejected", reason: "unsupported", detail: "only text can be steered into a Claude turn" };

    const uuid = randomUUID();
    let answer!: (o: "inserted" | "queued" | "dropped") => void;
    const answered = new Promise<"inserted" | "queued" | "dropped">((resolve) => {
      answer = resolve;
    });
    const steer: Steer = { uuid, handle: `claude-steer-${message.id}`, resultsAtPush: this.results, state: "pending", answer };
    this.steers.set(uuid, steer);
    // `next`: the CLI folds the message into the running turn at the next tool boundary.
    const sent = this.input.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text }, uuid, priority: "next" });
    if (!sent) {
      this.steers.delete(uuid);
      return { state: "rejected", reason: "no-active-turn" };
    }
    const timer = setTimeout(() => answer("queued"), this.steerAckMs);
    const outcome = await answered;
    clearTimeout(timer);
    if (outcome === "inserted") {
      this.steers.delete(uuid);
      return { state: "inserted" };
    }
    if (outcome === "dropped") {
      this.steers.delete(uuid);
      return { state: "rejected", reason: "no-active-turn", detail: "the turn ended before the message was delivered" };
    }
    // Held by the CLI: its own turn (or a late fold-in) settles it through the handle.
    steer.state = "held";
    return { state: "queued", handle: steer.handle };
  }

  /** A `command_lifecycle` frame: what became of a message this turn pushed. */
  private onLifecycle(msg: SDKMessageLike): void {
    const uuid = typeof msg.command_uuid === "string" ? msg.command_uuid : undefined;
    const steer = uuid ? this.steers.get(uuid) : undefined;
    if (!steer) return;
    if (msg.state === "started") {
      if (this.results === steer.resultsAtPush) this.settleInserted(steer);
      else this.beginOwnTurn(steer);
    } else if (msg.state === "cancelled") {
      this.steers.delete(steer.uuid);
      if (steer.state === "held") this.safeSettle(steer.handle, "dropped");
      else steer.answer("dropped");
    }
  }

  /** The message was folded into the turn that was running. */
  private settleInserted(steer: Steer): void {
    this.steers.delete(steer.uuid);
    if (steer.state === "pending") steer.answer("inserted");
    else this.safeSettle(steer.handle, "inserted");
  }

  /** The message starts its own turn: the segment so far is complete, the held message's turn takes over the output. */
  private beginOwnTurn(steer: Steer): void {
    this.steers.delete(steer.uuid);
    this.clearHeldTimer();
    const start = (): void => {
      if (this.ended) return;
      let view: CoreTaskRun;
      try {
        view = this.seg.view.beginHeldTurn(steer.handle);
      } catch (e) {
        log.warn("beginHeldTurn failed", { handle: steer.handle, error: (e as Error).message });
        return;
      }
      this.seg = this.newSegment(view);
    };
    if (steer.state === "pending") {
      // The steer call has not returned yet: core registers the handle when it does.
      steer.answer("queued");
      steer.state = "held";
      setTimeout(start, 0);
    } else {
      start();
    }
  }

  private safeSettle(handle: string, outcome: "inserted" | "dropped"): void {
    try {
      this.seg.view.settleSteer(handle, outcome);
    } catch {
      /* the run is gone */
    }
  }

  /** Messages the result lists as folded into the turn it ends (a CLI that sends no lifecycle frames still says it here). */
  private settleFolded(msg: SDKMessageLike): void {
    const uuids = Array.isArray(msg.user_message_uuids) ? (msg.user_message_uuids as unknown[]) : [];
    for (const u of uuids) {
      const steer = typeof u === "string" ? this.steers.get(u) : undefined;
      if (steer && steer.resultsAtPush === this.results - 1) this.settleInserted(steer);
    }
  }

  /** After a result: how many steered messages are still to start. Unanswered steers are answered `queued` (the turn is over). */
  private holdPending(): number {
    let n = 0;
    for (const steer of this.steers.values()) {
      n++;
      if (steer.state === "pending") steer.answer("queued");
    }
    return n;
  }

  /** A queued message that never starts must not keep the turn open forever. */
  private armHeldTimer(waiting: number, msg: SDKMessageLike): void {
    this.clearHeldTimer();
    const queued = typeof msg.queued_turn_count === "number" ? msg.queued_turn_count : 0;
    const ms = queued > 0 ? HELD_QUEUED_WAIT_MS : this.steerAckMs;
    this.heldTimer = setTimeout(() => {
      if (this.steers.size === 0) return;
      log.warn("Steered message never started; dropping it", { taskId: this.request.taskId, waiting });
      this.dropAllHeld("the message never started");
      this.input.close();
    }, ms);
    this.heldTimer.unref?.();
  }

  private clearHeldTimer(): void {
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
  }

  /** Settle every steered message that has not run as `dropped` (the turn is ending, or the CLI's queue is going away). */
  private dropAllHeld(why: string): void {
    for (const steer of [...this.steers.values()]) {
      this.steers.delete(steer.uuid);
      log.debug("Dropping a steered message", { why });
      if (steer.state === "held") this.safeSettle(steer.handle, "dropped");
      else steer.answer("dropped");
    }
  }

  // ─── Abort ────────────────────────────────────────────────────────────────

  /**
   * Stop the query. `cancel` and `shutdown` end it at once (the process dies, the session stays on disk and resumes on the next
   * message). `interrupt` first asks the CLI to end the running turn, so the transcript is clean, then ends the process: the
   * message that interrupted resumes the session in a new query. The CLI's own queue goes with the process.
   */
  private stop(reason: AbortReason): Promise<void> {
    this.stopP ??= (async () => {
      this.stopReason = reason;
      this.clearTimer();
      this.clearHeldTimer();
      const held = [...this.steers.values()];
      const q = this.query;
      if (reason === "interrupt" && q) {
        await Promise.race([
          Promise.resolve()
            .then(() => q.interrupt())
            .catch(() => {}),
          new Promise((r) => setTimeout(r, INTERRUPT_GRACE_MS).unref?.()),
        ]);
      }
      this.abortController.abort();
      if (reason !== "interrupt" && q) Promise.resolve().then(() => q.interrupt()).catch(() => {});
      this.input.close();
      // Messages the CLI still had queued die with the process.
      for (const steer of held) {
        this.steers.delete(steer.uuid);
        if (steer.state === "held") {
          try {
            this.seg.view.dropHeld(steer.handle);
          } catch {
            /* the run is gone */
          }
        } else steer.answer("dropped");
      }
    })();
    return this.stopP;
  }

  async abort(reason: AbortReason): Promise<AbortOutcome> {
    if (this.ended && this.stopReason === undefined) return { stopped: "confirmed", session: "reusable" };
    await this.stop(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const over = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ABORT_END_WAIT_MS);
      timer.unref?.();
    });
    const confirmed = await Promise.race([this.finished.promise.then(() => true as const), over]);
    if (timer) clearTimeout(timer);
    return { stopped: confirmed ? "confirmed" : "unconfirmed", session: "reusable" };
  }
}

/** The text an error result carries. */
function errorText(msg: SDKMessageLike): string {
  const errors = Array.isArray(msg.errors) ? (msg.errors as unknown[]).map(String) : [];
  return errors.join("\n");
}
