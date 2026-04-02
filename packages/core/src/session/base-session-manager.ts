/**
 * Base Session Manager
 *
 * Provides the abstract foundation for session lifecycle management across
 * all A2A wrapper projects. This module handles the mapping from A2A
 * `contextId` values to backend-specific session entries, TTL-based
 * expiration with periodic cleanup sweeps, and task-to-session tracking
 * required for cancel support.
 *
 * Wrapper projects extend {@link BaseSessionManager} and implement the
 * abstract {@link BaseSessionManager.getOrCreate | getOrCreate} method to
 * provide backend-specific session creation logic (e.g. creating a Copilot
 * SDK session or an OpenCode session). All shared bookkeeping — context map
 * management, cleanup timers, task tracking — lives here so that each
 * wrapper only contains its backend-specific code.
 *
 * The class is parameterized by `TSession`, the backend session object type,
 * enabling full type safety without runtime coupling to any specific backend.
 *
 * @module session/base-session-manager
 */

import type { SessionConfig } from "../config/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Internal session entry stored by {@link BaseSessionManager}.
 *
 * Each entry pairs a backend session object with metadata used for
 * TTL-based expiration and session reuse decisions. The `lastUsed`
 * timestamp is updated on every successful `getOrCreate` hit so that
 * active sessions are not prematurely evicted by the cleanup sweep.
 *
 * @typeParam TSession - The backend-specific session object type
 *   (e.g. `CopilotSession`, `string` session ID for OpenCode).
 */
export interface SessionEntry<TSession> {
  /** Unique session identifier assigned by the backend. */
  sessionId: string;

  /**
   * The backend session object.
   * May be a rich SDK object (CopilotSession) or a simple identifier
   * (string session ID for OpenCode), depending on the wrapper.
   */
  session: TSession;

  /** Timestamp (ms since epoch) when this session was first created. */
  createdAt: number;

  /**
   * Timestamp (ms since epoch) of last activity on this session.
   * Updated on every `getOrCreate` cache hit. Used by the cleanup
   * sweep to determine whether the session has exceeded its TTL.
   */
  lastUsed: number;
}

// ─── Abstract Base Class ────────────────────────────────────────────────────

/**
 * Abstract base class for session lifecycle management.
 *
 * Manages the mapping from A2A `contextId` to backend session entries,
 * TTL-based cleanup, and task-to-session tracking for cancel support.
 * Wrapper projects extend this class and implement
 * {@link BaseSessionManager.getOrCreate | getOrCreate} to provide
 * backend-specific session creation logic.
 *
 * Key behaviors:
 * - **TTL-based cleanup**: A periodic timer removes sessions whose
 *   `lastUsed` timestamp exceeds the configured TTL.
 * - **Idempotent `startCleanup`**: Calling `startCleanup()` when a timer
 *   is already running is a safe no-op.
 * - **Task tracking**: Maps `taskId` → `sessionId` and optionally
 *   `taskId` → `contextId` so that cancel operations can locate the
 *   correct session and emit the correct contextId.
 * - **Protected helpers**: Subclasses access the context map through
 *   {@link getSessionEntry}, {@link setSessionEntry}, and
 *   {@link deleteSessionEntry} without direct map access.
 *
 * @typeParam TSession - The backend-specific session object type
 *   (e.g. `CopilotSession`, `string` session ID for OpenCode).
 */
export abstract class BaseSessionManager<TSession> {
  /**
   * Resolved session configuration controlling TTL, cleanup interval,
   * context reuse, and session title prefix.
   */
  protected readonly sessionConfig: Required<SessionConfig>;

  /** A2A contextId → session entry. */
  private readonly contextMap = new Map<string, SessionEntry<TSession>>();

  /** taskId → sessionId for cancel support. */
  private readonly taskMap = new Map<string, string>();

  /** taskId → contextId for cancel support. */
  private readonly taskContexts = new Map<string, string>();

