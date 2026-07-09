import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../loader.js";

describe("resolveConfig", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "a2a-claude-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("returns secure defaults when no inputs given", () => {
    delete process.env.WORKSPACE_DIR;
    delete process.env.CLAUDE_MODEL;
    const cfg = resolveConfig();
    expect(cfg.server.port).toBe(3030);
    expect(cfg.claude.permissionMode).toBe("acceptEdits");
    expect(cfg.claude.settingSources).toEqual([]);
    expect(cfg.features.streamArtifactChunks).toBe(false);
    expect(cfg.features.emitTodoEvents).toBe(true);
  });

  it("merges file config over defaults", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "Test", description: "d" },
      claude: { permissionMode: "plan", maxTurns: 5 },
    }));
    const cfg = resolveConfig(p);
    expect(cfg.agentCard.name).toBe("Test");
    expect(cfg.claude.permissionMode).toBe("plan");
    expect(cfg.claude.maxTurns).toBe(5);
    expect(cfg.server.port).toBe(3030); // default preserved
  });

  it("applies env overrides over file config, and CLI over env", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "Test", description: "d" },
      claude: { model: "claude-from-file" },
    }));
    process.env.CLAUDE_MODEL = "claude-from-env";
    let cfg = resolveConfig(p);
    expect(cfg.claude.model).toBe("claude-from-env");
    cfg = resolveConfig(p, { claude: { model: "claude-from-cli" } });
    expect(cfg.claude.model).toBe("claude-from-cli");
  });

  it("substitutes ${ENV_VAR} tokens in workingDirectory", () => {
    process.env.MY_WS = "/tmp/my-workspace";
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { workingDirectory: "${MY_WS}" },
    }));
    const cfg = resolveConfig(p);
    expect(cfg.claude.workingDirectory).toBe("/tmp/my-workspace");
  });

  it("clears model when its env token is unresolved", () => {
    delete process.env.NOPE_MODEL;
    delete process.env.CLAUDE_MODEL;
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      claude: { model: "${NOPE_MODEL}" },
    }));
    const cfg = resolveConfig(p);
    expect(cfg.claude.model).toBeUndefined();
  });

  it("substitutes env tokens in MCP stdio args/env and http headers", () => {
    process.env.MY_TOKEN = "sekret";
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      agentCard: { name: "T", description: "d" },
      mcp: {
        a: { type: "stdio", command: "x", args: ["${MY_TOKEN}"], env: { T: "${MY_TOKEN}" } },
        b: { type: "http", url: "https://x", headers: { Authorization: "Bearer ${MY_TOKEN}" } },
      },
    }));
    const cfg = resolveConfig(p);
    expect((cfg.mcp.a as { args: string[] }).args[0]).toBe("sekret");
    expect((cfg.mcp.b as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer sekret");
  });

  it("throws a descriptive error for a missing config file", () => {
    expect(() => resolveConfig(join(dir, "missing.json"))).toThrow(/Failed to load config file/);
  });
});
