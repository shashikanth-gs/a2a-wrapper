/**
 * Session Manager — Claude Session Lifecycle
 *
 * Maps A2A contextId → Claude Code session id for multi-turn continuity.
 * Serializes turns within the same context via a promise-chain queue.
 * Tracks active executions (abort controller + query handle) for cancellation.
 */

import type { QueryLike } from "./client-factory.js";
import type { AgentConfig } from "../config/types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("session-manager");

export interface ClaudeSession {
  contextId: string;
  /** Claude session id — null until the first system:init message arrives. */
  sessionId: string | null;
  createdAt: number;
  lastAccessedAt: number;
  /** Promise chain used to serialize turns within this context. */
  executionQueue: Promise<void>;
}

export interface ActiveExecution {
  taskId: string;
  contextId: string;
  abortController: AbortController;
  /** Live query handle for interrupt() support. Attached once the turn starts. */
  query?: QueryLike;
}

export class SessionManager {
  private readonly config: Required<AgentConfig>;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Required<AgentConfig>) {
    this.config = config;
  }

  getOrCreate(contextId: string): ClaudeSession {
    const sessionCfg = this.config.session;
    const ttl = sessionCfg.ttl ?? 3_600_000;
    const reuse = sessionCfg.reuseByContext ?? true;

    if (reuse && contextId) {
      const existing = this.sessions.get(contextId);
      if (existing) {
        const age = Date.now() - existing.createdAt;
        if (age < ttl) {
          existing.lastAccessedAt = Date.now();
          log.debug("Reusing Claude session", { contextId, sessionId: existing.sessionId });
          return existing;
        }
        // Check if there are active executions before expiring the session
        if (this.getActiveTasksForContext(contextId).length > 0) {
          existing.lastAccessedAt = Date.now();
          log.debug("Reusing Claude session (preserved by active execution)", { contextId, sessionId: existing.sessionId });
          return existing;
        }
        log.info("Session TTL expired, starting fresh", { contextId, age });
        this.sessions.delete(contextId);
      }
    }

    const session: ClaudeSession = {
      contextId,
      sessionId: null,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      executionQueue: Promise.resolve(),
    };
    if (contextId) this.sessions.set(contextId, session);
    log.info("Created new Claude session record", { contextId });
    return session;
  }

  trackExecution(taskId: string, contextId: string, abortController: AbortController): ActiveExecution {
    const exec: ActiveExecution = { taskId, contextId, abortController };
    this.activeExecutions.set(taskId, exec);
    return exec;
  }

  attachQuery(taskId: string, q: QueryLike): void {
    const exec = this.activeExecutions.get(taskId);
    if (exec) exec.query = q;
  }

  untrackExecution(taskId: string): void {
    this.activeExecutions.delete(taskId);
  }

  getExecution(taskId: string): ActiveExecution | undefined {
    return this.activeExecutions.get(taskId);
  }

  getActiveTasksForContext(contextId: string): string[] {
    const tasks: string[] = [];
    for (const [taskId, exec] of this.activeExecutions.entries()) {
      if (exec.contextId === contextId) tasks.push(taskId);
    }
    return tasks;
  }

  startCleanup(interval: number, ttl: number): void {
    if (interval <= 0) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [contextId, session] of this.sessions.entries()) {
        if (now - session.lastAccessedAt > ttl) {
          if (this.getActiveTasksForContext(contextId).length > 0) {
            log.debug("Skipping TTL cleanup — active execution", { contextId });
            continue;
          }
          log.info("TTL cleanup: removing stale session", { contextId, sessionId: session.sessionId });
          this.sessions.delete(contextId);
        }
      }
    }, interval);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
