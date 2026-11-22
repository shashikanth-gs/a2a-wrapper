/**
 * Sub-agents wrapper integration smoke test — a2a-copilot
 *
 * Validates the contract between {@link bootstrapSubAgents} and the
 * Copilot wrapper's MCP map: given a minimal `AgentConfig` with one
 * sub-agent, running the bootstrap and translating its descriptor
 * through the same adapter shape used by `CopilotProvider.toCopilotMcpEntry`
 * SHALL produce a `type: "stdio"` entry under the reserved
 * `a2a-subagents` key, wired to `npx a2a-mcp-skillmap@<pinned>` and the
 * generated bridge config path.
 *
 * The adapter on `CopilotProvider` is private. The first two tests exercise
 * the same translation locally — a one-liner — and assert the merged map; the
 * last boots the provider against a faked Copilot client (no CLI is started)
 * and checks the entry reaches the session options. Validates Requirement 5.3.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootstrapSubAgents,
  SKILLMAP_PACKAGE_VERSION,
  SUBAGENTS_MCP_KEY,
  type SynthesizedMcpDescriptor,
} from "@a2a-wrapper/core";

import type {
  AgentConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from "../config/types.js";
import { CopilotProvider } from "../copilot/provider.js";
import { makeConfig } from "./helpers/config.js";
import { ManualClient, ManualSession } from "./helpers/manual-session.js";

// ─── Local copy of the provider's private adapter ───────────────────────────
//
// Mirrors `CopilotProvider.toCopilotMcpEntry`. Kept in sync with that
// implementation by visual inspection — the body is a trivial object
// literal so drift is unlikely. Validating this shape end-to-end is the
// point of this test.
function toCopilotMcpEntry(
  descriptor: SynthesizedMcpDescriptor,
): McpStdioServerConfig {
  return {
    type: "stdio",
    command: descriptor.command,
    args: descriptor.args,
    env: descriptor.env,
    enabled: true,
  };
}

// ─── HTTP probe fixture ─────────────────────────────────────────────────────

interface ServerFixture {
  url: string;
  close: () => Promise<void>;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<ServerFixture> {
  const server = http.createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const s of sockets) s.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ─── Workspace fixture ──────────────────────────────────────────────────────

let workspaceDir: string;
let probe: ServerFixture;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "a2a-copilot-subagents-test-"));
  probe = await startServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ name: "fake-sub-agent" }));
  });
});

afterEach(async () => {
  await probe.close();
  await rm(workspaceDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("sub-agents wrapper integration", () => {
  it("merges a stdio entry under a2a-subagents with the expected command and args", async () => {
    // Minimal AgentConfig with one fake sub-agent. Only the fields the
    // adapter path reads are populated — agentCard is required by the
    // type but unused here.
    const config: AgentConfig = {
      agentCard: {
        name: "Test Agent",
        description: "Test agent for sub-agents wrapper integration",
      },
      copilot: { workspaceDirectory: workspaceDir },
      logging: { level: "info" },
      mcp: {},
      subAgents: {
        agents: [
          {
            name: "fake",
            agentCardUrl: probe.url,
          },
        ],
      },
    };

    const result = await bootstrapSubAgents({
      subAgents: config.subAgents!,
      workspaceDir: config.copilot?.workspaceDirectory,
      parentLogLevel: config.logging?.level ?? "info",
      existingMcpKeys: new Set(Object.keys(config.mcp ?? {})),
    });

    // Translate via the same adapter shape used inside the executor.
    const mergedMcp: Record<string, McpServerConfig> = {
      ...(config.mcp ?? {}),
      [result.descriptor.key]: toCopilotMcpEntry(result.descriptor),
    };

    // Reserved key lookup.
    expect(result.descriptor.key).toBe(SUBAGENTS_MCP_KEY);
    const entry = mergedMcp[SUBAGENTS_MCP_KEY];
    expect(entry).toBeDefined();

    // Type narrows to McpStdioServerConfig once we've asserted type.
    expect(entry.type).toBe("stdio");
    if (entry.type !== "stdio") return; // type guard for the rest

    expect(entry.command).toBe("npx");
    expect(entry.enabled).toBe(true);

    // args layout: ["-y", "a2a-mcp-skillmap@<version>", "--config", <path>]
    expect(entry.args).toBeDefined();
    expect(entry.args).toHaveLength(4);
    const args = entry.args as string[];
    expect(args[0]).toBe("-y");
    expect(args[1]).toMatch(/^a2a-mcp-skillmap@/);
    expect(args[1]).toBe(`a2a-mcp-skillmap@${SKILLMAP_PACKAGE_VERSION}`);
    expect(args[2]).toBe("--config");
    expect(args[3]).toBe(result.bridgeConfigPath);
  });

  it("does not overwrite pre-existing mcp entries when merging", async () => {
    const config: AgentConfig = {
      agentCard: { name: "Test Agent", description: "x" },
      copilot: { workspaceDirectory: workspaceDir },
      logging: { level: "info" },
      mcp: {
        existing: { type: "http", url: "http://example.com/mcp" },
      },
      subAgents: {
        agents: [{ name: "fake", agentCardUrl: probe.url }],
      },
    };

    const result = await bootstrapSubAgents({
      subAgents: config.subAgents!,
      workspaceDir: config.copilot?.workspaceDirectory,
      parentLogLevel: config.logging?.level ?? "info",
      existingMcpKeys: new Set(Object.keys(config.mcp ?? {})),
    });

    const mergedMcp: Record<string, McpServerConfig> = {
      ...(config.mcp ?? {}),
      [result.descriptor.key]: toCopilotMcpEntry(result.descriptor),
    };

    // The existing entry is preserved alongside the synthesized one.
    expect(Object.keys(mergedMcp).sort()).toEqual(
      [SUBAGENTS_MCP_KEY, "existing"].sort(),
    );
    expect(mergedMcp["existing"].type).toBe("http");
    expect(mergedMcp[SUBAGENTS_MCP_KEY].type).toBe("stdio");
  });

  it("the provider merges the synthesized entry into the MCP servers its sessions are created with", async () => {
    const config = makeConfig({
      mcp: { existing: { type: "http", url: "http://example.com/mcp" } },
      copilot: { workspaceDirectory: workspaceDir },
    });
    config.subAgents = { agents: [{ name: "fake", agentCardUrl: probe.url }] };
    const client = new ManualClient([new ManualSession()]);
    const provider = new CopilotProvider(config, { clientFactory: () => client as never });

    await provider.initialize();
    // a turn creates the session with the resolved MCP map
    const run = { progress() {}, event() {}, artifact() {}, bind() {}, complete() {}, fail() {}, ask: async () => ({ outcome: "unavailable" }), signal: { aborted: true, addEventListener() {} } } as never;
    await provider.run({ taskId: "t", contextId: "c", turnId: "u", runId: "r", input: [], history: [], caller: { id: "a", kind: "anonymous" }, correlation: { eventId: "e", metadata: {} }, extensions: new Map() } as never, run);

    const servers = client.createOptions[0].mcpServers as Record<string, any>;
    expect(Object.keys(servers).sort()).toEqual([SUBAGENTS_MCP_KEY, "existing"].sort());
    expect(servers[SUBAGENTS_MCP_KEY]).toMatchObject({ type: "stdio", command: "npx", tools: ["*"] });
    expect(servers["existing"]).toMatchObject({ type: "http", url: "http://example.com/mcp" });
    await provider.shutdown();
  });
});
