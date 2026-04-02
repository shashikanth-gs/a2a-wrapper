/**
 * SSE Event Stream Manager
 *
 * Wraps the v2 SDK event.subscribe() with:
 *  - Typed per-event handlers
 *  - Optional session filtering
 *  - Auto-reconnect with exponential backoff
 *  - Graceful disconnect
 */

import type { OpenCodeClientWrapper } from "./client.js";
import type { OpenCodeEvent } from "./types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("event-stream");

// ─── Config ─────────────────────────────────────────────────────────────────

export interface ReconnectConfig {
  maxRetries?: number;      // default: 10
  initialDelay?: number;    // default: 1_000 ms
  maxDelay?: number;        // default: 30_000 ms
  backoffFactor?: number;   // default: 2
}

export interface EventStreamOptions {
  sessionFilter?: string;
  reconnect?: ReconnectConfig;
  directory?: string;
}

export type EventHandler = (event: OpenCodeEvent) => void | Promise<void>;

// ─── Manager ────────────────────────────────────────────────────────────────

export class EventStreamManager {
  private readonly client: OpenCodeClientWrapper;
  private readonly opts: Required<EventStreamOptions>;
  private readonly rcfg: Required<ReconnectConfig>;
  private handlers = new Map<string, Set<EventHandler>>();
  private anyHandlers = new Set<EventHandler>();
  private running = false;
  private abortCtl: AbortController | null = null;
  private failures = 0;
  private consumePromise: Promise<void> | null = null;

  constructor(client: OpenCodeClientWrapper, opts?: EventStreamOptions) {
    this.client = client;
    this.opts = {
      sessionFilter: opts?.sessionFilter ?? "",
      reconnect: opts?.reconnect ?? {},
      directory: opts?.directory ?? "",
    };
    this.rcfg = {
      maxRetries: opts?.reconnect?.maxRetries ?? 10,
      initialDelay: opts?.reconnect?.initialDelay ?? 1_000,
      maxDelay: opts?.reconnect?.maxDelay ?? 30_000,
      backoffFactor: opts?.reconnect?.backoffFactor ?? 2,
    };
  }

  // ── Handler Registration ────────────────────────────────────────────────

  on(eventType: string, handler: EventHandler): this {
    let set = this.handlers.get(eventType);
    if (!set) { set = new Set(); this.handlers.set(eventType, set); }
    set.add(handler);
    return this;
  }

  off(eventType: string, handler: EventHandler): this {
    this.handlers.get(eventType)?.delete(handler);
    return this;
  }

  onAny(handler: EventHandler): this { this.anyHandlers.add(handler); return this; }
  offAny(handler: EventHandler): this { this.anyHandlers.delete(handler); return this; }

  setSessionFilter(sessionID: string): void {
    (this.opts as { sessionFilter: string }).sessionFilter = sessionID;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  get connected(): boolean { return this.running; }

  async connect(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abortCtl = new AbortController();
    this.failures = 0;
    this.consumePromise = this.consumeLoop();
    log.info("Connecting", { session: this.opts.sessionFilter || "(all)" });
  }

  disconnect(): void {
    if (!this.running) return;
    this.running = false;
    this.abortCtl?.abort();
    this.abortCtl = null;
    log.info("Disconnected");
  }

  async waitUntilDone(): Promise<void> { await this.consumePromise; }

  // ── Internal ────────────────────────────────────────────────────────────

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.consumeOnce();
        this.failures = 0;
      } catch (err) {
        if (!this.running) break;
        this.failures++;
        log.warn("Stream error", { error: (err as Error).message, attempt: this.failures });
        if (this.failures >= this.rcfg.maxRetries) {
          log.error("Max retries reached"); this.running = false; break;
        }
        const delay = Math.min(
          this.rcfg.initialDelay * Math.pow(this.rcfg.backoffFactor, this.failures - 1),
          this.rcfg.maxDelay,
        );
        log.info("Reconnecting", { delayMs: delay });
        await this.sleepAbortable(delay);
      }
    }
  }

  private async consumeOnce(): Promise<void> {
    const handle = await this.client.subscribeEvents(this.opts.directory || undefined);
    this.failures = 0;
    try {
      for await (const raw of handle.stream) {
        if (!this.running) break;
        const event = raw as OpenCodeEvent;
        if (!event || typeof event !== "object") continue;
        if (this.opts.sessionFilter) {
          const props = (event as Record<string, unknown>).properties as Record<string, unknown> | undefined;
          const sid = props?.sessionID ?? (props?.info as Record<string, unknown> | undefined)?.sessionID;
          if (sid && sid !== this.opts.sessionFilter) continue;
        }
        this.dispatch(event);
      }
    } finally {
      try { handle.abort(); } catch { /* ignore */ }
    }
  }

  private dispatch(event: OpenCodeEvent): void {
    const type = (event as Record<string, unknown>).type as string;
    const typed = this.handlers.get(type);
    if (typed) for (const h of typed) this.safe(h, event);
    for (const h of this.anyHandlers) this.safe(h, event);
  }

  private safe(handler: EventHandler, event: OpenCodeEvent): void {
    try {
      const r = handler(event);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch((e) =>
          log.error("Async handler error", { error: (e as Error).message }),
        );
      }
    } catch (e) {
      log.error("Sync handler error", { error: (e as Error).message });
    }
  }

  private sleepAbortable(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abortCtl?.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
