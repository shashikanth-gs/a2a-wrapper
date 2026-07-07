/**
 * Session Manager — persistence tests (Group 3)
 *
 * Covers Tasks 3.1–3.7: constructor map loading, no-fs-when-no-path,
 * corrupt-file handling, persistMap write correctness, write-failure resilience,
 * getOrCreate triggers persist, and TTL cleanup triggers persist.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsModule from "node:fs";

// Must be hoisted — vitest rewrites this to run before imports.
vi.mock("node:fs");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal session config with all Required<SessionConfig> fields. */
function makeSessionCfg(sessionMapFile?: string) {
  return {
    titlePrefix: "A2A Session",
    reuseByContext: true,
    ttl: 3_600_000,
    cleanupInterval: 300_000,
    sessionMapFile,
  } as const;
}

/** Minimal feature flags. */
const DEFAULT_FEATURES = {
  autoApprovePermissions: true,
  autoAnswerQuestions: true,
  streamArtifactChunks: false,
  enablePollingFallback: true,
} as const;

/** Build a mock OpenCodeClientWrapper. */
function makeClient(opts?: {
  sessionCreateResult?: { id: string };
  sessionGetShouldThrow?: boolean;
}) {
  return {
    sessionCreate: vi.fn().mockResolvedValue(opts?.sessionCreateResult ?? { id: "ses_abc" }),
    sessionGet: opts?.sessionGetShouldThrow
      ? vi.fn().mockRejectedValue(new Error("not found"))
      : vi.fn().mockResolvedValue({}),
  };
}

// ─── Module Import ───────────────────────────────────────────────────────────

import { SessionManager } from "../opencode/session-manager.js";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SessionManager — persistence", () => {
  let readSpy: ReturnType<typeof vi.mocked<typeof fsModule.readFileSync>>;
  let writeSpy: ReturnType<typeof vi.mocked<typeof fsModule.writeFileSync>>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    readSpy = vi.mocked(fsModule.readFileSync);
    writeSpy = vi.mocked(fsModule.writeFileSync);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  // ── Task 3.1 ────────────────────────────────────────────────────────────────

  it("loads existing map on construction", () => {
    const mapData = {
      "conv-123": { sessionId: "ses_abc", lastUsed: 1750000000000 },
    };
    readSpy.mockReturnValueOnce(JSON.stringify(mapData) as any);

    const client = makeClient();
    const manager = new SessionManager(
      client as any,
      makeSessionCfg("/tmp/session-map.json"),
      DEFAULT_FEATURES,
      "/workspace",
    );

    const ctx = (manager as any).contextMap as Map<string, { sessionId: string; lastUsed: number }>;
    expect(ctx.get("conv-123")?.sessionId).toBe("ses_abc");
  });

  // ── Task 3.2 ────────────────────────────────────────────────────────────────

  it("no sessionMapFile — no fs calls", async () => {
    const client = makeClient();
    const manager = new SessionManager(
      client as any,
      makeSessionCfg(undefined),
      DEFAULT_FEATURES,
      "/workspace",
    );

    // constructor should not read
    expect(readSpy).not.toHaveBeenCalled();

    // getOrCreate should not write
    await manager.getOrCreate("ctx-xyz");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  // ── Task 3.3 ────────────────────────────────────────────────────────────────

  it("corrupt map file — logs error and starts empty", () => {
    readSpy.mockReturnValueOnce("{ not valid json }" as any);

    let manager: SessionManager;
    expect(() => {
      manager = new SessionManager(
        makeClient() as any,
        makeSessionCfg("/tmp/session-map.json"),
        DEFAULT_FEATURES,
        "/workspace",
      );
    }).not.toThrow();

    // log.error calls console.error
    expect(consoleErrorSpy).toHaveBeenCalled();

    // contextMap should be empty
    const ctx = (manager! as any).contextMap as Map<string, unknown>;
    expect(ctx.size).toBe(0);
  });

  // ── Task 3.4 ────────────────────────────────────────────────────────────────

  it("persistMap writes correct JSON", () => {
    // Constructor read returns ENOENT so map starts empty
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    readSpy.mockImplementationOnce(() => { throw enoent; });

    const client = makeClient();
    const manager = new SessionManager(
      client as any,
      makeSessionCfg("/tmp/session-map.json"),
      DEFAULT_FEATURES,
      "/workspace",
    );

    // Manually populate contextMap
    (manager as any).contextMap.set("ctx-A", { sessionId: "ses_1", lastUsed: 1000 });
    (manager as any).contextMap.set("ctx-B", { sessionId: "ses_2", lastUsed: 2000 });

    (manager as any).persistMap();

    expect(writeSpy).toHaveBeenCalledWith(
      "/tmp/session-map.json",
      JSON.stringify({
        "ctx-A": { sessionId: "ses_1", lastUsed: 1000 },
        "ctx-B": { sessionId: "ses_2", lastUsed: 2000 },
      }),
      "utf-8",
    );
  });

  // ── Task 3.5 ────────────────────────────────────────────────────────────────

  it("persistMap write failure logs error", () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    readSpy.mockImplementationOnce(() => { throw enoent; });

    const client = makeClient();
    const manager = new SessionManager(
      client as any,
      makeSessionCfg("/tmp/session-map.json"),
      DEFAULT_FEATURES,
      "/workspace",
    );

    (manager as any).contextMap.set("ctx-A", { sessionId: "ses_1", lastUsed: 1000 });

    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    writeSpy.mockImplementationOnce(() => { throw eacces; });

    // Must not throw
    expect(() => (manager as any).persistMap()).not.toThrow();

    // Must log an error
    expect(consoleErrorSpy).toHaveBeenCalled();

    // In-memory map must still be intact
    expect((manager as any).contextMap.get("ctx-A")?.sessionId).toBe("ses_1");
  });

  // ── Task 3.6 — persists on getOrCreate set ──────────────────────────────────

  it("persists on getOrCreate set", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    readSpy.mockImplementationOnce(() => { throw enoent; });

    const client = makeClient({ sessionCreateResult: { id: "ses_new" } });
    const manager = new SessionManager(
      client as any,
      makeSessionCfg("/tmp/session-map.json"),
      DEFAULT_FEATURES,
      "/workspace",
    );

    writeSpy.mockClear();

    await manager.getOrCreate("ctx-new");

    expect(writeSpy).toHaveBeenCalledOnce();
    const written = JSON.parse(writeSpy.mock.calls[0][1] as string);
    expect(written["ctx-new"]?.sessionId).toBe("ses_new");
  });

  it("persists on stale entry removal", async () => {
    const existingMap = {
      "ctx-stale": { sessionId: "ses_stale", lastUsed: Date.now() },
    };
    readSpy.mockReturnValueOnce(JSON.stringify(existingMap) as any);

    // sessionGet throws to simulate stale session; then a new session is created
    const client = makeClient({ sessionGetShouldThrow: true, sessionCreateResult: { id: "ses_fresh" } });
    const manager = new SessionManager(
      client as any,
      makeSessionCfg("/tmp/session-map.json"),
      DEFAULT_FEATURES,
      "/workspace",
    );

    writeSpy.mockClear();

    await manager.getOrCreate("ctx-stale");

    // Two writes: (1) stale removed, (2) new entry added
    expect(writeSpy).toHaveBeenCalledTimes(2);

    // First write: stale entry removed
    const firstWrite = JSON.parse(writeSpy.mock.calls[0][1] as string);
    expect(firstWrite["ctx-stale"]).toBeUndefined();

    // Second write: new entry present
    const secondWrite = JSON.parse(writeSpy.mock.calls[1][1] as string);
    expect(secondWrite["ctx-stale"]?.sessionId).toBe("ses_fresh");
  });

  // ── Task 3.7 — cleanup syncs removal to file ─────────────────────────────────

  it("cleanup syncs removal to file", () => {
    const now = Date.now();
    const expiredLastUsed = now - 4_000_000; // well past 1h TTL
    const existingMap = {
      "ctx-expired": { sessionId: "ses_old", lastUsed: expiredLastUsed },
    };
    readSpy.mockReturnValueOnce(JSON.stringify(existingMap) as any);

    vi.useFakeTimers();

    const client = makeClient();
    const manager = new SessionManager(
      client as any,
      makeSessionCfg("/tmp/session-map.json"),
      DEFAULT_FEATURES,
      "/workspace",
    );

    writeSpy.mockClear();
    manager.startCleanup();

    // Advance past the cleanup interval
    vi.advanceTimersByTime(300_001);

    expect(writeSpy).toHaveBeenCalled();
    const written = JSON.parse(writeSpy.mock.calls[0][1] as string);
    expect(written["ctx-expired"]).toBeUndefined();

    manager.stopCleanup();
    vi.useRealTimers();
  });
});

