/**
 * Scripted Codex threads for the golden-parity test: each scenario is the sequence of `ThreadEvent`s a fake thread streams
 * (what `codex exec --experimental-json` would emit), plus how the stream ends. The same scenarios were recorded through the
 * OLD `CodexExecutor` (see `golden/README.md`) and are replayed through `CodexProvider`.
 *
 * Only the thread and client are faked: everything else (event mapping, artifacts, usage, the A2A handler) is real.
 */

import { tmpdir } from "node:os";
import type { CodexClientLike, CodexThreadLike, ThreadEventLike, ThreadOptionsLike } from "../../codex/client-factory.js";

export interface Scenario {
  name: string;
  events: ThreadEventLike[];
  /** The stream throws this message after its events (the SDK throws when the CLI exits non-zero). */
  throwAfter?: string;
  /** `runStreamed` itself rejects with this message (the CLI could not be spawned). */
  throwBefore?: string;
  features?: Record<string, boolean>;
  webSearchMode?: "disabled" | "cached" | "live";
  events_config?: { enabled: boolean; transport: string };
}

export const THREAD_1 = "019a0000-0000-7000-8000-000000000001";
const started: ThreadEventLike[] = [{ type: "thread.started", thread_id: THREAD_1 }, { type: "turn.started" }];
const done = (extra: Record<string, unknown> = {}): ThreadEventLike => ({
  type: "turn.completed",
  usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, ...extra },
});
const message = (id: string, text: string, type = "item.completed"): ThreadEventLike => ({ type, item: { id, type: "agent_message", text } });

export const SCENARIOS: Scenario[] = [
  { name: "plain-answer", events: [...started, message("m1", "Hello there"), done()] },
  {
    name: "streamed-chunks",
    features: { streamArtifactChunks: true },
    events: [
      ...started,
      message("m1", "Hel", "item.updated"),
      message("m1", "Hello wor", "item.updated"),
      message("m1", "Hello wor", "item.updated"),
      message("m1", "Hello world"),
      done(),
    ],
  },
  {
    name: "chunks-on-but-no-message",
    features: { streamArtifactChunks: true },
    events: [...started, done()],
  },
  {
    name: "two-messages-last-wins",
    events: [...started, message("m1", "first"), message("m2", "second"), done()],
  },
  {
    name: "trace-events",
    webSearchMode: "live",
    events: [
      ...started,
      { type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking about it" } },
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls -la " + "x".repeat(600), status: "in_progress", aggregated_output: "" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls", status: "completed", exit_code: 0, aggregated_output: "a\nb\n" + "y".repeat(10_500) } },
      { type: "item.completed", item: { id: "c2", type: "command_execution", command: "false", status: "failed", exit_code: 1, aggregated_output: "token=abc123 secret: s3" } },
      { type: "item.completed", item: { id: "f1", type: "file_change", status: "completed", changes: [{ path: "a.txt", kind: "add" }, { path: "b.txt", kind: "update" }] } },
      { type: "item.updated", item: { id: "t1", type: "todo_list", items: [{ text: "one", completed: true }, { text: "two", completed: false }] } },
      { type: "item.completed", item: { id: "t1", type: "todo_list", items: [{ text: "one", completed: true }, { text: "two", completed: true }] } },
      { type: "item.started", item: { id: "p1", type: "mcp_tool_call", server: "docs", tool: "search", status: "in_progress" } },
      { type: "item.completed", item: { id: "p1", type: "mcp_tool_call", server: "docs", tool: "search", status: "failed", error: { message: "boom api_key=xyz" } } },
      { type: "item.started", item: { id: "p2", type: "mcp_tool_call", server: "a2a-subagents", tool: "delegate", status: "in_progress" } },
      { type: "item.completed", item: { id: "p2", type: "mcp_tool_call", server: "a2a-subagents", tool: "delegate", status: "completed" } },
      { type: "item.started", item: { id: "w1", type: "web_search", query: "weather" } },
      { type: "item.completed", item: { id: "e1", type: "error", message: "non-fatal warning" } },
      message("m1", "done with tools"),
      done(),
    ],
  },
  {
    name: "trace-features-off",
    features: { emitReasoningSummaries: false, emitCommandEvents: false, emitFileChangeEvents: false },
    events: [
      ...started,
      { type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking" } },
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls", status: "in_progress", aggregated_output: "" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls", status: "completed", exit_code: 0, aggregated_output: "a" } },
      { type: "item.completed", item: { id: "f1", type: "file_change", status: "completed", changes: [{ path: "a.txt", kind: "add" }] } },
      { type: "item.started", item: { id: "w1", type: "web_search", query: "weather" } },
      message("m1", "quiet"),
      done(),
    ],
  },
  { name: "no-usage", events: [...started, message("m1", "no usage reported")] },
  { name: "two-turn-usages", events: [...started, message("m1", "twice"), done(), done({ input_tokens: 7 })] },
  { name: "stream-error-event-then-answer", events: [...started, { type: "error", message: "Reconnecting... 1/5 token=abc" }, message("m1", "recovered"), done()] },
  { name: "turn-failed-event", events: [...started, { type: "turn.failed", error: { message: "model overloaded" } }] },
  { name: "cli-exits-nonzero", events: started, throwAfter: "Codex Exec exited with code 1: unauthorized password=hunter2" },
  { name: "cli-cannot-spawn", events: [], throwBefore: "spawn codex ENOENT" },
  { name: "events-disabled", events_config: { enabled: false, transport: "a2a" }, events: [...started, message("m1", "silent"), done()] },
  { name: "empty-answer", events: [...started, message("m1", ""), done()] },
];

