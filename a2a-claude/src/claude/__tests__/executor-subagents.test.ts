/**
 * Sub-agent bridge path coverage — kept in its own file because vi.mock
 * hoists module replacement to the top of the file. Mocking
 * "@a2a-wrapper/core" here (with only bootstrapSubAgents replaced, via
 * importOriginal) would otherwise leak into every other test in
 * executor.test.ts that imports from the same module graph.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";

vi.mock("@a2a-wrapper/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@a2a-wrapper/core")>();
  return {
    ...actual,
    bootstrapSubAgents: vi.fn(async () => ({
      descriptor: {
        key: "a2a-subagents",
        command: "npx",
        args: ["-y", "a2a-mcp-skillmap"],
        env: { A2A_AGENTS: "[]" },
      },
      bridgeConfigPath: "/tmp/fake-bridge-config.json",
      probeResults: [],
    })),
  };
});

// Imports below the mock so the mocked module graph is in place before
// executor.js (and anything it imports) is evaluated.
const { ClaudeExecutor } = await import("../executor.js");
const { FakeClaudeClient, happyTurn } = await import("./fake-client.js");

// ─── Test doubles (mirrors executor.test.ts) ────────────────────────────────

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

// ─── Setup ───────────────────────────────────────────────────────────────────

let ws: string;
let config: Required<AgentConfig>;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "a2a-claude-subagents-ws-"));
  config = JSON.parse(JSON.stringify({ ...DEFAULTS, configDir: ws })) as Required<AgentConfig>;
  config.claude.workingDirectory = ws;
  config.events = { enabled: false } as Required<AgentConfig>["events"];
  config.subAgents = {
    agents: [{ name: "helper", agentCardUrl: "http://fake.invalid/card.json" }],
  } as Required<AgentConfig>["subAgents"];
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ClaudeExecutor sub-agents bridge merge", () => {
  it("merges the synthesized bridge entry into options.mcpServers under 'a2a-subagents'", async () => {
    const client = new FakeClaudeClient([happyTurn("sess-1", "hello world")]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(client.calls[0].options.mcpServers?.["a2a-subagents"]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "a2a-mcp-skillmap"],
      env: { A2A_AGENTS: "[]" },
    });
  });

  it("preserves a user-supplied MCP entry alongside the bridge entry", async () => {
    config.mcp = { tools: { type: "stdio", command: "x" } };
    const client = new FakeClaudeClient([happyTurn("sess-1", "hello world")]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    const mcpServers = client.calls[0].options.mcpServers;
    expect(mcpServers?.["tools"]).toEqual({ type: "stdio", command: "x" });
    expect(mcpServers?.["a2a-subagents"]).toBeDefined();
  });
});
