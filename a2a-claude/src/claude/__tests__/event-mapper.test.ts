import { describe, it, expect, beforeEach } from "vitest";
import { EventMapper, sanitizeMessage } from "../event-mapper.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig, FeatureFlags } from "../../config/types.js";
import type { AgentEventEmitter } from "@a2a-wrapper/core";

type Emitted = { event: string; data: Record<string, unknown> };

function makeMapper(features: Partial<FeatureFlags> = {}) {
  const emitted: Emitted[] = [];
  const emitter = {
    emit: (event: string, data: Record<string, unknown>) => { emitted.push({ event, data }); },
  } as unknown as AgentEventEmitter;
  const config = { ...DEFAULTS, features: { ...DEFAULTS.features, ...features } } as Required<AgentConfig>;
  return { mapper: new EventMapper(emitter, config), emitted };
}

const assistantMsg = (blocks: unknown[]) => ({
  type: "assistant",
  message: { content: blocks },
  parent_tool_use_id: null,
});

describe("EventMapper", () => {
  it("emits agent_started on system init", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({ type: "system", subtype: "init", session_id: "s1", model: "m" });
    expect(emitted).toEqual([{ event: "agent_started", data: { backend: "claude", model: "m" } }]);
  });

  it("emits thinking sideband for thinking blocks, gated by emitThinkingEvents", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([{ type: "thinking", thinking: "hmm" }]));
    expect(emitted).toEqual([{ event: "thinking", data: { content: "hmm" } }]);

    const off = makeMapper({ emitThinkingEvents: false });
    off.mapper.handleMessage(assistantMsg([{ type: "thinking", thinking: "hmm" }]));
    expect(off.emitted).toEqual([]);
  });

  it("maps Bash tool_use to a shell tool_call_start with truncated command", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([
      { type: "tool_use", id: "tu1", name: "Bash", input: { command: "x".repeat(600) } },
    ]));
    expect(emitted[0].event).toBe("tool_call_start");
    expect(emitted[0].data.toolKind).toBe("shell");
    expect((emitted[0].data.command as string).length).toBe(500);
    expect(emitted[0].data.itemId).toBe("tu1");
  });

  it("maps mcp__ tool names to server/tool, flagging a2a-subagents delegation", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([
      { type: "tool_use", id: "tu2", name: "mcp__a2a-subagents__coding_review", input: {} },
      { type: "tool_use", id: "tu3", name: "mcp__github__list_prs", input: {} },
    ]));
    expect(emitted[0].data).toMatchObject({
      toolKind: "a2a_subagent", server: "a2a-subagents", tool: "coding_review", delegation: true,
    });
    expect(emitted[1].data).toMatchObject({ toolKind: "mcp", server: "github", tool: "list_prs" });
  });

  it("maps Edit/Write to file_change decisions (path only), gated by emitFileChangeEvents", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([
      { type: "tool_use", id: "t", name: "Edit", input: { file_path: "/ws/a.ts", old_string: "SECRET" } },
      { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/ws/b.ts", content: "data" } },
    ]));
    const changes = emitted.filter((e) => e.event === "decision");
    expect(changes[0].data).toEqual({ backend: "claude", kind: "file_change", changes: [{ path: "/ws/a.ts", kind: "edit" }] });
    expect(changes[1].data).toEqual({ backend: "claude", kind: "file_change", changes: [{ path: "/ws/b.ts", kind: "write" }] });
    // never leak contents
    expect(JSON.stringify(changes)).not.toContain("SECRET");
  });

  it("maps TodoWrite to a todo_list decision", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([
      { type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [
        { content: "step 1", status: "completed" },
        { content: "step 2", status: "pending" },
      ] } },
    ]));
    expect(emitted[0]).toEqual({
      event: "decision",
      data: { backend: "claude", kind: "todo_list", items: [
        { text: "step 1", completed: true },
        { text: "step 2", completed: false },
      ] },
    });
  });

  it("maps tool_result to tool_call_end with truncation and error flag", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [
        { type: "tool_result", tool_use_id: "tu1", content: "y".repeat(20_000), is_error: false },
      ] },
    });
    expect(emitted[0].event).toBe("tool_call_end");
    expect((emitted[0].data.output as string)).toContain("[truncated");
    expect(emitted[0].data.itemId).toBe("tu1");
  });

  it("suppresses tool events when emitToolEvents is false", () => {
    const { mapper, emitted } = makeMapper({ emitToolEvents: false });
    mapper.handleMessage(assistantMsg([{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }]));
    mapper.handleMessage({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
    expect(emitted).toEqual([]);
  });

  it("emits agent_finished with sanitized usage on result success", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({
      type: "result", subtype: "success", result: "done",
      usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.12, num_turns: 3,
    });
    expect(emitted[0]).toEqual({
      event: "agent_finished",
      data: { backend: "claude", usage: { input_tokens: 10, output_tokens: 5 }, totalCostUsd: 0.12, numTurns: 3 },
    });
  });

  it("emits agent_error on result error subtypes", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({ type: "result", subtype: "error_max_turns", errors: [], num_turns: 9 });
    expect(emitted[0].event).toBe("agent_error");
    expect(String(emitted[0].data.message)).toMatch(/max_turns|turn limit/i);
  });

  it("emits a permission_denied decision", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({ type: "system", subtype: "permission_denied", tool_name: "Bash", message: "denied by rule" });
    expect(emitted[0]).toEqual({
      event: "decision",
      data: { backend: "claude", kind: "permission_denied", tool: "Bash", message: "denied by rule" },
    });
  });

  it("ignores subagent (parent_tool_use_id != null) and unknown messages without throwing", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({ ...assistantMsg([{ type: "text", text: "sub" }]), parent_tool_use_id: "tu9" });
    mapper.handleMessage({ type: "totally_new_message_kind" });
    expect(emitted).toEqual([]);
  });

  it("redacts secrets embedded in Bash commands", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([
      { type: "tool_use", id: "t", name: "Bash", input: { command: "export API_KEY=sk-live-123 && run" } },
    ]));
    const cmd = emitted[0].data.command as string;
    expect(cmd).not.toContain("sk-live-123");
    expect(cmd).toContain("<redacted>");
  });

  it("redacts secrets embedded in tool_result output", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: "DB_PASSWORD=hunter2\nother=ok" }] },
    });
    const out = emitted[0].data.output as string;
    expect(out).not.toContain("hunter2");
    expect(out).toContain("<redacted>");
  });
});

describe("sanitizeMessage", () => {
  it("redacts key=value secret patterns and truncates", () => {
    const out = sanitizeMessage("failed with api_key=sk-123 token: abc " + "z".repeat(3000));
    expect(out).not.toContain("sk-123");
    expect(out.length).toBeLessThanOrEqual(2000);
  });
});
