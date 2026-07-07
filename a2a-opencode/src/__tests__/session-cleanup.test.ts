/**
 * session-cleanup.test.ts
 *
 * TDD tests for SessionManager TTL cleanup behaviour (Task 4.1 & 4.2).
 * Covers: ttl=0 disables cleanup, ttl>0 cleanup works as before.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionManager } from "../opencode/session-manager.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock client. sessionGet / sessionCreate are not called in
 * cleanup-path tests so simple vi.fn() stubs suffice.
 */
function makeMockClient() {
  return {
    sessionGet: vi.fn(),
    sessionCreate: vi.fn(),
  } as any;
}

/**
 * Build a Required<SessionConfig>-compatible object.
 * cleanupInterval is set high so the real timer never fires during tests.
 */
function makeSessionCfg(ttl: number) {
  return {
    titlePrefix: "A2A",
    reuseByContext: true,
    ttl,
    cleanupInterval: 999_999,
    sessionMapFile: "",
  } as any;
}

const FEATURES = {
  autoApprovePermissions: true,
  autoAnswerQuestions: true,
  streamArtifactChunks: false,
  enablePollingFallback: true,
} as any;

/**
 * Capture the callback passed to setInterval and return both the manager
 * and a trigger function so tests can invoke cleanup synchronously.
 */
function buildManagerWithInterceptedCleanup(ttl: number) {
  let capturedCallback: (() => void) | undefined;

  vi.spyOn(global, "setInterval").mockImplementation((cb: any) => {
    capturedCallback = cb;
    // Return a timer-like object so cleanupTimer.unref() doesn't throw.
    return { unref: vi.fn() } as any;
  });

  const manager = new SessionManager(
    makeMockClient(),
    makeSessionCfg(ttl),
    FEATURES,
    "",
  );

  manager.startCleanup();

  return {
    manager,
    /** Call the cleanup callback synchronously, as the timer would. */
    triggerCleanup: () => capturedCallback?.(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionManager TTL cleanup", () => {
  it("ttl=0 disables cleanup", () => {
    const { manager, triggerCleanup } = buildManagerWithInterceptedCleanup(0);

    // Inject an entry directly into the private contextMap.
    const contextMap: Map<string, { sessionId: string; lastUsed: number }> =
      (manager as any).contextMap;

    contextMap.set("ctx-a", { sessionId: "sess-1", lastUsed: Date.now() - 10_000 });

    triggerCleanup();

    // Entry must still be present — ttl=0 should skip cleanup entirely.
    expect(contextMap.size).toBe(1);
    expect(contextMap.has("ctx-a")).toBe(true);
  });

  it("ttl>0 cleanup works as before", () => {
    const { manager, triggerCleanup } = buildManagerWithInterceptedCleanup(1_000);

    const contextMap: Map<string, { sessionId: string; lastUsed: number }> =
      (manager as any).contextMap;

    // Entry last used 2 s ago — older than the 1 s TTL, should be cleaned.
    contextMap.set("ctx-b", { sessionId: "sess-2", lastUsed: Date.now() - 2_000 });

    triggerCleanup();

    expect(contextMap.size).toBe(0);
    expect(contextMap.has("ctx-b")).toBe(false);
  });
});