describe("SessionManager — sessionExists", () => {
  let readSpy: ReturnType<typeof vi.mocked<typeof fsModule.readFileSync>>;

  beforeEach(() => {
    vi.resetAllMocks();
    readSpy = vi.mocked(fsModule.readFileSync);
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    readSpy.mockImplementation(() => { throw enoent; });
  });

  function makeManager(reuseByContext = true, opts?: {
    sessionGetShouldThrow?: boolean;
  }) {
    const client = {
      sessionCreate: vi.fn().mockResolvedValue({ id: "ses_new" }),
      sessionGet: opts?.sessionGetShouldThrow
        ? vi.fn().mockRejectedValue(new Error("not found"))
        : vi.fn().mockResolvedValue({}),
    };
    const cfg = {
      titlePrefix: "A2A Session",
      reuseByContext,
      ttl: 3_600_000,
      cleanupInterval: 300_000,
      sessionMapFile: undefined,
    };
    const manager = new SessionManager(client as any, cfg as any, DEFAULT_FEATURES, "");
    return { manager, client };
  }

  it("sessionExists returns false when reuseByContext off", async () => {
    const { manager } = makeManager(false);
    const result = await manager.sessionExists("conv-any");
    expect(result).toBe(false);
  });

  it("sessionExists true when alive", async () => {
    const { manager, client } = makeManager(true);
    // Pre-populate contextMap
    (manager as any).contextMap.set("conv-123", { sessionId: "ses_abc", lastUsed: Date.now() });

    const result = await manager.sessionExists("conv-123");
    expect(result).toBe(true);
    expect(client.sessionGet).toHaveBeenCalledWith("ses_abc", undefined);
  });

  it("sessionExists clears stale and returns false", async () => {
    const writeSpy = vi.mocked(fsModule.writeFileSync);
    const { manager, client } = makeManager(true, { sessionGetShouldThrow: true });
    (manager as any).contextMap.set("conv-123", { sessionId: "ses_abc", lastUsed: Date.now() });

    const result = await manager.sessionExists("conv-123");
    expect(result).toBe(false);
    expect(client.sessionGet).toHaveBeenCalledWith("ses_abc", undefined);
    // entry cleared
    expect((manager as any).contextMap.has("conv-123")).toBe(false);
    // persistMap called (no sessionMapFile set → no write, but method still called safely)
    expect(writeSpy).not.toHaveBeenCalled(); // no sessionMapFile
  });

  it("sessionExists false when no mapping", async () => {
    const { manager, client } = makeManager(true);
    const result = await manager.sessionExists("conv-999");
    expect(result).toBe(false);
    expect(client.sessionGet).not.toHaveBeenCalled();
  });
});
