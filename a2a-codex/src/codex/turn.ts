/**
 * One turn of a Codex thread: the Codex-specific half of `provider.run`.
 *
 * Drives `thread.runStreamed`, maps the thread's events to what core publishes (trace artifacts and lifecycle events through
 * the shared event mapper, the response artifact, usage) and ends the turn with `complete` or `fail`. Everything A2A (the bus,
 * the task state, the cancel ordering, the queue, the per-context lane) is core's; this file only knows the Codex SDK.
 *
 * Codex runs on the exec SDK: one CLI process per turn, no way to talk to it while it runs. So a turn cannot be steered
 * (the provider has no `steer`, core queues the message), and nothing is asked of a person (the approval policy is `never`).
 * Aborting the signal kills the CLI process; the thread (a file on disk) stays resumable.
 */

import {
  RunObservability,
  SESSION_NOT_FOUND,
  annotateSessionOnTaskSpan,
  applyUsageCallToActiveSpan,
  corePartsText,
  createResponseStream,
  turnArtifactId,
  type AbortOutcome,
  type CoreError,
  type CoreRequest,
  type CoreUsage,
  type CoreTaskRun,
  type EventTransport,
  type EventTransportFn,
  type UsageCallRecord,
} from "@a2a-wrapper/core";

import type { AgentConfig } from "../config/types.js";
import { logger } from "../utils/logger.js";
import type { CodexThreadLike, ThreadEventLike } from "./client-factory.js";
import { EventMapper, sanitizeMessage } from "./event-mapper.js";
import { isThreadNotFound } from "./thread-store.js";

const log = logger.child("turn");

/** How long `abort` waits for the CLI process of the turn to be gone. */
export const ABORT_WAIT_MS = 3_000;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * What `turn.completed.usage` of the Codex CLI means (measured against codex-cli 0.167 with gpt-6-luna, not read from the SDK
 * types, which say "during the turn"): a RUNNING TOTAL of the whole thread. The first turn of a thread reports its own spend,
 * the second reports the first plus its own (`input_tokens` 13849, then 27721, then 41619 for three one-call turns, with
 * `cached_input_tokens` growing the same way), and a resumed thread continues the total, also in another process. So the
 * wrapper hands core a `cumulative` reading (series = the thread id) and core diffs it against the previous reading of that thread,
 * which it keeps with the context binding; what a task reports is what the task spent.
 *
 * @param fresh the thread was created by this turn (a resume continues a total this process never saw).
 */
export function codexUsageReading(usage: Record<string, unknown>, series: string, fresh: boolean, model: string | undefined): CoreUsage {
  return {
    scope: "cumulative",
    series,
    ...(fresh ? { fresh: true } : {}),
    tokens: {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cached_input_tokens),
      cacheWrite: num(usage.cache_write_input_tokens),
      reasoning: num(usage.reasoning_output_tokens),
    },
    ...(model ? { model } : {}),
  };
}

/** The usage call record of what a turn spent (core's delta of a reading). Codex reports no model per call, no latency and no cost. */
export function codexUsageCall(delta: CoreUsage, modelFallback: string | undefined): UsageCallRecord {
  const t = delta.tokens;
  return {
    model: delta.model || modelFallback || "",
    inputTokens: t.input ?? 0,
    outputTokens: t.output ?? 0,
    cacheReadTokens: t.cacheRead ?? 0,
    cacheWriteTokens: t.cacheWrite ?? 0,
    reasoningTokens: t.reasoning ?? 0,
    durationMs: 0,
    timeToFirstTokenMs: null,
    cost: null,
    apiEndpoint: null,
    initiator: "codex",
  };
}

/** The error code for a failure text, so a caller can tell a login problem or a usage limit from a crash. */
export function failureCode(message: string): NonNullable<CoreError["code"]> {
  const m = message.toLowerCase();
  if (/not logged in|unauthori[sz]ed|\b401\b|invalid api key|log ?in again|please (log|sign) ?in/.test(m)) return "auth";
  if (/usage limit|rate limit|\b429\b|too many requests/.test(m)) return "rate_limit";
  if (/spawn .*enoent|enoent.*codex|codex.*not found/.test(m)) return "unavailable";
  return "backend";
}

