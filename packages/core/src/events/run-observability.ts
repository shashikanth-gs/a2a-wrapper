/**
 * @module events/run-observability
 *
 * The observability a provider wrapper had to build for itself around an A2A event bus, rebuilt on a
 * provider run ({@link CoreTaskRun}) so a wrapper that implements `ProviderExecutor` knows nothing about the
 * bus or the A2A SDK and still publishes exactly what wrappers publish today:
 *
 * - **Sideband trace events** (`trace.lifecycle`, `trace.thinking`, `trace.mcp`, ...): {@link RunObservability.emitter}
 *   is the same {@link AgentEventEmitter} as before; its default `a2a` transport turns each event into the same
 *   trace artifact (same name, extension `urn:x-a2a:trace:v1`, metadata and data part) through `run.artifact`.
 *   `http`, `both` and a programmatic custom transport behave as in {@link resolveTransport}.
 * - **Usage**: per-call records accumulate in a {@link LlmUsageAccumulator}; with `trackUsage` each call is also a
 *   `trace.usage` artifact and each context-window reading a `context_window` event. {@link RunObservability.finish}
 *   closes the lifecycle (`agent_finished`, waited for at most `terminalTimeoutMs`) and returns what to hand to
 *   `run.complete`: the `x-usage` metadata of the completed status and the same totals as a {@link CoreUsage}.
 * - **The response artifact**: {@link createResponseStream}.
 *
 * Nothing here names a provider; `backend` is a label the wrapper passes in.
 *
 * @see docs/design/core-data-model.md section 3.14
 */

import { v4 as uuidv4 } from "uuid";
import { TRACE_EXTENSION_URI } from "../server/agent-card.js";
import type { EventsConfig } from "../config/types.js";
import { addModelUsage, type CoreArtifact, type CoreRequest, type CoreTaskRun, type CoreUsage, type Meta, type ModelUsage } from "../model/index.js";
import { applyUsageSummaryToActiveSpan } from "../telemetry/usage-bridge.js";
import { slugAgentId } from "../telemetry/attributes.js";
import {
  AgentEventEmitter,
  agentEventToTrace,
  resolveTransportWith,
  type AgentEvent,
  type EventTransport,
  type EventTransportFn,
} from "./transport.js";
import { LlmUsageAccumulator, type ContextWindowSnapshot, type UsageCallRecord, type UsageTelemetryData } from "./usage.js";

/** Upper bound on how long a terminal lifecycle event may delay completion (see {@link RunObservability.finish}). */
export const DEFAULT_TERMINAL_EMIT_TIMEOUT_MS = 2_000;

/** Metadata key of the usage summary on the completed status. */
export const X_USAGE_KEY = "x-usage";

/**
 * The `a2a` sideband transport over a provider run: a trace event is a trace artifact published through
 * `run.artifact`, identical on the wire to what `A2ATransport` publishes on a bus.
 */
export class RunTransport implements EventTransport {
  constructor(private readonly run: Pick<CoreTaskRun, "artifact">) {}

  async send(event: AgentEvent): Promise<void> {
    const trace = agentEventToTrace(event);
    if (!trace) return; // unmapped event types are dropped, as on the bus transport
    this.run.artifact(traceArtifact(trace.name, trace.data, trace.metadata));
  }
}

/** A trace artifact: buffered (`lastChunk`), carrying the trace extension and one JSON data part. */
export function traceArtifact(name: string, data: Record<string, unknown>, meta?: Meta): CoreArtifact {
  return {
    id: `${name}-${uuidv4()}`,
    name,
    extensions: [TRACE_EXTENSION_URI],
    meta: meta ?? { traceType: name, timestamp: new Date().toISOString() },
    parts: [{ kind: "data", data, meta: { mimeType: "application/json" } }],
    append: false,
    lastChunk: true,
  };
}

export interface RunObservabilityOptions {
  /** `agentCard.name`. */
  agentName: string;
  /** A short label stamped on the lifecycle events (`backend`), chosen by the wrapper. */
  backend: string;
  request: Pick<CoreRequest, "taskId" | "contextId" | "correlation">;
  /** `reportUsage` is needed only by {@link RunObservability.recordCumulative}. */
  run: Pick<CoreTaskRun, "artifact"> & Partial<Pick<CoreTaskRun, "reportUsage">>;
  events?: EventsConfig;
  customTransport?: EventTransport | EventTransportFn;
  /** Also publish a `trace.usage` artifact per call and a `context_window` event per reading. Default `false`. */
  trackUsage?: boolean;
  /** Default {@link DEFAULT_TERMINAL_EMIT_TIMEOUT_MS}. */
  terminalTimeoutMs?: number;
  /** Receives non-fatal problems (a failed trace publication). */
  warn?: (message: string, data?: unknown) => void;
}

/** What {@link RunObservability.finish} returns: hand it to `run.complete`. */
export interface RunFinish {
  /** The `x-usage` summary, or `undefined` when computing it failed (it is then left out, never thrown). */
  summary?: UsageTelemetryData;
  /** `{ "x-usage": summary }`, or `{}`. */
  meta: Meta;
  /** The summary as a core usage report (scope `delta`, per-model breakdown), or `undefined` with no summary. */
  usage?: CoreUsage;
}

