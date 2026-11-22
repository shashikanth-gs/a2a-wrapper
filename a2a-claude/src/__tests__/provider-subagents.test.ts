/**
 * Sub-agent bridge path coverage — kept in its own file because vi.mock hoists module replacement to the top of the file.
 * Mocking "@a2a-wrapper/core" here (with only bootstrapSubAgents replaced, via importOriginal) would otherwise leak into
 * every other test in provider.test.ts that imports from the same module graph.
 */
import { describe, it, expect, vi } from "vitest";
import { useWorkspace } from "./helpers/harness.js";

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

// Imports below the mock so the mocked module graph is in place before the provider (and anything it imports) is evaluated.
const { serve, streamText } = await import("./helpers/harness.js");
const { happyTurn } = await import("./helpers/fake-client.js");

const ctx = useWorkspace("a2a-claude-subagents-ws-");

function withSubAgents(): void {
  ctx.config.subAgents = {
    agents: [{ name: "helper", agentCardUrl: "http://fake.invalid/card.json" }],
  } as typeof ctx.config.subAgents;
}

describe("ClaudeProvider sub-agents bridge merge", () => {
  it("merges the synthesized bridge entry into options.mcpServers under 'a2a-subagents'", async () => {
    withSubAgents();
    const { server, client } = serve(ctx.config, [happyTurn("sess-1", "hello world")]);

    await streamText(server);

    expect(client.calls[0].options.mcpServers?.["a2a-subagents"]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "a2a-mcp-skillmap"],
      env: { A2A_AGENTS: "[]" },
    });
  });

  it("preserves a user-supplied MCP entry alongside the bridge entry", async () => {
    withSubAgents();
    ctx.config.mcp = { tools: { type: "stdio", command: "x" } };
    const { server, client } = serve(ctx.config, [happyTurn("sess-1", "hello world")]);

    await streamText(server);

    const mcpServers = client.calls[0].options.mcpServers;
    expect(mcpServers?.["tools"]).toEqual({ type: "stdio", command: "x" });
    expect(mcpServers?.["a2a-subagents"]).toBeDefined();
  });

  it("delivers MCP servers in the initialize request (argv delivery is deprecated)", async () => {
    withSubAgents();
    const { server, client } = serve(ctx.config, [happyTurn("sess-1", "hello world")]);

    await streamText(server);

    expect(client.calls[0].options.mcpServersDelivery).toBe("initialize");
  });
});
