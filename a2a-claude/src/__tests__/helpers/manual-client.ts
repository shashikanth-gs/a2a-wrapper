/**
 * A Claude client the test drives by hand: nothing happens until the test `emit`s the messages a CLI would send, and what the
 * provider pushed into the query's input stream (the prompt, steered messages) is recorded. For the steering, abort,
 * interaction and session tests.
 */

import type {
  ClaudeClientLike,
  QueryLike,
  QueryOptionsLike,
  SDKMessageLike,
  SDKUserMessageLike,
} from "../../claude/client-factory.js";

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

export class ManualQuery implements QueryLike {
  /** What the provider pushed into the input stream, in order. */
  readonly inputs: SDKUserMessageLike[] = [];
  interrupts = 0;
  /** True once the provider closed the input stream. */
  inputClosed = false;
  /** Ignore the abort signal and the end of input (a CLI that does not answer). */
  stubborn = false;
  /** Called by `interrupt()`: a test may end the turn like the CLI does (an error result). */
  onInterrupt?: () => void;

  private readonly buffer: SDKMessageLike[] = [];
  private waiter: ((r: IteratorResult<SDKMessageLike>) => void) | undefined;
  private rejecter: ((e: Error) => void) | undefined;
  private ended = false;
  private failure: Error | undefined;

  constructor(
    prompt: AsyncIterable<SDKUserMessageLike>,
    readonly options: QueryOptionsLike,
  ) {
    void (async () => {
      try {
        for await (const m of prompt) this.inputs.push(m);
      } catch {
        /* a rejected input stream is not something the provider should do */
      }
      this.inputClosed = true;
    })();
    options.abortController?.signal.addEventListener("abort", () => {
      if (!this.stubborn) this.fail(abortError());
    });
  }

  /** What the CLI says next. */
  emit(...msgs: SDKMessageLike[]): this {
    for (const m of msgs) {
      const w = this.waiter;
      if (w) {
        this.waiter = undefined;
        this.rejecter = undefined;
        w({ value: m, done: false });
      } else this.buffer.push(m);
    }
    return this;
  }

  /** The CLI exits cleanly. */
  end(): void {
    this.ended = true;
    const w = this.waiter;
    if (w && this.buffer.length === 0) {
      this.waiter = undefined;
      this.rejecter = undefined;
      w({ value: undefined, done: true });
    }
  }

  fail(e: Error): void {
    this.failure = e;
    const r = this.rejecter;
    if (r) {
      this.waiter = undefined;
      this.rejecter = undefined;
      r(e);
    }
  }

  async interrupt(): Promise<unknown> {
    this.interrupts++;
    this.onInterrupt?.();
    return { still_queued: [] };
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessageLike> {
    return {
      next: () => {
        const m = this.buffer.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiter = resolve;
          this.rejecter = reject;
        });
      },
      return: async () => {
        this.end();
        return { value: undefined, done: true };
      },
    };
  }
}

export class ManualClient implements ClaudeClientLike {
  readonly queries: ManualQuery[] = [];
  /** Called with every new query (and its index), so a test can script the CLI's answer to a prompt. */
  onQuery?: (q: ManualQuery, n: number) => void;
  /** Answer for `sessionExists`; omit the method by leaving this undefined. */
  existing?: Set<string>;

  runQuery(prompt: string | AsyncIterable<SDKUserMessageLike>, options: QueryOptionsLike): QueryLike {
    const stream: AsyncIterable<SDKUserMessageLike> =
      typeof prompt === "string"
        ? (async function* () {
            yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: prompt } } as SDKUserMessageLike;
          })()
        : prompt;
    const q = new ManualQuery(stream, options);
    this.queries.push(q);
    this.onQuery?.(q, this.queries.length - 1);
    return q;
  }

  sessionExists = async (id: string): Promise<boolean> => this.existing?.has(id) ?? false;
}

export const init = (sessionId: string, extra: Record<string, unknown> = {}): SDKMessageLike => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model: "claude-test",
  ...extra,
});

export const text = (t: string): SDKMessageLike => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: t }] } });

export const result = (t: string, over: Record<string, unknown> = {}): SDKMessageLike => ({
  type: "result",
  subtype: "success",
  result: t,
  usage: { input_tokens: 10, output_tokens: 5 },
  total_cost_usd: 0.01,
  num_turns: 1,
  queued_turn_count: 0,
  ...over,
});

export const lifecycle = (uuid: string, state: "queued" | "started" | "completed" | "cancelled"): SDKMessageLike => ({
  type: "command_lifecycle",
  command_uuid: uuid,
  state,
  uuid: `lc-${uuid}-${state}`,
});

/** The CLI's end of a turn that was interrupted: an error result, as the real one sends. */
export const interruptedResult = (): SDKMessageLike => ({
  type: "result",
  subtype: "error_during_execution",
  errors: [],
  terminal_reason: "aborted_tools",
  usage: {},
  total_cost_usd: 0,
  num_turns: 1,
});