export interface CodexTurnOptions {
  config: Required<AgentConfig>;
  thread: CodexThreadLike;
  request: CoreRequest;
  run: CoreTaskRun;
  customTransport?: EventTransport | EventTransportFn;
  /** The thread id this turn resumes (`request.session.ref`), if it resumes one. */
  resumeRef?: string;
  /** Persist contextId to thread (session reuse on). */
  bindThread: boolean;
}

export class CodexTurn {
  private readonly cfg: Required<AgentConfig>;
  private readonly request: CoreRequest;
  private readonly run_: CoreTaskRun;
  private readonly controller = new AbortController();
  /** Settles when `run()` is over (the CLI process of the turn is gone). */
  private readonly finished: Promise<void>;
  private markFinished!: () => void;

  constructor(private readonly opts: CodexTurnOptions) {
    this.cfg = opts.config;
    this.request = opts.request;
    this.run_ = opts.run;
    this.finished = new Promise<void>((resolve) => {
      this.markFinished = resolve;
    });
    // A cancel or an interrupt aborts the run's signal: that kills the CLI turn.
    const signal = opts.run.signal;
    if (signal.aborted) this.controller.abort();
    else signal.addEventListener("abort", () => this.controller.abort(), { once: true });
  }

  /** Run the turn to its end. Never throws: a failure ends the turn with `fail`. */
  async run(): Promise<void> {
    const run = this.run_;
    const req = this.request;
    const obs = new RunObservability({
      agentName: this.cfg.agentCard.name,
      backend: "codex",
      request: req,
      run,
      events: this.cfg.events,
      ...(this.opts.customTransport ? { customTransport: this.opts.customTransport } : {}),
      warn: (m, d) => log.warn(m, d as Record<string, unknown> | undefined),
    });
    const mapper = new EventMapper(obs.emitter, this.cfg);
    const chunks = this.cfg.features.streamArtifactChunks === true;
    const artifactId = turnArtifactId("response", req.taskId, req.turn);
    const streamed = createResponseStream(run, { chunks: true, id: artifactId });
    const buffered = createResponseStream(run, { chunks: false, id: artifactId });

    let finalText = "";
    let chunkStarted = false;
    /** Has the turn published or reported anything the caller could see (so `session-not-found` can no longer be retried)? */
    let output = false;
    let turnFailed: string | undefined;
    let lifecycleClosed = false;
    let threadId: string | undefined;
    const agentMessageText = new Map<string, string>();

    try {
      if (run.signal.aborted) {
        await obs.canceled();
        return;
      }
      log.info("Executing task", { taskId: req.taskId, contextId: req.contextId, resume: this.opts.resumeRef ? "yes" : "no" });
      const prompt = corePartsText(req.input);
      const { events } = await this.opts.thread.runStreamed(prompt, { signal: this.controller.signal });

      for await (const event of events as AsyncIterable<ThreadEventLike>) {
        if (event.type === "thread.started") {
          threadId = typeof event.thread_id === "string" ? event.thread_id : undefined;
          mapper.handleEvent(event);
          if (!threadId) continue;
          const resumeRef = this.opts.resumeRef;
          if (resumeRef && threadId !== resumeRef) {
            // `codex exec resume` did not resume the thread we asked for (it started another one): this is not our conversation.
            // Stop it before it publishes anything; core forgets the binding and runs the turn on a fresh thread.
            log.warn("Codex started another thread than the one to resume", { contextId: req.contextId });
            this.controller.abort();
            run.fail({ message: `Codex has no thread ${resumeRef}`, code: SESSION_NOT_FOUND });
            return;
          }
          // Persist contextId -> thread before the first output, so a restart mid-turn can resume it.
          annotateSessionOnTaskSpan({ reused: Boolean(resumeRef), sessionId: threadId });
          if (this.opts.bindThread && threadId !== resumeRef) {
            const model = this.cfg.codex.model;
            const bound = await run.bind({ ref: threadId, ...(model ? { meta: { model } } : {}) });
            if (bound === "dropped") log.debug("Thread binding was not stored", { contextId: req.contextId });
          }
          continue;
        }
        output = true;

        // Accumulate agent_message text across item.updated snapshots by item id.
        if (
          (event.type === "item.updated" || event.type === "item.completed") &&
          (event.item as Record<string, unknown> | undefined)?.type === "agent_message"
        ) {
          const item = event.item as Record<string, unknown>;
          const itemId = item.id as string;
          const newText = (item.text as string) ?? "";
          const prevText = agentMessageText.get(itemId) ?? "";
          if (chunks && newText.length > prevText.length) {
            chunkStarted = true;
            streamed.delta(newText.substring(prevText.length));
          }
          agentMessageText.set(itemId, newText);
          if (event.type === "item.completed") finalText = newText;
        }

        if (event.type === "turn.completed" && event.usage) {
          const reading = codexUsageReading(event.usage as Record<string, unknown>, threadId ?? "thread", !this.opts.resumeRef, this.cfg.codex.model);
          const call = codexUsageCall(await run.reportUsage(reading), this.cfg.codex.model);
          obs.recordCall(call);
          // Optional: otel.annotateUsageCalls adds a span event per call (noisy; off by default).
          applyUsageCallToActiveSpan(call);
        }
        if (event.type === "turn.completed") lifecycleClosed = true;
        if (event.type === "turn.failed") {
          lifecycleClosed = true;
          turnFailed = sanitizeMessage((event.error as Record<string, unknown> | undefined)?.message);
        }

        mapper.handleEvent(event);
      }

      if (run.signal.aborted) {
        // Core already published `canceled` (or the interrupt continues with the next turn).
        if (!lifecycleClosed) await obs.canceled();
        return;
      }
      if (turnFailed !== undefined) {
        // The stream ended cleanly after reporting a failed turn: it is a failure, not an empty answer. The lifecycle pair was closed by the mapper.
        log.error("Turn failed", { taskId: req.taskId, error: turnFailed });
        run.fail({ message: turnFailed, code: failureCode(turnFailed) });
        return;
      }

      // The answer: one artifact, appended chunks closed with the full text when text was streamed.
      if (chunks && chunkStarted) streamed.finish(finalText);
      else buffered.finish(finalText);
      const done = obs.usageNow();
      run.complete({ ...(done.usage ? { usage: done.usage } : {}), meta: done.meta });
      log.info("Task completed", { taskId: req.taskId, len: finalText.length });
    } catch (err) {
      if (run.signal.aborted || this.controller.signal.aborted) {
        // The thrown error is a side effect of the abort (the SDK rejects when its process is killed).
        log.info("Task execution aborted", { taskId: req.taskId });
        if (!lifecycleClosed) await obs.canceled().catch(() => {});
        return;
      }
      const raw = turnFailed ?? (err instanceof Error ? err.message : String(err));
      if (!output && this.opts.resumeRef && isThreadNotFound(err)) {
        // Reported before anything was published: core forgets the binding and runs this turn again on a fresh thread.
        log.warn("Codex has no such thread", { contextId: req.contextId });
        run.fail({ message: `Codex has no thread ${this.opts.resumeRef}`, code: SESSION_NOT_FOUND });
        return;
      }
      const message = sanitizeMessage(raw);
      log.error("Task execution failed", { taskId: req.taskId, error: message });
      if (!lifecycleClosed) await obs.error(message).catch(() => {});
      run.fail({ message, code: failureCode(message) });
    } finally {
      this.markFinished();
    }
  }

  /** Stop the CLI process of the turn and wait (bounded) until its stream has ended. The thread stays on disk, resumable. */
  async abort(): Promise<AbortOutcome> {
    this.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gone = await Promise.race([
      this.finished.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ABORT_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return { stopped: gone ? "confirmed" : "unconfirmed", session: "reusable" };
  }
}
