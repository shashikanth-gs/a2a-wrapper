/**
 * Test fakes for ClaudeClientLike / QueryLike.
 */

import type { ClaudeClientLike, QueryLike, QueryOptionsLike, SDKMessageLike } from "../client-factory.js";

export interface FakeCall {
  prompt: string;
  options: QueryOptionsLike;
}

export interface FakeTurnScript {
  /** Messages yielded in order. */
  messages: SDKMessageLike[];
  /** Delay (ms) before each message. */
  delayMs?: number;
  /** After yielding messages, hang until aborted (for cancel/timeout tests). */
  hangAfter?: boolean;
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

class FakeQuery implements QueryLike {
  public interrupted = false;
  constructor(private script: FakeTurnScript, private signal?: AbortSignal) {}

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessageLike> {
    for (const msg of this.script.messages) {
      if (this.signal?.aborted) throw abortError();
      if (this.script.delayMs) await new Promise((r) => setTimeout(r, this.script.delayMs));
      if (this.signal?.aborted) throw abortError();
      yield msg;
    }
    if (this.script.hangAfter) {
      await new Promise<never>((_, reject) => {
        if (this.signal?.aborted) return reject(abortError());
        this.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
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

  runQuery(prompt: string, options: QueryOptionsLike): QueryLike {
    this.calls.push({ prompt, options });
    const script = this.scripts[Math.min(this.calls.length - 1, this.scripts.length - 1)];
    const q = new FakeQuery(script, options.abortController?.signal);
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
