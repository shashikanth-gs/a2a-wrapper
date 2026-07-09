/**
 * Session Manager — Antigravity Agent Lifecycle
 *
 * Maps A2A contextId to Python bridge sessions and serializes turns within a
 * context. Active task tracking is used for cancellation.
 */

import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../config/types.js";
import type { BridgeClient } from "./bridge-client.js";
import { logger } from "../utils/logger.js";

const log = logger.child("session-manager");

export interface AntigravitySession {
  sessionId: string;
  contextId: string;
  createdAt: number;
  lastAccessedAt: number;
  executionQueue: Promise<void>;
}

export interface ActiveExecution {
  taskId: string;
  contextId: string;
  sessionId: string;
}

export class SessionManager {
  private readonly bridge: BridgeClient;
  private readonly config: Required<AgentConfig>;
  private readonly sessions = new Map<string, AntigravitySession>();
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(bridge: BridgeClient, config: Required<AgentConfig>) {
    this.bridge = bridge;
    this.config = config;
  }

  async getOrCreate(contextId: string): Promise<AntigravitySession> {
    const sessionCfg = this.config.session;
    const ttl = sessionCfg.ttl ?? 3_600_000;
    const reuse = sessionCfg.reuseByContext ?? true;

    if (reuse && contextId) {
      const existing = this.sessions.get(contextId);
      if (existing) {
        const age = Date.now() - existing.createdAt;
        if (age < ttl) {
          existing.lastAccessedAt = Date.now();
          return existing;
        }
        await this.close(existing);
        this.sessions.delete(contextId);
      }
    }

    const sessionId = `ag-${randomUUID()}`;
    await this.bridge.openSession(sessionId, contextId);
    const session: AntigravitySession = {
      sessionId,
      contextId,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      executionQueue: Promise.resolve(),
    };
    if (contextId) this.sessions.set(contextId, session);
    log.info("Started Antigravity session", { contextId, sessionId });
    return session;
  }

  trackExecution(taskId: string, contextId: string, sessionId: string): void {
    this.activeExecutions.set(taskId, { taskId, contextId, sessionId });
  }

  untrackExecution(taskId: string): void {
    this.activeExecutions.delete(taskId);
  }

  getExecution(taskId: string): ActiveExecution | undefined {
    return this.activeExecutions.get(taskId);
  }

  startCleanup(interval: number, ttl: number): void {
    if (interval <= 0) return;
    this.cleanupTimer = setInterval(() => {
      void this.cleanup(ttl);
    }, interval);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => this.close(session)));
  }

  private async cleanup(ttl: number): Promise<void> {
    const now = Date.now();
    for (const [contextId, session] of this.sessions.entries()) {
      if (now - session.lastAccessedAt <= ttl) continue;
      const active = [...this.activeExecutions.values()].some(
        (execution) => execution.contextId === contextId,
      );
      if (active) continue;
      this.sessions.delete(contextId);
      await this.close(session);
    }
  }

  private async close(session: AntigravitySession): Promise<void> {
    try {
      await this.bridge.closeSession(session.sessionId);
    } catch (err) {
      log.warn("Failed to close Antigravity session", {
        sessionId: session.sessionId,
        error: (err as Error).message,
      });
    }
  }
}