/**
 * Per-turn observability of a provider run. Create one per `provider.run` call (and one per held turn), call
 * {@link start} once the backend session is open, {@link recordCall} / {@link setContextWindow} as the backend reports
 * usage, and end with exactly one of {@link finish}, {@link error} or {@link canceled}.
 */
export class RunObservability {
  readonly emitter: AgentEventEmitter;
  readonly agentId: string;
  readonly accumulator = new LlmUsageAccumulator();

  private readonly run: RunObservabilityOptions["run"];
  /** The per-model deltas of the cumulative readings of this turn ({@link recordCumulative}). */
  private readonly deltaByModel: Record<string, ModelUsage> = {};
  private readonly backend: string;
  private readonly trackUsage: boolean;
  private readonly terminalTimeoutMs: number;
  private readonly warn: (message: string, data?: unknown) => void;
  private closed = false;

  constructor(opts: RunObservabilityOptions) {
    this.run = opts.run;
    this.backend = opts.backend;
    this.trackUsage = opts.trackUsage === true;
    this.terminalTimeoutMs = opts.terminalTimeoutMs ?? DEFAULT_TERMINAL_EMIT_TIMEOUT_MS;
    this.warn = opts.warn ?? (() => {});
    this.agentId = slugAgentId(opts.agentName);
    const corr = opts.request.correlation;
    const transport = resolveTransportWith(opts.events, () => new RunTransport(opts.run), opts.customTransport);
    this.emitter = new AgentEventEmitter({
      agentId: this.agentId,
      agentName: opts.agentName,
      traceId: corr.trace?.traceId || opts.request.contextId,
      parentAgentId: corr.parentAgentId ?? null,
      propagatedMetadata: corr.metadata,
      transport,
    });
  }

  /** Lifecycle bookend: `agent_started`. */
  start(extra: Record<string, unknown> = {}): Promise<void> {
    return this.emitter.emit("agent_started", { backend: this.backend, ...extra });
  }

  /** One LLM call. Accumulated always; published as `trace.usage` when `trackUsage` is on. */
  recordCall(call: UsageCallRecord): void {
    this.accumulator.record(call);
    if (!this.trackUsage) return;
    try {
      this.run.artifact(traceArtifact("trace.usage", call as unknown as Record<string, unknown>));
    } catch (e) {
      this.warn("Failed to publish trace.usage artifact", { error: (e as Error).message });
    }
  }

  /**
   * One LLM call whose cost the backend reports as a RUNNING TOTAL (a session's `total_cost_usd`). Core diffs `reading`
   * against the previous reading of its series (`run.reportUsage`, see there for the rules: new series, lost baseline,
   * decrease), records `call` with the DELTA as its cost (`null` when the delta carries no cost) and keeps the delta's
   * per-model breakdown, which {@link finish} puts in the core usage it returns. Returns the delta. `call.cost` is ignored.
   * Call it for a failing result too, so its spend is attributed to that task and not to the next one.
   */
  async recordCumulative(call: Omit<UsageCallRecord, "cost">, reading: CoreUsage): Promise<CoreUsage> {
    if (!this.run.reportUsage) throw new TypeError("recordCumulative needs a run with reportUsage");
    const delta = await this.run.reportUsage(reading);
    addModelUsage(this.deltaByModel, delta.byModel);
    this.recordCall({ ...call, cost: delta.costUsd === undefined ? null : delta.costUsd });
    return delta;
  }

  /** The latest context-window reading. Emitted as `context_window` when `trackUsage` is on. */
  setContextWindow(snapshot: ContextWindowSnapshot): void {
    this.accumulator.setContextWindow(snapshot);
    if (!this.trackUsage) return;
    try {
      void this.emitter.emit("context_window", snapshot as unknown as Record<string, unknown>);
    } catch (e) {
      this.warn("Failed to emit context_window event", { error: (e as Error).message });
    }
  }

  /** Usage summary if any LLM call was recorded, otherwise `null`. Never throws. */
  usageIfAny(): UsageTelemetryData | null {
    try {
      const summary = this.accumulator.summary();
      return summary.llmCalls > 0 ? summary : null;
    } catch {
      return null;
    }
  }

  /**
   * The turn succeeded: compute the summary, roll it up on the task span, close the lifecycle with `agent_finished`
   * (`usage` is the same summary that goes out as `x-usage`; `cost` stays null when the backend reported none) and
   * return what to pass to `run.complete`. The lifecycle event is awaited for at most `terminalTimeoutMs` so a
   * collector hears about the usage before the caller sees the task finish, and a slow collector never stalls tasks.
   */
  async finish(extra: Record<string, unknown> = {}): Promise<RunFinish> {
    let summary: UsageTelemetryData | undefined;
    try {
      summary = this.accumulator.summary();
      // OTel: task-span rollup only, never a second LLM span / token metric.
      applyUsageSummaryToActiveSpan(summary);
    } catch (e) {
      this.warn("accumulator.summary() failed, omitting x-usage from the final event", { error: (e as Error).message });
      summary = undefined;
    }
    await this.terminal("agent_finished", { backend: this.backend, usage: summary ?? null, ...extra });
    return {
      ...(summary ? { summary } : {}),
      meta: summary ? { [X_USAGE_KEY]: summary } : {},
      ...(summary ? { usage: this.coreUsage(summary) } : {}),
    };
  }