  /** Handle for the periodic cleanup interval, or `null` when stopped. */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Create a new session manager instance.
   *
   * @param sessionConfig - Fully resolved session configuration. All
   *   optional fields must already be filled with defaults so that the
   *   manager can rely on every value being present.
   */
  constructor(sessionConfig: Required<SessionConfig>) {
    this.sessionConfig = sessionConfig;
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  /**
   * Start periodic cleanup of expired sessions.
   *
   * Sessions whose `lastUsed` timestamp exceeds the configured
   * {@link SessionConfig.ttl | ttl} are removed from the context map
   * on each sweep. The sweep interval is controlled by
   * {@link SessionConfig.cleanupInterval | cleanupInterval}.
   *
   * This method is idempotent — calling it when a timer is already
   * running is a safe no-op.
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [contextId, entry] of this.contextMap) {
        if (now - entry.lastUsed > this.sessionConfig.ttl) {
          this.contextMap.delete(contextId);
        }
      }
    }, this.sessionConfig.cleanupInterval);

    // Allow the Node.js process to exit even if the timer is still active.
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop the periodic cleanup timer.
   *
   * Safe to call even if no timer is running. After calling this method,
   * expired sessions will no longer be automatically evicted until
   * {@link startCleanup} is called again.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────

  /**
   * Get or create a backend session for the given A2A contextId.
   *
   * Subclasses implement this method to provide backend-specific session
   * creation logic. The implementation should use the protected helpers
   * ({@link getSessionEntry}, {@link setSessionEntry},
   * {@link deleteSessionEntry}) to interact with the context map.
   *
   * When `reuseByContext` is enabled in the session config, the
   * implementation should check for an existing entry and return its
   * session if the entry has not exceeded TTL.
   *
   * @param contextId - The A2A contextId identifying the conversation.
   * @returns The backend session object for this context.
   */
  abstract getOrCreate(contextId: string): Promise<TSession>;

  // ─── Task Tracking ──────────────────────────────────────────────────────

  /**
   * Track a task → session + context mapping for cancel support.
   *
   * Called by the executor when a new task begins execution so that
   * subsequent cancel requests can locate the correct session and
   * emit the correct contextId in status events.
   *
   * @param taskId - The A2A task identifier.
   * @param sessionId - The backend session identifier handling this task.
   * @param contextId - Optional A2A contextId associated with this task.
   */
  trackTask(taskId: string, sessionId: string, contextId?: string): void {
    this.taskMap.set(taskId, sessionId);
    if (contextId) {
      this.taskContexts.set(taskId, contextId);
    }
  }

  /**
   * Get the session identifier for a tracked task.
   *
   * Used by cancel handlers to find the backend session that should
   * be interrupted.
   *
   * @param taskId - The A2A task identifier.
   * @returns The session identifier, or `undefined` if the task is not tracked.
   */
  getSessionForTask(taskId: string): string | undefined {
    return this.taskMap.get(taskId);
  }

  /**
   * Get the A2A contextId for a tracked task.
   *
   * Used by cancel handlers to emit the correct contextId in status
   * update events when cancelling a task.
   *
   * @param taskId - The A2A task identifier.
   * @returns The contextId, or `undefined` if the task is not tracked
   *   or was tracked without a contextId.
   */
  getContextForTask(taskId: string): string | undefined {
    return this.taskContexts.get(taskId);
  }

  /**
   * Remove task tracking for a completed or cancelled task.
   *
   * Should be called when a task finishes (successfully or otherwise)
   * to prevent unbounded growth of the task tracking maps.
   *
   * @param taskId - The A2A task identifier to stop tracking.
   */
  untrackTask(taskId: string): void {
    this.taskMap.delete(taskId);
    this.taskContexts.delete(taskId);
  }

  // ─── Shutdown ───────────────────────────────────────────────────────────

  /**
   * Shut down the session manager.
   *
   * Stops the cleanup timer and clears all internal maps (context map,
   * task map, task contexts). After calling this method, the session
   * manager is in a clean state and should not be reused.
   *
   * Subclasses that need to perform additional cleanup (e.g. destroying
   * backend sessions) should override this method and call `super.shutdown()`.
   */
  shutdown(): void {
    this.stopCleanup();
    this.contextMap.clear();
    this.taskMap.clear();
    this.taskContexts.clear();
  }

  // ─── Protected Helpers ──────────────────────────────────────────────────

  /**
   * Retrieve a session entry from the context map.
   *
   * Subclasses use this in their {@link getOrCreate} implementation to
   * check for an existing session before creating a new one.
   *
   * @param contextId - The A2A contextId to look up.
   * @returns The session entry, or `undefined` if no session exists
   *   for this contextId.
   */
  protected getSessionEntry(contextId: string): SessionEntry<TSession> | undefined {
    return this.contextMap.get(contextId);
  }

  /**
   * Store or update a session entry in the context map.
   *
   * Subclasses use this in their {@link getOrCreate} implementation to
   * register a newly created session or update an existing entry.
   *
   * @param contextId - The A2A contextId to associate with the entry.
   * @param entry - The session entry to store.
   */
  protected setSessionEntry(contextId: string, entry: SessionEntry<TSession>): void {
    this.contextMap.set(contextId, entry);
  }

  /**
   * Remove a session entry from the context map.
   *
   * Subclasses use this when a session is destroyed or invalidated
   * (e.g. backend reports the session no longer exists).
   *
   * @param contextId - The A2A contextId whose entry should be removed.
   */
  protected deleteSessionEntry(contextId: string): void {
    this.contextMap.delete(contextId);
  }
}
