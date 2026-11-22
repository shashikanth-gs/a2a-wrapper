/** Test harness: serve a `CodexProvider` over fake Codex threads through the real request handler. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
  createProviderTestServer,
  summarizeEvent,
  type EventSummary,
  type EventTransport,
  type EventTransportFn,
  type ProviderTestServer,
  type RunStore,
} from "@a2a-wrapper/core";
import { CodexProvider } from "../../codex/provider.js";
import { registryOptionsOf } from "../../server/index.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";
import type { CodexClientLike, CodexThreadLike, ThreadEventLike, ThreadOptionsLike } from "../../codex/client-factory.js";

export type Config = Required<AgentConfig>;

export const T1 = "019a0000-0000-7000-8000-000000000001";
export const T2 = "019a0000-0000-7000-8000-000000000002";
export const T3 = "019a0000-0000-7000-8000-000000000003";

/** A fresh workspace and config for each test; `ctx.config` is mutable until the first `serve`. */
export function useWorkspace(prefix = "a2a-codex-ws-"): { ws: string; config: Config } {
  const ctx = { ws: "", config: undefined as unknown as Config };
  beforeEach(() => {
    ctx.ws = mkdtempSync(join(tmpdir(), prefix));
    ctx.config = JSON.parse(JSON.stringify({ ...DEFAULTS, configDir: ctx.ws })) as Config;
    ctx.config.codex.workingDirectory = ctx.ws;
    ctx.config.codex.model = "test-model";
    ctx.config.logging = { level: "error" };
    ctx.config.events = { enabled: false } as Config["events"];
  });
  afterEach(() => rmSync(ctx.ws, { recursive: true, force: true }));
  return ctx;
}

/** What one `runStreamed` call does. */
export type Script =
  | { events: ThreadEventLike[]; throwAfter?: string }
  /** The stream fails before any event (the CLI exited: `codex exec resume <unknown id>`). */
  | { throwBefore: string }
  /** The stream stays open: the test pushes events and ends it, or an abort rejects it like the SDK does. */
  | "manual";

export const started = (id: string): ThreadEventLike[] => [{ type: "thread.started", thread_id: id }, { type: "turn.started" }];
/** The usage Codex reports on `turn.completed` is a running total of the THREAD (see `turn.ts`): `total` scales every counter. */
export const usage = (total = 1) => ({
  input_tokens: 10 * total,
  cached_input_tokens: 4 * total,
  output_tokens: 2 * total,
  reasoning_output_tokens: 1 * total,
});
export const answer = (text: string, total = 1): ThreadEventLike[] => [
  { type: "item.completed", item: { id: "m", type: "agent_message", text } },
  { type: "turn.completed", usage: usage(total) },
];
/** A scripted turn on thread `id` that answers `text`. */
export const turn = (id: string, text: string, total = 1): Script => ({ events: [...started(id), ...answer(text, total)] });

/** One live (manual) stream. */
export class ManualRun {
  readonly signal: AbortSignal | undefined;
  private queue: ThreadEventLike[] = [];
  private wake?: () => void;
  private closed = false;
  private failure?: Error;
  readonly aborted: Promise<void>;
  constructor(signal: AbortSignal | undefined) {
    this.signal = signal;
    this.aborted = new Promise<void>((resolve) => {
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    signal?.addEventListener(
      "abort",
      () => {
        // the SDK rejects the stream when its process is killed by the signal
        this.failure = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
        this.wake?.();
      },
      { once: true },
    );
  }
  push(...events: ThreadEventLike[]): void {
    this.queue.push(...events);
    this.wake?.();
  }
  end(): void {
    this.closed = true;
    this.wake?.();
  }
  fail(message: string): void {
    this.failure = new Error(message);
    this.wake?.();
  }
  async *stream(): AsyncGenerator<ThreadEventLike> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.failure) throw this.failure;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}

export interface Call {
  how: "start" | "resume";
  /** The thread id resumed. */
  id?: string;
  options: ThreadOptionsLike | undefined;
  input: string;
  signal: AbortSignal | undefined;
  /** The stream, when the script was "manual". */
  live?: ManualRun;
}

/** A client whose threads play the scripts in order, one per `runStreamed` call (any thread). */
export class FakeCodex implements CodexClientLike {
  readonly calls: Call[] = [];
  /** `startThread` / `resumeThread` calls (a thread is created per turn). */
  readonly opened: Array<{ how: "start" | "resume"; id?: string; options: ThreadOptionsLike | undefined }> = [];
  private next = 0;
  constructor(private readonly scripts: Script[]) {}

