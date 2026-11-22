/**
 * Session Manager — Codex Thread Lifecycle
 *
 * Maps A2A contextId → Codex Thread for multi-turn conversation continuity.
 * Serializes turns within the same context via a promise-chain queue.
 * Tracks active executions so TTL cleanup never removes a busy context.
 */

import type { CodexClientLike, CodexThreadLike, ThreadOptionsLike } from "./client-factory.js";
import type { AgentConfig } from "../config/types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("session-manager");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CodexSession {
  contextId: string;
  /** Codex thread ID — null until the first thread.started event fires. */
  threadId: string | null;
  thread: CodexThreadLike;
  createdAt: number;
  lastAccessedAt: number;
  /** Promise chain used to serialize turns within this context. */
  executionQueue: Promise<void>;
}

export interface ActiveExecution {
  taskId: string;
  contextId: string;
}

// ─── SessionManager ───────────────────────────────────────────────────────────

export class SessionManager {
  private readonly client: CodexClientLike;
  private readonly config: Required<AgentConfig>;
  /** contextId → session */
  private readonly sessions = new Map<string, CodexSession>();
  /** taskId → active execution */
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(client: CodexClientLike, config: Required<AgentConfig>) {
    this.client = client;
    this.config = config;
  }

  /**
   * Get an existing session for the contextId, or create a new one using the
   * provided thread factory function. Updates lastAccessedAt on reuse.
   */
  getOrCreate(
    contextId: string,
    threadFactory: () => CodexThreadLike,
  ): CodexSession {
    const sessionCfg = this.config.session;
    const ttl = sessionCfg.ttl ?? 3_600_000;
    const reuse = sessionCfg.reuseByContext ?? true;

    if (reuse && contextId) {
      const existing = this.sessions.get(contextId);
      if (existing) {
        const age = Date.now() - existing.createdAt;
        if (age < ttl) {
          existing.lastAccessedAt = Date.now();
          log.debug("Reusing Codex thread", { contextId, threadId: existing.threadId });
          return existing;
        }
        log.info("Session TTL expired, starting new thread", { contextId, age });
        this.sessions.delete(contextId);
      }
    }

    const thread = threadFactory();
    const session: CodexSession = {
      contextId,
      threadId: null,
      thread,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      executionQueue: Promise.resolve(),
    };

    if (contextId) {
      this.sessions.set(contextId, session);
    }

    log.info("Started new Codex thread", { contextId });
    return session;
  }

  /** Register an active execution for cancellation tracking. */
  trackExecution(taskId: string, contextId: string): void {
    this.activeExecutions.set(taskId, { taskId, contextId });
  }

  /** Remove active execution tracking. */
  untrackExecution(taskId: string): void {
    this.activeExecutions.delete(taskId);
  }

  /** Get the active execution record for a task, if any. */
  getExecution(taskId: string): ActiveExecution | undefined {
    return this.activeExecutions.get(taskId);
  }

  /** Get all active taskIds for a given contextId. */
  getActiveTasksForContext(contextId: string): string[] {
    const tasks: string[] = [];
    for (const [taskId, exec] of this.activeExecutions.entries()) {
      if (exec.contextId === contextId) tasks.push(taskId);
    }
    return tasks;
  }

  /** Start TTL-based cleanup. Call once during executor initialization. */
  startCleanup(interval: number, ttl: number): void {
    if (interval <= 0) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [contextId, session] of this.sessions.entries()) {
        if (now - session.lastAccessedAt > ttl) {
          // Do not remove if there is an active execution for this context
          const activeTasks = this.getActiveTasksForContext(contextId);
          if (activeTasks.length > 0) {
            log.debug("Skipping TTL cleanup — active execution in progress", { contextId, activeTasks });
            continue;
          }
          log.info("TTL cleanup: removing stale session", { contextId, threadId: session.threadId });
          this.sessions.delete(contextId);
        }
      }
    }, interval);
  }

  /** Stop the cleanup timer. */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Build thread options from the resolved agent config. */
  buildThreadOptions(): ThreadOptionsLike {
    const codex = this.config.codex;
    return {
      workingDirectory: codex.workingDirectory || undefined,
      model: codex.model || undefined,
      sandboxMode: codex.sandboxMode ?? "workspace-write",
      approvalPolicy: codex.approvalPolicy ?? "never",
      networkAccessEnabled: codex.networkAccessEnabled ?? false,
      webSearchMode: codex.webSearchMode ?? "disabled",
      skipGitRepoCheck: codex.skipGitRepoCheck ?? false,
      additionalDirectories:
        codex.additionalDirectories && codex.additionalDirectories.length > 0
          ? codex.additionalDirectories
          : undefined,
    };
  }
}
