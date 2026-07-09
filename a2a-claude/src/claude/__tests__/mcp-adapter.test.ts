import { describe, it, expect } from "vitest";
import { validateMcpServers, toClaudeMcpEntry, buildMcpServers } from "../mcp-adapter.js";

describe("validateMcpServers", () => {
  it("accepts stdio and http entries", () => {
    expect(() => validateMcpServers({
      a: { type: "stdio", command: "npx", args: ["x"] },
      b: { type: "http", url: "https://mcp.example.com" },
    })).not.toThrow();
  });

  it("rejects the reserved a2a-subagents key", () => {
    expect(() => validateMcpServers({
      "a2a-subagents": { type: "stdio", command: "x" },
    })).toThrow(/reserved/);
  });

  it("rejects sse with a helpful hint", () => {
    expect(() => validateMcpServers({
      s: { type: "sse", url: "https://x" } as never,
    })).toThrow(/http/);
  });

  it("rejects unknown transports", () => {
    expect(() => validateMcpServers({ s: { type: "grpc" } as never })).toThrow(/Unknown transport/);
  });
});

describe("toClaudeMcpEntry", () => {
  it("maps the sub-agent bridge descriptor to a stdio entry", () => {
    const entry = toClaudeMcpEntry({
      key: "a2a-subagents",
      command: "npx",
      args: ["-y", "a2a-mcp-skillmap"],
      env: { A2A_AGENTS: "[]" },
    } as never);
    expect(entry).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "a2a-mcp-skillmap"],
      env: { A2A_AGENTS: "[]" },
      enabled: true,
    });
  });
});

describe("buildMcpServers", () => {
  it("translates stdio and http entries to SDK shapes and skips disabled", () => {
    const out = buildMcpServers({
      a: { type: "stdio", command: "npx", args: ["srv"], env: { K: "v" } },
      b: { type: "http", url: "https://x", headers: { Authorization: "Bearer t" } },
      c: { type: "stdio", command: "off", enabled: false },
    });
    expect(out).toEqual({
      a: { type: "stdio", command: "npx", args: ["srv"], env: { K: "v" } },
      b: { type: "http", url: "https://x", headers: { Authorization: "Bearer t" } },
    });
  });

  it("omits empty args/env/headers", () => {
    const out = buildMcpServers({
      a: { type: "stdio", command: "x" },
      b: { type: "http", url: "https://y" },
    });
    expect(out).toEqual({
      a: { type: "stdio", command: "x" },
      b: { type: "http", url: "https://y" },
    });
  });
});
