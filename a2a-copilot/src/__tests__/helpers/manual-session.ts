/**
 * A Copilot session the test drives by hand: nothing happens on `send` until the test emits events, and an `abort` can
 * be made to succeed, fail or hang. For the cancel, steering and interaction tests.
 */

import { vi } from "vitest";

export class ManualSession {
  readonly sessionId: string;
  private readonly handlers = new Map<string, Array<(e: unknown) => void>>();
  private rejectSendAndWait: ((e: Error) => void) | undefined;

  readonly send = vi.fn(async (_params: { prompt: string; mode?: string; clientTurnId?: string }): Promise<unknown> => "msg");
  readonly sendAndWait = vi.fn(
    (_params: { prompt: string }, _timeout?: number) =>
      new Promise<any>((_res, rej) => {
        this.rejectSendAndWait = rej;
      }),
  );
  /** Like the real SDK, an aborted sendAndWait rejects. */
  readonly abort = vi.fn(async () => {
    this.rejectSendAndWait?.(new Error("Request aborted"));
  });
  readonly disconnect = vi.fn(async () => {});
  readonly rpc = { queue: { clear: vi.fn(async () => {}) } };

  constructor(sessionId = "sess-1") {
    this.sessionId = sessionId;
  }

  on = vi.fn((event: string, h: (e: unknown) => void) => {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(h);
    return () => {
      const arr = this.handlers.get(event) ?? [];
      const i = arr.indexOf(h);
      if (i !== -1) arr.splice(i, 1);
    };
  });

  emit(event: string, data?: unknown): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) h({ type: event, data });
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}

/** A client that hands out the given sessions in order (the last one repeats), and resumes the ones it handed out. */
export class ManualClient {
  readonly created: ManualSession[] = [];
  readonly resumed: string[] = [];
  readonly createOptions: Array<Record<string, unknown>> = [];
  readonly known = new Map<string, ManualSession>();
  /** Delay `createSession` until the test releases it. */
  gate?: Promise<void>;
  /** Make `createSession` fail. */
  failCreate?: Error;

  constructor(private readonly sessions: ManualSession[]) {}

  start = vi.fn(async () => {});
  stop = vi.fn(async () => []);

  async createSession(options: Record<string, unknown>): Promise<ManualSession> {
    this.createOptions.push(options);
    if (this.gate) await this.gate;
    if (this.failCreate) throw this.failCreate;
    const s = this.sessions[Math.min(this.created.length, this.sessions.length - 1)];
    this.created.push(s);
    this.known.set(s.sessionId, s);
    return s;
  }

  async resumeSession(id: string, options: Record<string, unknown>): Promise<ManualSession> {
    this.createOptions.push(options);
    this.resumed.push(id);
    const s = this.known.get(id);
    if (!s) throw new Error(`Session not found: ${id}`);
    return s;
  }

  async getSessionMetadata(id: string): Promise<unknown | undefined> {
    return this.known.has(id) ? { sessionId: id } : undefined;
  }
}
