import { describe, it, expect } from "vitest";
import { buildQueryOptions } from "../client-factory.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";

function cfg(claude: Partial<Required<AgentConfig>["claude"]> = {}, extra: Partial<AgentConfig> = {}): Required<AgentConfig> {
  return {
    ...DEFAULTS,
    ...extra,
    claude: { ...DEFAULTS.claude, workingDirectory: "/ws", ...claude },
  } as Required<AgentConfig>;
}

describe("buildQueryOptions", () => {
  it("maps core fields and enforces hardening flags", () => {
    const opts = buildQueryOptions(cfg({ model: "claude-sonnet-5", maxTurns: 8, maxBudgetUsd: 2 }), {});
    expect(opts.cwd).toBe("/ws");
    expect(opts.model).toBe("claude-sonnet-5");
    expect(opts.permissionMode).toBe("acceptEdits");
    expect(opts.maxTurns).toBe(8);
    expect(opts.maxBudgetUsd).toBe(2);
    expect(opts.strictMcpConfig).toBe(true);   // always
    expect(opts.persistSession).toBe(true);    // always (resume requires it)
    expect(opts.settingSources).toEqual([]);   // isolation default
    expect(opts.includePartialMessages).toBe(false);
  });

  it("omits empty optional fields", () => {
    const opts = buildQueryOptions(cfg(), {});
    expect(opts.model).toBeUndefined();
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.disallowedTools).toBeUndefined();
    expect(opts.systemPrompt).toBeUndefined();
    expect(opts.resume).toBeUndefined();
    expect(opts.sandbox).toBeUndefined();
  });

  it("threads resume and abortController from the turn", () => {
    const ac = new AbortController();
    const opts = buildQueryOptions(cfg(), { resume: "sess-1", abortController: ac });
    expect(opts.resume).toBe("sess-1");
    expect(opts.abortController).toBe(ac);
  });

  it("maps systemPromptAppend to the claude_code preset with append", () => {
    const opts = buildQueryOptions(cfg({ systemPromptAppend: "Be careful." }), {});
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Be careful." });
  });

  it("maps customSystemPrompt to a plain string", () => {
    const opts = buildQueryOptions(cfg({ customSystemPrompt: "You are X." }), {});
    expect(opts.systemPrompt).toBe("You are X.");
  });

  it("enables includePartialMessages when streamArtifactChunks is on", () => {
    const c = cfg();
    c.features = { ...c.features, streamArtifactChunks: true };
    expect(buildQueryOptions(c, {}).includePartialMessages).toBe(true);
  });

  it("passes bypass flag and mcp servers through", () => {
    const c = cfg({ permissionMode: "bypassPermissions", dangerouslyAllowBypassPermissions: true });
    c.mcp = { srv: { type: "stdio", command: "x" } };
    const opts = buildQueryOptions(c, {});
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.mcpServers).toEqual({ srv: { type: "stdio", command: "x" } });
  });
});
