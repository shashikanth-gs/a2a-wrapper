/**
 * LLM Usage and Cost Telemetry — core types and accumulator.
 *
 * This module is source-agnostic: it has no imports from `@github/copilot-sdk`
 * or any other wrapper-specific package. Field names align with the
 * OpenTelemetry Generative AI Semantic Conventions (OTel GenAI semconv).
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

/**
 * A single LLM API call record capturing per-call token counts, latency,
 * model, and call metadata.
 *
 * All fields are required. Nullable fields use `field: T | null` syntax —
 * never `field?: T` — so that the JSON serialization is always predictable.
 *
 * OTel GenAI semconv alignment:
 *   inputTokens       → gen_ai.usage.input_tokens
 *   outputTokens      → gen_ai.usage.output_tokens
 *   cacheReadTokens   → gen_ai.usage.cache_read_input_tokens
 *   cacheWriteTokens  → gen_ai.usage.cache_creation_input_tokens
 *   reasoningTokens   → gen_ai.usage.reasoning_tokens (extension)
 *   model             → gen_ai.request.model
 */
export interface UsageCallRecord {
  /** The model name used for this call (e.g. "gpt-4.1", "claude-sonnet-4.5"). Aligns with gen_ai.request.model. */
  model: string;

  /** Prompt/input tokens consumed. Aligns with gen_ai.usage.input_tokens. */
  inputTokens: number;

  /** Completion/output tokens generated. Aligns with gen_ai.usage.output_tokens. */
  outputTokens: number;

  /**
   * Prompt cache read tokens (cache hit). 0 when no cache was used.
   * Aligns with gen_ai.usage.cache_read_input_tokens.
   */
  cacheReadTokens: number;

  /**
   * Prompt cache write tokens (cache miss, new cache entry created). 0 when not applicable.
   * Aligns with gen_ai.usage.cache_creation_input_tokens.
   */
  cacheWriteTokens: number;

  /**
   * Tokens used for internal reasoning (e.g. o-series models). 0 when not applicable.
   */
  reasoningTokens: number;

  /** Total call duration in milliseconds from request to last token. */
  durationMs: number;

  /**
   * Time from request to first token in milliseconds.
   * null when not reported by the provider.
   */
  timeToFirstTokenMs: number | null;

  /**
   * Provider-supplied billing weight for this call.
   *
   * - 0 is a valid value (Copilot-native quota, multiplier applies)
   * - null means the provider did not report a cost for this call
   *
   * Never absent in the schema: always `number | null`, never `number | null | undefined`.
   */
  cost: number | null;

  /**
   * API endpoint URL used for this call.
   * null when not reported by the provider.
   */
  apiEndpoint: string | null;

  /**
   * Identifier of the call initiator (e.g. agent name, tool name).
   * null when not reported by the provider.
   */
  initiator: string | null;
}

/**
 * Point-in-time snapshot of context window token fill.
 *
 * Emitted by the SDK after each turn as `session.usage_info`.
 * All fields are required; nullable fields are null when not reported.
 */
export interface ContextWindowSnapshot {
  /** Total tokens currently occupying the context window. */
  currentTokens: number;

  /**
   * Maximum context window capacity.
   * null when the provider does not report a limit.
   */
  tokenLimit: number | null;

  /**
   * Tokens consumed by the conversation history.
   * null when not broken down by the provider.
   */
  conversationTokens: number | null;

  /**
   * Tokens consumed by the system prompt.
   * null when not broken down by the provider.
   */
  systemTokens: number | null;

  /**
   * Tokens consumed by tool/MCP server definitions.
   * null when not broken down by the provider.
   */
  toolDefinitionsTokens: number | null;

  /**
   * Number of messages in the context window.
   * null when not reported by the provider.
   */
  messagesLength: number | null;
}

/**
 * Aggregated usage summary for one task execution.
 *
 * Produced by LlmUsageAccumulator.summary(). This is the object placed
 * under metadata["x-usage"] on the final TaskStatusUpdateEvent.
 *
 * All numeric total fields are required and initialized to 0. The cost
 * and model fields are required but nullable (null when no calls were made
 * or no cost was reported). contextWindow is optional and omitted when
 * no session.usage_info event was received.
 */