export interface FakeThreadRecord {
  id: string | null;
  inputs: string[];
  signals: Array<AbortSignal | undefined>;
  options: ThreadOptionsLike | undefined;
  how: "start" | "resume";
}

/** A thread that streams a scenario's events and records what it was asked. */
export class FakeThread implements CodexThreadLike {
  id: string | null;
  constructor(private readonly scenario: Scenario, readonly record: FakeThreadRecord) {
    this.id = record.id;
  }
  async runStreamed(input: string, opts?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<ThreadEventLike> }> {
    this.record.inputs.push(input);
    this.record.signals.push(opts?.signal);
    const s = this.scenario;
    if (s.throwBefore) throw new Error(s.throwBefore);
    const self = this;
    async function* events(): AsyncGenerator<ThreadEventLike> {
      for (const e of s.events) {
        if (e.type === "thread.started") self.id = e.thread_id as string;
        yield e;
      }
      if (s.throwAfter) throw new Error(s.throwAfter);
    }
    return { events: events() };
  }
  async run(): Promise<never> {
    throw new Error("not used");
  }
}

export class FakeClient implements CodexClientLike {
  readonly threads: FakeThreadRecord[] = [];
  constructor(private readonly scenario: Scenario) {}
  startThread(options?: ThreadOptionsLike): CodexThreadLike {
    const record: FakeThreadRecord = { id: null, inputs: [], signals: [], options, how: "start" };
    this.threads.push(record);
    return new FakeThread(this.scenario, record);
  }
  resumeThread(threadId: string, options?: ThreadOptionsLike): CodexThreadLike {
    const record: FakeThreadRecord = { id: threadId, inputs: [], signals: [], options, how: "resume" };
    this.threads.push(record);
    return new FakeThread(this.scenario, record);
  }
}

/** A full resolved config for a scenario (what `resolveConfig` would produce, trimmed to what the code reads). */
export function configFor(s: Pick<Scenario, "features" | "webSearchMode" | "events_config">, extra: Record<string, unknown> = {}): any {
  return {
    agentCard: { name: "Test Agent", description: "test" },
    server: { port: 3000, hostname: "0.0.0.0", advertiseHost: "localhost", advertiseProtocol: "http" },
    codex: { model: "m", workingDirectory: tmpdir(), sandboxMode: "workspace-write", approvalPolicy: "never", webSearchMode: s.webSearchMode ?? "disabled" },
    session: { reuseByContext: true, ttl: 3_600_000, cleanupInterval: 0 },
    features: { emitReasoningSummaries: true, emitCommandEvents: true, emitFileChangeEvents: true, streamArtifactChunks: false, ...(s.features ?? {}) },
    timeouts: { prompt: 600_000 },
    logging: { level: "error" },
    mcp: {},
    events: s.events_config ?? { enabled: true, transport: "a2a" },
    ...extra,
  };
}
