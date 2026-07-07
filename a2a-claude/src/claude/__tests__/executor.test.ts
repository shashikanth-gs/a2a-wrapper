import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeExecutor } from "../executor.js";
import { FakeClaudeClient, happyTurn } from "./fake-client.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";

// ─── Test doubles ────────────────────────────────────────────────────────────

interface PublishedEvent { kind?: string; status?: { state?: string }; [k: string]: unknown }

function makeBus() {
  const events: PublishedEvent[] = [];
  let finishedCount = 0;
  const bus = {
    publish: (e: PublishedEvent) => { events.push(e); },
    finished: () => { finishedCount++; },
    on: () => bus, off: () => bus, once: () => bus, removeAllListeners: () => bus,
  } as unknown as ExecutionEventBus;
  return { bus, events, finished: () => finishedCount };
}

function makeCtx(taskId: string, contextId: string, text = "do the thing"): RequestContext {
  return {
    taskId,
    contextId,
    task: undefined,
    userMessage: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "text", text }] },
  } as unknown as RequestContext;
}

function states(events: PublishedEvent[]): string[] {
  return events
    .filter((e) => e.kind === "status-update")
    .map((e) => (e.status?.state ?? "") as string);
}

// ─── Setup ───────────────────────────────────────────────────────────────────

let ws: string;
let config: Required<AgentConfig>;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "a2a-claude-ws-"));
  config = JSON.parse(JSON.stringify({ ...DEFAULTS, configDir: ws })) as Required<AgentConfig>;
  config.claude.workingDirectory = ws;
  config.events = { enabled: false } as Required<AgentConfig>["events"];
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ClaudeExecutor.execute", () => {
  it("publishes submitted → working → artifact → completed", async () => {
    const client = new FakeClaudeClient([happyTurn("sess-1", "hello world")]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "completed"]);
    const artifact = events.find((e) => e.kind === "artifact-update") as Record<string, unknown>;
    expect(JSON.stringify(artifact)).toContain("hello world");
    expect(finished()).toBe(1);
    expect(client.calls[0].options.cwd).toBe(ws);
    expect(client.calls[0].options.resume).toBeUndefined();
  });

  it("threads the captured session id into the next turn's resume", async () => {
    const client = new FakeClaudeClient([happyTurn("sess-1", "one"), happyTurn("sess-1", "two")]);
    const ex = new ClaudeExecutor(config, () => client);

    await ex.execute(makeCtx("t1", "ctx-1"), makeBus().bus);
    await ex.execute(makeCtx("t2", "ctx-1"), makeBus().bus);

    expect(client.calls[1].options.resume).toBe("sess-1");
  });

  it("serializes concurrent tasks on the same context", async () => {
    const client = new FakeClaudeClient([
      { ...happyTurn("s", "one"), delayMs: 30 },
      happyTurn("s", "two"),
    ]);
    const ex = new ClaudeExecutor(config, () => client);
    const b1 = makeBus(); const b2 = makeBus();

    const p1 = ex.execute(makeCtx("t1", "ctx-1"), b1.bus);
    const p2 = ex.execute(makeCtx("t2", "ctx-1"), b2.bus);
    await Promise.all([p1, p2]);

    // Task 2's terminal event must come after task 1's (serialized queue).
    expect(states(b1.events)).toContain("completed");
    expect(states(b2.events)).toContain("completed");
    expect(client.calls.length).toBe(2);
  });

  it("publishes failed with a sanitized message on result error", async () => {
    const client = new FakeClaudeClient([{
      messages: [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        { type: "result", subtype: "error_max_turns", errors: [], num_turns: 5, is_error: true },
      ],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);
    expect(states(events)).toContain("failed");
  });

  it("publishes failed on a model refusal without echoing refusal details", async () => {
    const client = new FakeClaudeClient([{
      messages: [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        { type: "system", subtype: "model_refusal_no_fallback", original_model: "m", content: "detailed internal refusal text" },
        { type: "result", subtype: "success", result: "", usage: {}, total_cost_usd: 0, num_turns: 1 },
      ],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);
    expect(states(events)).toContain("failed");
    expect(JSON.stringify(events)).not.toContain("detailed internal refusal text");
  });

  it("fails the task when the prompt timeout elapses", async () => {
    config.timeouts = { prompt: 50 };
    const client = new FakeClaudeClient([{ messages: [], hangAfter: true }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);
    expect(states(events)).toContain("failed");
  });
});

describe("ClaudeExecutor.cancelTask", () => {
  it("aborts the running query and publishes canceled without failed", async () => {
    const client = new FakeClaudeClient([{ messages: [{ type: "system", subtype: "init", session_id: "s", model: "m" }], hangAfter: true }]);
    const ex = new ClaudeExecutor(config, () => client);
    const run = makeBus();
    const cancel = makeBus();

    const p = ex.execute(makeCtx("t1", "ctx-1"), run.bus);
    await new Promise((r) => setTimeout(r, 20));
    await ex.cancelTask("t1", cancel.bus);
    await p;

    expect(states(cancel.events)).toContain("canceled");
    expect(states(run.events)).not.toContain("failed");
    expect(client.queries[0].interrupted).toBe(true);
  });
});

describe("ClaudeExecutor validation", () => {
  it("rejects a missing workingDirectory", async () => {
    config.claude.workingDirectory = "";
    const ex = new ClaudeExecutor(config, () => new FakeClaudeClient([happyTurn("s", "x")]));
    await expect(ex.initialize()).rejects.toThrow(/workingDirectory/);
  });

  it("rejects a nonexistent workingDirectory", async () => {
    config.claude.workingDirectory = join(ws, "does-not-exist");
    const ex = new ClaudeExecutor(config, () => new FakeClaudeClient([happyTurn("s", "x")]));
    await expect(ex.initialize()).rejects.toThrow(/does not exist/);
  });

  it("rejects permissionMode default", async () => {
    (config.claude as Record<string, unknown>).permissionMode = "default";
    const ex = new ClaudeExecutor(config, () => new FakeClaudeClient([happyTurn("s", "x")]));
    await expect(ex.initialize()).rejects.toThrow(/interactive|headless/i);
  });

  it("rejects bypassPermissions without the explicit opt-in flag", async () => {
    config.claude.permissionMode = "bypassPermissions";
    config.claude.dangerouslyAllowBypassPermissions = false;
    const ex = new ClaudeExecutor(config, () => new FakeClaudeClient([happyTurn("s", "x")]));
    await expect(ex.initialize()).rejects.toThrow(/dangerouslyAllowBypassPermissions/);
  });

  it("rejects both customSystemPrompt and systemPromptAppend", async () => {
    config.claude.customSystemPrompt = "a";
    config.claude.systemPromptAppend = "b";
    const ex = new ClaudeExecutor(config, () => new FakeClaudeClient([happyTurn("s", "x")]));
    await expect(ex.initialize()).rejects.toThrow(/mutually exclusive/i);
  });
});

describe("ClaudeExecutor.buildContext", () => {
  it("runs a read-only turn and writes the context file", async () => {
    const client = new FakeClaudeClient([happyTurn("s", "# Repo overview")]);
    const ex = new ClaudeExecutor(config, () => client);

    const text = await ex.buildContext();

    expect(text).toBe("# Repo overview");
    expect(client.calls[0].options.permissionMode).toBe("plan");
    expect(client.calls[0].options.disallowedTools).toEqual(
      expect.arrayContaining(["Write", "Edit", "NotebookEdit", "Bash"]),
    );
    expect(await ex.getContextContent()).toBe("# Repo overview");
  });
});