  startThread(options?: ThreadOptionsLike): CodexThreadLike {
    this.opened.push({ how: "start", options });
    return this.thread("start", undefined, options);
  }
  resumeThread(id: string, options?: ThreadOptionsLike): CodexThreadLike {
    this.opened.push({ how: "resume", id, options });
    return this.thread("resume", id, options);
  }
  private thread(how: "start" | "resume", id: string | undefined, options: ThreadOptionsLike | undefined): CodexThreadLike {
    const self = this;
    return {
      id: id ?? null,
      async runStreamed(input: string, opts?: { signal?: AbortSignal }) {
        const script = self.scripts[self.next++];
        if (script === undefined) throw new Error("FakeCodex: no script for this call");
        const call: Call = { how, ...(id ? { id } : {}), options, input, signal: opts?.signal };
        self.calls.push(call);
        if (script === "manual") {
          call.live = new ManualRun(opts?.signal);
          return { events: call.live.stream() };
        }
        if ("throwBefore" in script) {
          async function* failing(): AsyncGenerator<ThreadEventLike> {
            throw new Error(script.throwBefore);
          }
          return { events: failing() };
        }
        async function* events(): AsyncGenerator<ThreadEventLike> {
          for (const e of script.events) yield e;
          if (script.throwAfter) throw new Error(script.throwAfter);
        }
        return { events: events() };
      },
      async run() {
        throw new Error("not used");
      },
    };
  }
}

export interface Served {
  client: FakeCodex;
  provider: CodexProvider;
  server: ProviderTestServer;
}

export function serve(
  config: Config,
  scripts: Script[],
  opts: { eventTransport?: EventTransport | EventTransportFn; runStore?: RunStore; client?: FakeCodex; codexHome?: string } = {},
): Served {
  const client = opts.client ?? new FakeCodex(scripts);
  const provider = new CodexProvider(config, {
    clientFactory: () => client,
    ...(opts.eventTransport ? { eventTransport: opts.eventTransport } : {}),
    ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
  });
  // The same run runtime options the real server builds (session lifetime, store).
  const server = createProviderTestServer(provider, { registry: registryOptionsOf(config, opts.runStore) });
  return { client, provider, server };
}

/** `message/stream` run to its end, as summaries. */
export async function streamText(server: ProviderTestServer, text = "do the thing", contextId = "ctx-1") {
  const got = await server.stream({ text, contextId });
  return { ...got, summary: got.events.map(summarizeEvent) };
}

/** The task and status states of a stream, in order (`submitted` comes from the task snapshot). */
export function states(summary: EventSummary[]): string[] {
  return summary.flatMap((e) => (e.k === "task" || e.k === "status" ? [e.state] : []));
}

export const artifacts = (summary: EventSummary[]) => summary.filter((e): e is Extract<EventSummary, { k: "artifact" }> => e.k === "artifact");
export const responses = (summary: EventSummary[]) => artifacts(summary).filter((a) => a.name === "response");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `pred` is true (polling), or fail. */
export async function until(pred: () => boolean, ms = 2000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`${what} not reached within ${ms}ms`);
    await sleep(5);
  }
}

/** The task id of a live stream (from its first events). */
export function taskIdOf(events: any[]): string {
  const e = events.find((x) => x.payload?.$case === "task" || x.payload?.$case === "statusUpdate");
  return e.payload.value.id ?? e.payload.value.taskId;
}
