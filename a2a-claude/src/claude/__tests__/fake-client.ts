/**
 * Test fakes for ClaudeClientLike / QueryLike.
 */

import type {
  ClaudeClientLike,
  QueryLike,
  QueryOptionsLike,
  SDKMessageLike,
  SDKUserMessageLike,
} from "../client-factory.js";

export interface FakeCall {
  prompt: string | AsyncIterable<SDKUserMessageLike>;
  /** Text of the first input message, whichever prompt form was used. */
  promptText: string;
  options: QueryOptionsLike;
  /** True once the executor closed its input stream. Always true for a string prompt. */
  inputClosed: boolean;
  /** Messages the executor pushed into the input stream. */
  inputMessages: SDKUserMessageLike[];
}

export interface FakeTurnScript {
  /** Messages yielded in order. */
  messages: SDKMessageLike[];
  /** Delay (ms) before each message. */
  delayMs?: number;
  /** After yielding messages, hang until aborted (for cancel/timeout tests). */
  hangAfter?: boolean;
  /**
   * Model a real CLI: after the scripted messages, stay alive until the
   * executor closes its input stream, then end the iterator.
   *
   * Opt-in, because the default (end as soon as the script is exhausted) is
   * what most tests want. With this set, an executor that never resolves its
   * input deferred wedges exactly the way a real subprocess would.
   */
  hangUntilInputClosed?: boolean;
  /**
   * On abort, end the iterator cleanly instead of rejecting with an
   * `AbortError`.
   *
   * Opt-in, because rejecting is what the SDK normally does and what every
   * other script here relies on. This models the race where the subprocess
   * happens to close its stream just as the abort lands, so the consumer sees
   * a normal end-of-iteration and none of its abort handling runs.
   */
  endCleanlyOnAbort?: boolean;
  /**
   * Make `iterator.return()` reject — what a consumer's `break` hits when the
   * SDK's teardown fails. A string customizes the error message.
   */
  throwOnReturn?: boolean | string;
  /**
   * Make `iterator.return()` block until the input stream is closed — a
   * transport whose teardown drains its input pump before completing.
   *
   * `break`ing out of a `for await` awaits `iterator.return()`, so under this
   * model a consumer that breaks *without* first closing its input stream
   * deadlocks: its own `finally` — the thing that would close the stream —
   * cannot run until the `break` completes. That is what pins the executor's
   * pre-`break` `inputClosed.resolve()` calls, which are otherwise
   * indistinguishable from the unconditional resolve in its `finally`.
   *
   * Opt-in, because the SDK shipped today does not do this: `Query.return()`
   * awaits `cleanup()` (transport close plus a bounded wait for process exit)
   * and `streamInput` is launched fire-and-forget, so a real `break` cannot
   * block on the input pump. Existing scripts keep the non-blocking default.
   */
  returnAwaitsInputClosed?: boolean;
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

class FakeQuery implements QueryLike {
  public interrupted = false;
  constructor(
    private script: FakeTurnScript,
    private signal?: AbortSignal,
    /** Settles when the executor closes its input stream. */
    private inputClosed: Promise<void> = Promise.resolve(),
  ) {}

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessageLike> {
    const gen = this.generate();
    const failure = this.script.throwOnReturn;
    const drains = this.script.returnAwaitsInputClosed === true;
    if (!failure && !drains) return gen;
    return {
      next: () => gen.next(),
      throw: (e?: unknown) => gen.throw(e),
      return: async (value?: unknown) => {
        // Drain first, then fail: a teardown that hangs never gets as far as
        // reporting an error, and the ordering matters for scripts that set
        // both.
        if (drains) await this.inputClosed;
        const done = await gen.return(value as never).catch(() => ({ done: true, value: undefined }));
        if (failure) {
          throw new Error(typeof failure === "string" ? failure : "iterator teardown failed");
        }
        return done;
      },
    } as AsyncIterator<SDKMessageLike>;
  }

