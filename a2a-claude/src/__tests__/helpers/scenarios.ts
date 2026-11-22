/**
 * Scripted Claude sessions shared by the golden parity test and the recorder that produced its fixture.
 *
 * A scenario is what the Claude Agent SDK would emit for one prompt, as data (the messages a `query()` yields). The fixture
 * (`../golden/old-executor.golden.json`) was recorded by running the SAME scenarios through the executor that existed before
 * the provider migration (the `AgentExecutor` of a2a-claude 0.4.1, on `integration/core-boundary-impl` at 4041054, which only
 * differs from 4a5869b in core) and the real SDK request handler; the parity test replays them through the provider.
 */

import { DEFAULTS } from "../../config/defaults.js";
import type { SDKMessageLike } from "../../claude/client-factory.js";
import type { FakeTurnScript } from "./fake-client.js";

export interface Scenario {
  name: string;
  script: FakeTurnScript;
  /** Config overrides. */
  chunks?: boolean;
  events?: boolean;
  holdFlag?: boolean;
  promptTimeoutMs?: number;
}

const init: SDKMessageLike = { type: "system", subtype: "init", session_id: "sess-g", model: "claude-test" };

const text = (t: string): SDKMessageLike => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: t }] } });

const delta = (t: string): SDKMessageLike => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_delta", delta: { type: "text_delta", text: t } },
});

const tool = (name: string, input: Record<string, unknown>, id: string): SDKMessageLike => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_use", id, name, input }] },
});

const toolResult = (id: string, content: unknown, is_error = false): SDKMessageLike => ({
  type: "user",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
});

const result = (t: string, over: Record<string, unknown> = {}): SDKMessageLike => ({
  type: "result",
  subtype: "success",
  result: t,
  usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
  total_cost_usd: 0.0123,
  num_turns: 3,
  session_id: "sess-g",
  ...over,
});

const bg = (...ids: string[]): SDKMessageLike => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: ids.map((id) => ({ task_id: id, task_type: "shell", description: `task ${id}` })),
});

/** Far in the future so the tracker keeps it and the text is the same on every run. */
const RESETS_AT = 4_102_444_800_000;
const REJECTED: SDKMessageLike = {
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: RESETS_AT, utilization: 1 },
};

const rich: SDKMessageLike[] = [
  init,
  { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "thinking", thinking: "let me think, password=hunter2" }] } },
  tool("Bash", { command: "echo token=abc123 && ls" }, "tu1"),
  toolResult("tu1", "file-a\nfile-b"),
  tool("mcp__probe__secret_word", {}, "tu2"),
  toolResult("tu2", [{ type: "text", text: "PINEAPPLE" }]),
  tool("mcp__a2a-subagents__helper", { q: "x" }, "tu3"),
  toolResult("tu3", "delegated answer"),
  tool("Edit", { file_path: "/w/a.ts" }, "tu4"),
  tool("Write", { file_path: "/w/b.ts" }, "tu5"),
  tool("TodoWrite", { todos: [{ content: "step one", status: "completed" }, { content: "step two", status: "pending" }] }, "tu6"),
  tool("Read", { file_path: "/w/c.ts" }, "tu7"),
  toolResult("tu7", "boom", true),
  { type: "system", subtype: "permission_denied", tool_name: "Bash", message: "Permission to use Bash was denied" },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.2 } },
  text("Hello world"),
  result("Hello world"),
];

export const SCENARIOS: Scenario[] = [
  { name: "buffered-rich", script: { messages: rich } },
  { name: "chunks-rich", chunks: true, script: { messages: [...rich.slice(0, 15), delta("Hello "), delta("world"), text("Hello world"), result("Hello world")] } },
  { name: "events-off", events: false, script: { messages: rich } },
  { name: "structured-output", script: { messages: [init, text('{"answer":"42"}'), result('{"answer":"42"}', { structured_output: { answer: "42" } })] } },
  {
    name: "error-max-turns",
    script: { messages: [init, text("partial"), { type: "result", subtype: "error_max_turns", errors: ["api_key=sk-secret reached"], num_turns: 5, is_error: true }] },
  },
  { name: "error-during-execution", script: { messages: [init, { type: "result", subtype: "error_during_execution", errors: [], num_turns: 1 }] } },
  {
    name: "model-refusal-no-fallback",
    script: {
      messages: [init, { type: "system", subtype: "model_refusal_no_fallback", original_model: "m", content: "detailed internal refusal text" }, result("")],
    },
  },
  { name: "empty-result-text", script: { messages: [init, result("")] } },
  { name: "no-usage-in-result", script: { messages: [init, { type: "result", subtype: "success", result: "ok", session_id: "sess-g" }] } },
  { name: "held-two-rounds", script: { messages: [init, bg("bg1"), result("build started"), bg(), result("build passed")] } },
  {
    name: "held-two-rounds-chunks",
    chunks: true,
    script: { messages: [init, bg("bg1"), delta("build "), delta("started"), result("build started"), bg(), delta("build passed"), result("build passed")] },
  },
  { name: "held-three-rounds", script: { messages: [init, bg("bg1"), result("one"), bg(), bg("bg2"), result("two"), bg(), result("three")] } },
  { name: "held-flag-off", holdFlag: false, script: { messages: [init, bg("bg1"), result("build started"), bg(), result("never read")] } },
  { name: "held-iterator-ends", script: { messages: [init, bg("bg1"), result("still waiting")] } },
  { name: "held-timeout", promptTimeoutMs: 50, script: { messages: [init, bg("bg1"), result("waiting")], hangUntilInputClosed: true } },
  { name: "held-error-result", script: { messages: [init, bg("bg1"), result("round one"), { type: "result", subtype: "error_max_budget_usd", errors: [], num_turns: 2 }] } },
  { name: "rate-limit-rejected", script: { messages: [init, text("partial"), REJECTED], hangAfter: true } },
  { name: "rate-limit-rejected-chunks-in-flight", chunks: true, script: { messages: [init, delta("partial "), REJECTED], hangAfter: true } },
  { name: "rate-limit-warning-completes", script: { messages: [init, { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.9 } }, result("finished anyway")] } },
  {
    name: "assistant-rate-limit-error",
    script: { messages: [init, { type: "assistant", error: "rate_limit", parent_tool_use_id: null, message: { content: [] } }], hangAfter: true },
  },
  { name: "prompt-timeout", promptTimeoutMs: 50, script: { messages: [init], hangAfter: true } },
  { name: "iterator-throws", script: { messages: [init, text("partial")], throwAfter: "Claude Code process exited with code 1 (api_key=sk-secret)" } },
  { name: "no-messages", script: { messages: [] } },
];

/** The config the executor / provider is built with for a scenario. */
export function configFor(s: Scenario, workspace: string): any {
  const config = JSON.parse(JSON.stringify({ ...DEFAULTS, configDir: workspace }));
  config.agentCard = { ...config.agentCard, name: "Golden Agent", description: "g" };
  config.claude.workingDirectory = workspace;
  config.claude.model = "claude-test-model";
  config.features.streamArtifactChunks = s.chunks === true;
  if (s.holdFlag === false) config.features.holdTaskForBackgroundWork = false;
  config.events = s.events === false ? { enabled: false } : { enabled: true, transport: "a2a" };
  if (s.promptTimeoutMs !== undefined) config.timeouts = { prompt: s.promptTimeoutMs };
  return config;
}
