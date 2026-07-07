/**
 * Session Manager
 *
 * Handles session lifecycle: create, reuse-by-context, TTL cleanup.
 * Extracted from executor to keep each module focused.
 */

import fs from "node:fs";
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
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.loadMap();
  }

  /**
   * Loads the persisted contextId→sessionId map from `sessionMapFile`.
   * If the file does not exist (ENOENT), starts with an empty map.
   * If the file exists but contains invalid JSON, logs an error and starts empty.
   * If `sessionMapFile` is not configured, does nothing.
   */
  private loadMap(): void {
    const path = this.sessionCfg.sessionMapFile;
    if (!path) return;
    try {
      const raw = fs.readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        log.error("Session map file is not a JSON object — starting empty");
        return;
      }
      for (const [ctx, entry] of Object.entries(parsed as Record<string, unknown>)) {
        // Validate each entry shape before inserting to prevent malformed data
        // from reaching sessionGet (e.g. null entries or non-string sessionIds).
        if (
          entry !== null &&
          typeof entry === "object" &&
          typeof (entry as Record<string, unknown>).sessionId === "string" &&
          typeof (entry as Record<string, unknown>).lastUsed === "number"
        ) {
          this.contextMap.set(ctx, entry as SessionEntry);
        } else {
          log.error("Skipping malformed entry in session map", { ctx });
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      log.error("Failed to load session map — starting empty", { error: e });
    }
  }

  /**
   * Schedules a debounced async write of the current `contextMap` to `sessionMapFile`.
   * Calls within 200 ms are coalesced into a single write, avoiding event-loop
   * blocking on burst updates (e.g., rapid session creation or cleanup sweeps).
   * If `sessionMapFile` is not configured, does nothing.
   * Write failures are logged but never thrown.
   */
  private persistMap(): void {
    const path = this.sessionCfg.sessionMapFile;
    if (!path) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      fs.promises
        .writeFile(path, JSON.stringify(Object.fromEntries(this.contextMap)), "utf-8")
        .catch((e) => log.error("Failed to persist session map", { error: e }));
    }, 200);
    // Allow Node.js to exit without waiting for a pending flush.
    this.persistTimer.unref?.();
  }

  /** Start periodic session cleanup. */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      // When ttl <= 0 (disabled), skip cleanup entirely to avoid clearing all entries.
      if (this.sessionCfg.ttl <= 0) return;
      const now = Date.now();
      let cleaned = 0;
      for (const [ctx, entry] of this.contextMap) {
        if (now - entry.lastUsed > this.sessionCfg.ttl) {
          this.contextMap.delete(ctx);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        log.info("Cleaned expired sessions", { count: cleaned });
        this.persistMap();
      }
    }, this.sessionCfg.cleanupInterval);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Stop the cleanup timer. */
  stopCleanup(): void {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  /**
   * Get or create a session for the given A2A contextId.
   * Returns `{ sessionId, created }` where `created` is `true` when a new
   * opencode session was started, and `false` when an existing one was reused.
   */
  async getOrCreate(contextId: string): Promise<{ sessionId: string; created: boolean }> {
    if (this.sessionCfg.reuseByContext) {
      const entry = this.contextMap.get(contextId);
      if (entry) {
        entry.lastUsed = Date.now();
        try {
          await this.client.sessionGet(entry.sessionId, this.directory || undefined);
          return { sessionId: entry.sessionId, created: false };
        } catch {
          this.contextMap.delete(contextId);
          this.persistMap();
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
      this.persistMap();
    }

    log.info("Session ready", { sessionId: session.id, contextId });
    return { sessionId: session.id, created: true };
  }

  /**
   * Check whether a resumable session exists for `contextId` without creating one.
   * Returns `true` if a mapping exists and `sessionGet` succeeds (session is alive).
   * A successful liveness check refreshes `lastUsed` to extend the TTL window.
   * Clears the stale entry (and persists) when `sessionGet` fails.
   * Returns `false` immediately when `reuseByContext` is disabled.
   */
  async sessionExists(contextId: string): Promise<boolean> {
    if (!this.sessionCfg.reuseByContext) return false;

    const entry = this.contextMap.get(contextId);
    if (!entry) return false;

    try {
      await this.client.sessionGet(entry.sessionId, this.directory || undefined);
      entry.lastUsed = Date.now();
      return true;
    } catch {
      this.contextMap.delete(contextId);
      this.persistMap();
      return false;
    }
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
    // Cancel any pending debounced write and flush synchronously before clearing
    // state, so the final snapshot is not lost when the process shuts down.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      const path = this.sessionCfg.sessionMapFile;
      if (path) {
        try {
          fs.writeFileSync(path, JSON.stringify(Object.fromEntries(this.contextMap)), "utf-8");
        } catch (e) {
          log.error("Failed to persist session map on shutdown", { error: e });
        }
      }
    }
    this.contextMap.clear();
    this.taskMap.clear();
    this.taskContexts.clear();
  }
}