  /** The summary as core usage; the per-model breakdown of cumulative readings (exact per model) replaces the one derived from the calls. */
  private coreUsage(summary: UsageTelemetryData): CoreUsage {
    const usage = usageSummaryToCoreUsage(summary);
    return Object.keys(this.deltaByModel).length > 0 ? { ...usage, byModel: { ...this.deltaByModel } } : usage;
  }

  /** The turn failed: `agent_error` with the usage spent so far (`null` when no call was made). */
  async error(message: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.terminal("agent_error", { backend: this.backend, message, usage: this.usageIfAny(), ...extra });
  }

  /** The turn was canceled (core published `canceled`): one `agent_error` for collectors, with the usage so far. */
  canceled(): Promise<void> {
    return this.error("Task canceled");
  }

  private async terminal(type: "agent_finished" | "agent_error", data: Record<string, unknown>): Promise<void> {
    if (this.closed) return; // exactly one terminal lifecycle event per turn
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.warn("Event transport slow; not waiting further for terminal event", { type, timeoutMs: this.terminalTimeoutMs });
        resolve();
      }, this.terminalTimeoutMs);
    });
    try {
      await Promise.race([this.emitter.emit(type, data), cap]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Usage totals in core's shape: scope `delta` (the turn), counters summed, cost null when never reported, `byModel` per model. */
export function usageSummaryToCoreUsage(summary: UsageTelemetryData): CoreUsage {
  const byModel: Record<string, ModelUsage> = {};
  for (const call of summary.calls) {
    const key = call.model || "unknown";
    const m = (byModel[key] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, costUsd: null });
    m.input = (m.input ?? 0) + call.inputTokens;
    m.output = (m.output ?? 0) + call.outputTokens;
    m.cacheRead = (m.cacheRead ?? 0) + call.cacheReadTokens;
    m.cacheWrite = (m.cacheWrite ?? 0) + call.cacheWriteTokens;
    m.reasoning = (m.reasoning ?? 0) + call.reasoningTokens;
    m.total = (m.total ?? 0) + call.inputTokens + call.outputTokens;
    if (call.cost !== null) m.costUsd = (m.costUsd ?? 0) + call.cost;
  }
  const cw = summary.contextWindow;
  return {
    scope: "delta",
    tokens: {
      input: summary.inputTokens,
      output: summary.outputTokens,
      cacheRead: summary.cacheReadTokens,
      cacheWrite: summary.cacheWriteTokens,
      reasoning: summary.reasoningTokens,
      total: summary.inputTokens + summary.outputTokens,
    },
    costUsd: summary.cost,
    ...(cw ? { contextWindow: { used: cw.currentTokens, ...(cw.tokenLimit !== null ? { limit: cw.tokenLimit } : {}) } } : {}),
    ...(Object.keys(byModel).length > 0 ? { byModel } : {}),
  };
}

/**
 * The response artifact of a turn. With `chunks`, text arrives as it is produced: every delta is an appended chunk of
 * one artifact `response-<uuid>` named `response`, and {@link ResponseStream.finish} closes it with a last-chunk marker that carries the
 * full text (a consumer that missed earlier chunks can rebuild it). Without, nothing is sent until `finish`, which
 * publishes one buffered artifact. Same artifacts as `publishStreamingChunk` / `publishLastChunkMarker` /
 * `publishFinalArtifact` publish on a bus.
 */
export interface ResponseStream {
  /** The artifact id. */
  readonly id: string;
  /** A text delta; sent only when chunks are on. */
  delta(text: string): void;
  /** The turn's final text, plus optional structured data as an additive JSON data part after the text. */
  finish(fullText: string, structured?: unknown): void;
}

export function createResponseStream(
  run: Pick<CoreTaskRun, "artifact">,
  options: { chunks: boolean; /** The artifact id. Default `response-<uuid>`. A wrapper whose artifact ids are part of its contract names them. */ id?: string },
): ResponseStream {
  const id = options.id ?? `response-${uuidv4()}`;
  const parts = (text: string, structured?: unknown): CoreArtifact["parts"] => {
    const out: CoreArtifact["parts"][number][] = [{ kind: "text", text }];
    if (typeof structured === "object" && structured !== null && !Array.isArray(structured)) {
      out.push({ kind: "data", data: structured, meta: { mimeType: "application/json" } });
    }
    return out;
  };
  return {
    id,
    delta(text) {
      if (!options.chunks || !text) return;
      run.artifact({ id, name: "response", parts: [{ kind: "text", text }], append: true, lastChunk: false });
    },
    finish(fullText, structured) {
      run.artifact({
        id,
        name: "response",
        parts: parts(fullText, structured),
        append: options.chunks,
        lastChunk: true,
      });
    },
  };
}
