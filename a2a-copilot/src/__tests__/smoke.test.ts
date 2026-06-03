/**
 * Smoke tests — a2a-copilot
 *
 * Cover the pure, dependency-free modules so CI always has something
 * to run. Expand these as the project grows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── DEFAULTS ───────────────────────────────────────────────────────────────

import { DEFAULTS } from "../config/defaults.js";

describe("DEFAULTS", () => {
  it("has the expected protocol version", () => {
    expect(DEFAULTS.agentCard.protocolVersion).toBe("0.3.0");
  });

  it("defaults to port 3000", () => {
    expect(DEFAULTS.server.port).toBe(3000);
  });

  it("defaults to hostname 0.0.0.0", () => {
    expect(DEFAULTS.server.hostname).toBe("0.0.0.0");
  });

  it("defaults to advertiseHost localhost", () => {
    expect(DEFAULTS.server.advertiseHost).toBe("localhost");
  });

  it("disables streamArtifactChunks by default", () => {
    expect(DEFAULTS.features.streamArtifactChunks).toBe(false);
  });

  it("enables session reuse by default", () => {
    expect(DEFAULTS.session.reuseByContext).toBe(true);
  });
});

// ─── Logger ─────────────────────────────────────────────────────────────────

import { Logger, LogLevel } from "../utils/logger.js";

describe("Logger", () => {
  it("parseLevel returns INFO for unknown strings", () => {
    expect(Logger.parseLevel("unknown")).toBe(LogLevel.INFO);
  });

  it("parseLevel handles all known levels", () => {
    expect(Logger.parseLevel("debug")).toBe(LogLevel.DEBUG);
    expect(Logger.parseLevel("info")).toBe(LogLevel.INFO);
    expect(Logger.parseLevel("warn")).toBe(LogLevel.WARN);
    expect(Logger.parseLevel("warning")).toBe(LogLevel.WARN);
    expect(Logger.parseLevel("error")).toBe(LogLevel.ERROR);
  });

  it("child logger is a Logger instance", () => {
    const log = new Logger("test");
    expect(log.child("sub")).toBeInstanceOf(Logger);
  });

  it("setLevel on parent propagates to children created beforehand", () => {
    const parent = new Logger("parent", LogLevel.INFO);
    const child = parent.child("child");
    // Child starts at the shared INFO level.
    expect(child.level).toBe(LogLevel.INFO);
    // Changing the parent's level after the child exists must reach the child.
    parent.setLevel(LogLevel.DEBUG);
    expect(child.level).toBe(LogLevel.DEBUG);
  });
});

// ─── loadConfigFile ──────────────────────────────────────────────────────────

import { loadConfigFile } from "../config/loader.js";

describe("loadConfigFile", () => {
  it("parses a valid JSON config file", () => {
    const tmp = join(tmpdir(), `a2a-copilot-test-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({ agentCard: { name: "Test Agent" } }));
    try {
      const cfg = loadConfigFile(tmp);
      expect(cfg.agentCard?.name).toBe("Test Agent");
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("throws a descriptive error for a missing file", () => {
    expect(() => loadConfigFile("/nonexistent/path/config.json")).toThrow(
      /config.*load|ENOENT|no such file/i,
    );
  });

  it("throws a descriptive error for invalid JSON", () => {
    const tmp = join(tmpdir(), `a2a-copilot-bad-${Date.now()}.json`);
    writeFileSync(tmp, "{ not valid json }");
    try {
      expect(() => loadConfigFile(tmp)).toThrow();
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});

// ─── resolveConfig — provider / BYOK ────────────────────────────────────────

import { resolveConfig, loadEnvOverrides } from "../config/loader.js";

describe("resolveConfig — provider (BYOK)", () => {
  it("has no provider by default (uses GitHub Copilot)", () => {
    const cfg = resolveConfig();
    expect(cfg.copilot.provider).toBeUndefined();
  });

  it("passes provider through from config file", () => {
    const tmp = join(tmpdir(), `a2a-provider-test-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({
      agentCard: { name: "Test" },
      copilot: {
        model: "qwen2.5-coder:7b",
        provider: {
          type: "openai",
          baseUrl: "http://localhost:11434/v1",
          wireApi: "completions",
        },
      },
    }));
    try {
      const cfg = resolveConfig(tmp);
      expect(cfg.copilot.provider).toBeDefined();
      expect(cfg.copilot.provider!.type).toBe("openai");
      expect(cfg.copilot.provider!.baseUrl).toBe("http://localhost:11434/v1");
      expect(cfg.copilot.provider!.wireApi).toBe("completions");
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("supports Anthropic provider config", () => {
    const tmp = join(tmpdir(), `a2a-provider-anthropic-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({
      agentCard: { name: "Test" },
      copilot: {
        model: "claude-opus-4-5",
        provider: {
          type: "anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKey: "sk-ant-test",
        },
      },
    }));
    try {
      const cfg = resolveConfig(tmp);
      expect(cfg.copilot.provider!.type).toBe("anthropic");
      expect(cfg.copilot.provider!.baseUrl).toBe("https://api.anthropic.com");
      expect(cfg.copilot.provider!.apiKey).toBe("sk-ant-test");
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("supports Azure provider config with azure options", () => {
    const tmp = join(tmpdir(), `a2a-provider-azure-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({
      agentCard: { name: "Test" },
      copilot: {
        model: "gpt-4o",
        provider: {
          type: "azure",
          baseUrl: "https://my-resource.openai.azure.com",
          apiKey: "azure-key",
          azure: { apiVersion: "2024-10-21" },
        },
      },
    }));
    try {
      const cfg = resolveConfig(tmp);
      expect(cfg.copilot.provider!.type).toBe("azure");
      expect(cfg.copilot.provider!.azure?.apiVersion).toBe("2024-10-21");
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});

describe("loadEnvOverrides — BYOK env vars", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("picks up COPILOT_PROVIDER_BASE_URL", () => {
    process.env["COPILOT_PROVIDER_BASE_URL"] = "http://localhost:11434/v1";
    const overrides = loadEnvOverrides();
    expect(overrides.copilot?.provider?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("picks up COPILOT_PROVIDER_TYPE", () => {
    process.env["COPILOT_PROVIDER_BASE_URL"] = "http://localhost:11434/v1";
    process.env["COPILOT_PROVIDER_TYPE"] = "openai";
    const overrides = loadEnvOverrides();
    expect(overrides.copilot?.provider?.type).toBe("openai");
  });

  it("picks up COPILOT_PROVIDER_API_KEY", () => {
    process.env["COPILOT_PROVIDER_BASE_URL"] = "https://api.openai.com/v1";
    process.env["COPILOT_PROVIDER_API_KEY"] = "sk-test-key";
    const overrides = loadEnvOverrides();
    expect(overrides.copilot?.provider?.apiKey).toBe("sk-test-key");
  });

  it("picks up COPILOT_PROVIDER_WIRE_API", () => {
    process.env["COPILOT_PROVIDER_BASE_URL"] = "http://localhost:11434/v1";
    process.env["COPILOT_PROVIDER_WIRE_API"] = "completions";
    const overrides = loadEnvOverrides();
    expect(overrides.copilot?.provider?.wireApi).toBe("completions");
  });

  it("does not set provider when COPILOT_PROVIDER_BASE_URL is absent", () => {
    process.env["COPILOT_PROVIDER_TYPE"] = "openai"; // type alone — no baseUrl
    const overrides = loadEnvOverrides();
    expect(overrides.copilot?.provider).toBeUndefined();
  });

  it("env provider is merged over config file provider", () => {
    const tmp = join(tmpdir(), `a2a-env-merge-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({
      agentCard: { name: "Test" },
      copilot: {
        model: "qwen2.5-coder:7b",
        provider: { type: "openai", baseUrl: "http://localhost:11434/v1" },
      },
    }));
    process.env["COPILOT_PROVIDER_BASE_URL"] = "http://localhost:11434/v1";
    process.env["COPILOT_PROVIDER_WIRE_API"] = "completions";
    try {
      const cfg = resolveConfig(tmp);
      // env wireApi should be merged in on top of the file config
      expect(cfg.copilot.provider?.wireApi).toBe("completions");
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
