import { describe, it, expect } from "vitest";
import { validateMcpServers, buildMcpConfig, toCodexMcpEntry } from "../codex/mcp-adapter.js";

describe("validateMcpServers", () => {
  it("rejects a user-supplied reserved key", () => {
    expect(() =>
      validateMcpServers({ "a2a-subagents": { type: "stdio", command: "x" } }),
    ).toThrow(/reserved/);
  });

  it("accepts ordinary keys", () => {
    expect(() => validateMcpServers({ foo: { type: "stdio", command: "x" } })).not.toThrow();
  });
});

describe("buildMcpConfig approval modes", () => {
  it("maps approval modes to Codex config keys", () => {
    const out = buildMcpConfig({
      s: {
        type: "stdio",
        command: "x",
        defaultToolsApprovalMode: "approve",
        toolApprovalModes: { danger: "prompt" },
      },
      h: { type: "http", url: "http://x", defaultToolsApprovalMode: "approve" },
    }) as Record<string, any>;
    expect(out.s.default_tools_approval_mode).toBe("approve");
    expect(out.s.tools).toEqual({ danger: { approval_mode: "prompt" } });
    expect(out.h.default_tools_approval_mode).toBe("approve");
  });

  it("pre-approves the sub-agent bridge entry", () => {
    const entry = toCodexMcpEntry({ key: "a2a-subagents", command: "c", args: [], env: {} } as any);
    const out = buildMcpConfig({ "a2a-subagents": entry }) as Record<string, any>;
    expect(out["a2a-subagents"].default_tools_approval_mode).toBe("approve");
  });
});