  /**
   * True once aborted — throwing `AbortError` unless the script asked for a
   * clean end, in which case the caller should `return`.
   */
  private abortedNow(): boolean {
    if (!this.signal?.aborted) return false;
    if (this.script.endCleanlyOnAbort) return true;
    throw abortError();
  }

  /**
   * Park until `until` settles, or until abort. Returns "aborted" only when the
   * script opted into a clean end; otherwise abort rejects, as the SDK does.
   */
  private park(until?: Promise<void>): Promise<"settled" | "aborted"> {
    return new Promise<"settled" | "aborted">((resolve, reject) => {
      const onAbort = (): void => {
        if (this.script.endCleanlyOnAbort) resolve("aborted");
        else reject(abortError());
      };
      if (this.signal?.aborted) return onAbort();
      this.signal?.addEventListener("abort", onAbort, { once: true });
      if (until) void until.then(() => resolve("settled"));
    });
  }

  private async *generate(): AsyncGenerator<SDKMessageLike> {
    for (const msg of this.script.messages) {
      if (this.abortedNow()) return;
      if (this.script.delayMs) await new Promise((r) => setTimeout(r, this.script.delayMs));
      if (this.abortedNow()) return;
      yield msg;
    }
    if (this.script.hangUntilInputClosed) {
      // A real CLI exits when its stdin closes, not when it runs out of things
      // to say. Aborting still tears it down mid-wait.
      if ((await this.park(this.inputClosed)) === "aborted") return;
    }
    if (this.script.hangAfter) {
      if ((await this.park()) === "aborted") return;
    }
  }
}

export class FakeClaudeClient implements ClaudeClientLike {
  public calls: FakeCall[] = [];
  public queries: FakeQuery[] = [];
  private scripts: FakeTurnScript[];

  constructor(scripts: FakeTurnScript[]) {
    this.scripts = scripts;
  }

  runQuery(
    prompt: string | AsyncIterable<SDKUserMessageLike>,
    options: QueryOptionsLike,
  ): QueryLike {
    const call: FakeCall = {
      prompt,
      promptText: typeof prompt === "string" ? prompt : "",
      options,
      inputClosed: typeof prompt === "string",
      inputMessages: [],
    };
    this.calls.push(call);

    // A string prompt is closed the moment it is handed over; a stream is not
    // closed until the executor resolves its deferred.
    let markInputClosed!: () => void;
    const inputClosed = new Promise<void>((r) => { markInputClosed = r; });

    // Drain the input stream the way the real SDK does, so tests can assert the
    // executor closed it. The generator parks after its first message, so this
    // loop stays pending until the executor resolves its deferred.
    if (typeof prompt === "string") {
      markInputClosed();
    } else {
      void (async () => {
        try {
          for await (const msg of prompt) {
            call.inputMessages.push(msg);
            if (call.promptText === "") call.promptText = msg.message.content;
          }
        } catch {
          // A rejected input stream is not something the executor should do;
          // swallow it so an unhandled rejection cannot fail an unrelated test.
        }
        call.inputClosed = true;
        markInputClosed();
      })();
    }

    const script = this.scripts[Math.min(this.calls.length - 1, this.scripts.length - 1)];
    const q = new FakeQuery(script, options.abortController?.signal, inputClosed);
    this.queries.push(q);
    return q;
  }
}

/** Standard happy-path turn: init → assistant text → success result. */
export function happyTurn(sessionId: string, text: string): FakeTurnScript {
  return {
    messages: [
      { type: "system", subtype: "init", session_id: sessionId, model: "claude-test" },
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } },
      {
        type: "result", subtype: "success", result: text,
        usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01, num_turns: 1,
        session_id: sessionId,
      },
    ],
  };
}

/** Happy-path turn whose success result also carries structured_output. */
export function structuredTurn(
  sessionId: string,
  text: string,
  structuredOutput: unknown,
): FakeTurnScript {
  return {
    messages: [
      { type: "system", subtype: "init", session_id: sessionId, model: "claude-test" },
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } },
      {
        type: "result", subtype: "success", result: text, structured_output: structuredOutput,
        usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01, num_turns: 1,
        session_id: sessionId,
      },
    ],
  };
}
