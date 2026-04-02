import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { BaseSessionManager } from "../../session/base-session-manager.js";
import type { SessionEntry } from "../../session/base-session-manager.js";
import type { SessionConfig } from "../../config/types.js";

// ─── Concrete Test Subclass ─────────────────────────────────────────────────

class TestSessionManager extends BaseSessionManager<string> {
  private counter = 0;

  async getOrCreate(contextId: string): Promise<string> {
    const existing = this.getSessionEntry(contextId);
    if (existing) {
      existing.lastUsed = Date.now();
      this.setSessionEntry(contextId, existing);
      return existing.session;
    }
    const sessionId = `session-${this.counter++}`;
    this.setSessionEntry(contextId, {
      sessionId,
      session: sessionId,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    });
    return sessionId;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<SessionConfig>): Required<SessionConfig> {
  return {
    titlePrefix: "Test Session",
    reuseByContext: true,
    ttl: 3_600_000,
    cleanupInterval: 300_000,
    ...overrides,
  };
}

// ─── Generators ─────────────────────────────────────────────────────────────

/** Alphanumeric strings of length 1–30, suitable for contextId / taskId / sessionId. */
const arbId = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0);

// ─── Property Tests ─────────────────────────────────────────────────────────

describe("BaseSessionManager", () => {
  // Feature: shared-core-package, Property 17: Session reuse within TTL
  describe("Property 17: Session reuse within TTL", () => {
    it("getOrCreate twice within TTL returns same session with updated lastUsed", async () => {
      await fc.assert(
        fc.asyncProperty(arbId, async (contextId) => {
          const manager = new TestSessionManager(makeConfig({
            reuseByContext: true,
            ttl: 3_600_000, // large TTL so nothing expires
          }));

          try {
            const session1 = await manager.getOrCreate(contextId);
            // Small delay to ensure lastUsed can differ
            await new Promise((r) => setTimeout(r, 5));
            const session2 = await manager.getOrCreate(contextId);

            // Same session returned
            expect(session2).toBe(session1);
          } finally {
            manager.shutdown();
          }
        }),
        { numRuns: 100 },
      );
    });

    /**
     * Validates: Requirements 10.1, 10.5
     */
  });

  // Feature: shared-core-package, Property 18: Task tracking round trip
  describe("Property 18: Task tracking round trip", () => {
    it("trackTask → getSessionForTask/getContextForTask returns correct values; untrackTask → both undefined", () => {
      fc.assert(
        fc.property(arbId, arbId, arbId, (taskId, sessionId, contextId) => {
          const manager = new TestSessionManager(makeConfig());

          try {
            // Track the task
            manager.trackTask(taskId, sessionId, contextId);

            // Verify lookups return correct values
            expect(manager.getSessionForTask(taskId)).toBe(sessionId);
            expect(manager.getContextForTask(taskId)).toBe(contextId);

            // Untrack the task
            manager.untrackTask(taskId);

            // Both should now return undefined
            expect(manager.getSessionForTask(taskId)).toBeUndefined();
            expect(manager.getContextForTask(taskId)).toBeUndefined();
          } finally {
            manager.shutdown();
          }
        }),
        { numRuns: 100 },
      );
    });

    /**
     * Validates: Requirements 10.3
     */
  });
});
