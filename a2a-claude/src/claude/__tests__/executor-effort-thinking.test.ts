import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeExecutor } from "../executor.js";
import { FakeClaudeClient, happyTurn } from "./fake-client.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";

let ws: string;
let config: Required<AgentConfig>;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "a2a-claude-ws-"));
  config = JSON.parse(JSON.stringify({ ...DEFAULTS, configDir: ws })) as Required<AgentConfig>;
  config.claude.workingDirectory = ws;
  config.events = { enabled: false } as Required<AgentConfig>["events"];
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

function executor(): ClaudeExecutor {
  return new ClaudeExecutor(config, () => new FakeClaudeClient([happyTurn("s", "x")]));
}

describe("effort validation", () => {
  it("accepts every supported effort level", async () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      config.claude.effort = level;
      await expect(executor().initialize()).resolves.toBeUndefined();
    }
  });

  it("rejects an unsupported effort level", async () => {
    config.claude.effort = "extreme" as never;
    await expect(executor().initialize()).rejects.toThrow(
      /claude\.effort "extreme" is invalid.*low, medium, high, xhigh, max/s,
    );
  });

  it("accepts a config with no effort set", async () => {
    await expect(executor().initialize()).resolves.toBeUndefined();
  });
});

describe("thinking validation", () => {
  it("accepts all three thinking shapes", async () => {
    const shapes = [
      { type: "adaptive" },
      { type: "enabled", budgetTokens: 4096 },
      { type: "enabled" },
      { type: "disabled" },
    ] as const;
    for (const thinking of shapes) {
      config.claude.thinking = thinking as Required<AgentConfig>["claude"]["thinking"];
      await expect(executor().initialize()).resolves.toBeUndefined();
    }
  });

  it("rejects an unknown thinking type", async () => {
    config.claude.thinking = { type: "sometimes" } as never;
    await expect(executor().initialize()).rejects.toThrow(
      /claude\.thinking must be an object.*adaptive, enabled, disabled/s,
    );
  });

  it("rejects a non-object thinking value", async () => {
    config.claude.thinking = "adaptive" as never;
    await expect(executor().initialize()).rejects.toThrow(/claude\.thinking must be an object/);
  });

  it("rejects a non-integer budgetTokens", async () => {
    config.claude.thinking = { type: "enabled", budgetTokens: 1.5 } as never;
    await expect(executor().initialize()).rejects.toThrow(
      /claude\.thinking\.budgetTokens must be a positive integer/,
    );
  });

  it("rejects a zero or negative budgetTokens", async () => {
    config.claude.thinking = { type: "enabled", budgetTokens: 0 } as never;
    await expect(executor().initialize()).rejects.toThrow(
      /claude\.thinking\.budgetTokens must be a positive integer/,
    );
  });
});

describe("outputFormat validation", () => {
  const validSchema = { type: "object", properties: { answer: { type: "string" } } };

  it("accepts a valid json_schema outputFormat", async () => {
    config.claude.outputFormat = { type: "json_schema", schema: validSchema };
    await expect(executor().initialize()).resolves.toBeUndefined();
  });

  it("accepts a config with no outputFormat set", async () => {
    await expect(executor().initialize()).resolves.toBeUndefined();
  });

  it("rejects a non-object outputFormat", async () => {
    config.claude.outputFormat = "json" as never;
    await expect(executor().initialize()).rejects.toThrow(/claude\.outputFormat/);
  });

  it("rejects an unsupported outputFormat type", async () => {
    config.claude.outputFormat = { type: "text", schema: validSchema } as never;
    await expect(executor().initialize()).rejects.toThrow(/json_schema/);
  });

  it("rejects an outputFormat missing a schema object", async () => {
    config.claude.outputFormat = { type: "json_schema" } as never;
    await expect(executor().initialize()).rejects.toThrow(/schema/);
  });

  it("rejects an outputFormat whose schema is an array", async () => {
    config.claude.outputFormat = { type: "json_schema", schema: [] as never } as never;
    await expect(executor().initialize()).rejects.toThrow(/schema/);
  });
});
