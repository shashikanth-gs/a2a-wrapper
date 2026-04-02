/**
 * Session Manager
 *
 * Handles session lifecycle: create, reuse-by-context, TTL cleanup.
 * Extracted from executor to keep each module focused.
 */

import type { OpenCodeClientWrapper } from "./client.js";
import type { Session, PermissionRuleset } from "./types.js";
import type { SessionConfig, FeatureFlags } from "../config/types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("sessions");

// ─── Auto-Allow Permissions ─────────────────────────────────────────────────

const AUTO_ALLOW_PERMISSIONS: PermissionRuleset = [
  { permission: "read",  pattern: "*", action: "allow" },
  { permission: "edit",  pattern: "*", action: "allow" },
  { permission: "bash",  pattern: "*", action: "allow" },
  { permission: "glob",  pattern: "*", action: "allow" },
  { permission: "grep",  pattern: "*", action: "allow" },
  { permission: "list",  pattern: "*", action: "allow" },
  { permission: "task",  pattern: "*", action: "allow" },
  { permission: "mcp",   pattern: "*", action: "allow" },
  { permission: "fetch", pattern: "*", action: "allow" },
];

// ─── Types ──────────────────────────────────────────────────────────────────

interface SessionEntry {
  sessionId: string;
  lastUsed: number;
}

// ─── Manager ────────────────────────────────────────────────────────────────

export class SessionManager {
  private readonly client: OpenCodeClientWrapper;
  private readonly sessionCfg: Required<SessionConfig>;
  private readonly autoApprove: boolean;
  private readonly directory: string;

  private contextMap = new Map<string, SessionEntry>();
  private taskMap = new Map<string, string>(); // taskId → sessionId
  private taskContexts = new Map<string, string>(); // taskId → contextId
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    client: OpenCodeClientWrapper,
    sessionCfg: Required<SessionConfig>,
    features: Required<FeatureFlags>,
    directory: string,
  ) {
    this.client = client;
    this.sessionCfg = sessionCfg;
    this.autoApprove = features.autoApprovePermissions;
    this.directory = directory;
  }

  /** Start periodic session cleanup. */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [ctx, entry] of this.contextMap) {
        if (now - entry.lastUsed > this.sessionCfg.ttl) {
          this.contextMap.delete(ctx);
          cleaned++;
        }
      }
      if (cleaned > 0) log.info("Cleaned expired sessions", { count: cleaned });
    }, this.sessionCfg.cleanupInterval);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Stop the cleanup timer. */
  stopCleanup(): void {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  /**
   * Get or create a session for the given A2A contextId.
   * Reuses sessions when configured.
   */
  async getOrCreate(contextId: string): Promise<string> {
    if (this.sessionCfg.reuseByContext) {
      const entry = this.contextMap.get(contextId);
      if (entry) {
        entry.lastUsed = Date.now();
        try {
          await this.client.sessionGet(entry.sessionId, this.directory || undefined);
          return entry.sessionId;
        } catch {
          this.contextMap.delete(contextId);
        }
      }
    }

    const title = `${this.sessionCfg.titlePrefix} - ${contextId.slice(0, 8)}`;
    const session: Session = await this.client.sessionCreate(
      this.directory || undefined,
      {
        title,
        permission: this.autoApprove ? AUTO_ALLOW_PERMISSIONS : undefined,
      },
    );

    if (this.sessionCfg.reuseByContext) {
      this.contextMap.set(contextId, { sessionId: session.id, lastUsed: Date.now() });
    }

    log.info("Session ready", { sessionId: session.id, contextId });
    return session.id;
  }

  /** Track a task → session + context mapping (for cancel support). */
  trackTask(taskId: string, sessionId: string, contextId?: string): void {
    this.taskMap.set(taskId, sessionId);
    if (contextId) this.taskContexts.set(taskId, contextId);
  }

  /** Get the session for a task (for cancel). */
  getSessionForTask(taskId: string): string | undefined {
    return this.taskMap.get(taskId);
  }

  /** Get the A2A contextId for a tracked task. Used in cancelTask to emit the correct contextId. */
  getContextForTask(taskId: string): string | undefined {
    return this.taskContexts.get(taskId);
  }

  /** Remove task tracking. */
  untrackTask(taskId: string): void {
    this.taskMap.delete(taskId);
    this.taskContexts.delete(taskId);
  }

  /** Cleanup all state. */
  shutdown(): void {
    this.stopCleanup();
    this.contextMap.clear();
    this.taskMap.clear();
    this.taskContexts.clear();
  }
}
