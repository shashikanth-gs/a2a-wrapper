/**
 * Sub-agents wrapper integration smoke test — a2a-opencode
 *
 * Validates the contract between {@link bootstrapSubAgents} and the
 * OpenCode wrapper's MCP map: given a minimal `AgentConfig` with one
 * sub-agent, running the bootstrap and translating its descriptor
 * through the provider's `toOpencodeMcpEntry` SHALL produce a `type: "local"` entry under the reserved
 * `a2a-subagents` key, wired to `npx a2a-mcp-skillmap@<pinned>` and the
 * generated bridge config path.
 *
 * The adapter is the one `OpenCodeProvider` merges the bridge entry with, so the
 * test exercises the real function without booting a provider (which would
 * need an OpenCode server).
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
} from "@a2a-wrapper/core";

import type {
  AgentConfig,
  McpServerConfig,
  McpLocalServerConfig,
} from "../config/types.js";
import { toOpencodeMcpEntry } from "../opencode/provider.js";

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
  workspaceDir = await mkdtemp(join(tmpdir(), "a2a-opencode-subagents-test-"));
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
  it("merges a local entry under a2a-subagents with the expected command array", async () => {
    const config: AgentConfig = {
      agentCard: {
        name: "Test Agent",
        description: "Test agent for sub-agents wrapper integration",
      },
      opencode: { projectDirectory: workspaceDir },
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
      workspaceDir: config.opencode?.projectDirectory,
      parentLogLevel: config.logging?.level ?? "info",
      existingMcpKeys: new Set(Object.keys(config.mcp ?? {})),
    });

    const mergedMcp: Record<string, McpServerConfig> = {
      ...(config.mcp ?? {}),
      [result.descriptor.key]: toOpencodeMcpEntry(result.descriptor),
    };

    expect(result.descriptor.key).toBe(SUBAGENTS_MCP_KEY);
    const entry = mergedMcp[SUBAGENTS_MCP_KEY];
    expect(entry).toBeDefined();
    expect(entry.type).toBe("local");
    if (entry.type !== "local") return; // type guard

    // command is a single array containing npx + all args
    expect(entry.command).toBeDefined();
    expect(entry.command).toHaveLength(5);
    expect(entry.command[0]).toBe("npx");
    expect(entry.command[1]).toBe("-y");
    expect(entry.command[2]).toBe(
      `a2a-mcp-skillmap@${SKILLMAP_PACKAGE_VERSION}`,
    );
    expect(entry.command[3]).toBe("--config");
    expect(entry.command[4]).toBe(result.bridgeConfigPath);

    expect(entry.enabled).toBe(true);
    expect(entry.timeout).toBe(30_000);
  });

  it("does not overwrite pre-existing mcp entries when merging", async () => {
    const config: AgentConfig = {
      agentCard: { name: "Test Agent", description: "x" },
      opencode: { projectDirectory: workspaceDir },
      logging: { level: "info" },
      mcp: {
        existing: { type: "remote", url: "http://example.com/mcp" },
      },
      subAgents: {
        agents: [{ name: "fake", agentCardUrl: probe.url }],
      },
    };

    const result = await bootstrapSubAgents({
      subAgents: config.subAgents!,
      workspaceDir: config.opencode?.projectDirectory,
      parentLogLevel: config.logging?.level ?? "info",
      existingMcpKeys: new Set(Object.keys(config.mcp ?? {})),
    });

    const mergedMcp: Record<string, McpServerConfig> = {
      ...(config.mcp ?? {}),
      [result.descriptor.key]: toOpencodeMcpEntry(result.descriptor),
    };

    expect(Object.keys(mergedMcp).sort()).toEqual(
      [SUBAGENTS_MCP_KEY, "existing"].sort(),
    );
    expect(mergedMcp["existing"].type).toBe("remote");
    expect(mergedMcp[SUBAGENTS_MCP_KEY].type).toBe("local");
  });
});
