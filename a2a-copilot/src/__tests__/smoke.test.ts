/**
 * Smoke tests — a2a-copilot
 *
 * Cover the pure, dependency-free modules so CI always has something
 * to run. Expand these as the project grows.
 */
import { describe, it, expect } from "vitest";
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