export interface UsageTelemetryData {
  /** Sum of inputTokens across all recorded calls. */
  inputTokens: number;

  /** Sum of outputTokens across all recorded calls. */
  outputTokens: number;

  /** Sum of cacheReadTokens across all recorded calls. */
  cacheReadTokens: number;

  /** Sum of cacheWriteTokens across all recorded calls. */
  cacheWriteTokens: number;

  /** Sum of reasoningTokens across all recorded calls. */
  reasoningTokens: number;

  /** Sum of durationMs across all recorded calls. */
  durationMs: number;

  /** Total number of LLM API calls recorded. */
  llmCalls: number;

  /**
   * Model name from the most recently recorded call.
   * null when no calls have been recorded.
   */
  model: string | null;

  /**
   * Arithmetic sum of all non-null cost values from recorded calls.
   * null when all recorded calls have cost: null or no calls were made.
   * 0 is a valid value (non-null cost values may be 0).
   *
   * Required field (not optional): always present in JSON serialization.
   */
  cost: number | null;

  /** Copy of all individual call records in recording order. */
  calls: UsageCallRecord[];

  /**
   * Most recent context-window snapshot.
   * Present only when at least one session.usage_info event was received.
   * Omitted (not null) when absent — callers should use `"contextWindow" in data`
   * to check presence.
   */
  contextWindow?: ContextWindowSnapshot;
}

/**
 * Accumulates per-call LLM usage data into a session-level summary.
 *
 * One instance is created per execute() call via:
 *   const accumulator = new LlmUsageAccumulator();
 *
 * The instance is a plain local variable — never stored as a class property
 * of the executor. This guarantees concurrent task isolation.
 *
 * This class has no imports from `@github/copilot-sdk` or any other
 * wrapper-specific package; it is source-agnostic.
 */
export class LlmUsageAccumulator {
  // Running totals — initialized to 0
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private reasoningTokens = 0;
  private durationMs = 0;
  private llmCalls = 0;

  // Nullable fields
  private lastModel: string | null = null;
  private totalCost: number | null = null;

  // Per-call log (in recording order)
  private callLog: UsageCallRecord[] = [];

  // Context window — replaced on each setContextWindow() call
  private contextWindow?: ContextWindowSnapshot;

  /**
   * Record a single LLM API call.
   *
   * Appends the record to the call log and updates all running totals.
   * Called once per assistant.usage event.
   */
  record(callRecord: UsageCallRecord): void {
    this.callLog.push(callRecord);
    this.inputTokens += callRecord.inputTokens;
    this.outputTokens += callRecord.outputTokens;
    this.cacheReadTokens += callRecord.cacheReadTokens;
    this.cacheWriteTokens += callRecord.cacheWriteTokens;
    this.reasoningTokens += callRecord.reasoningTokens;
    this.durationMs += callRecord.durationMs;
    this.llmCalls += 1;
    this.lastModel = callRecord.model;

    if (callRecord.cost !== null) {
      this.totalCost = (this.totalCost ?? 0) + callRecord.cost;
    }
  }

  /**
   * Store (or replace) the most recent context-window snapshot.
   *
   * Calling this more than once replaces the previous snapshot; only
   * the most recent is included in summary().
   */
  setContextWindow(snapshot: ContextWindowSnapshot): void {
    this.contextWindow = snapshot;
  }

  /**
   * Produce a complete UsageTelemetryData summary.
   *
   * Returns a new object on each call — callers may safely cache or
   * serialize the result without affecting accumulator state.
   */
  summary(): UsageTelemetryData {
    const result: UsageTelemetryData = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      reasoningTokens: this.reasoningTokens,
      durationMs: this.durationMs,
      llmCalls: this.llmCalls,
      model: this.lastModel,
      cost: this.totalCost,
      calls: [...this.callLog], // shallow copy preserves order
    };

    if (this.contextWindow !== undefined) {
      result.contextWindow = this.contextWindow;
    }

    return result;
  }
}
