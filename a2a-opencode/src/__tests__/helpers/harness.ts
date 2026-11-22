/** Test harness: serve an `OpenCodeProvider` over a scripted fake OpenCode server through the real request handler. */

import { beforeEach } from "vitest";
import {
  createProviderTestServer,
  summarizeEvent,
  type EventSummary,
  type EventTransport,
  type EventTransportFn,
  type ProviderTestServer,
  type RunStore,
} from "@a2a-wrapper/core";
import { OpenCodeProvider } from "../../opencode/provider.js";
import { registryOptionsOf } from "../../server/index.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";
import { FakeBackend, type FakeBackendOptions } from "./fake-backend.js";

export type Config = Required<AgentConfig>;

/** A fresh config for each test; `ctx.config` is mutable until the first `serve`. */
export function useConfig(): { config: Config } {
  const ctx = { config: undefined as unknown as Config };
  beforeEach(() => {
    ctx.config = JSON.parse(JSON.stringify(DEFAULTS)) as Config;
    ctx.config.events = { enabled: false } as Config["events"];
    ctx.config.timeouts = { ...ctx.config.timeouts, prompt: 5_000 };
    ctx.config.logging = { level: "error" };
  });
  return ctx;
}

export interface Served {
  backend: FakeBackend;
  provider: OpenCodeProvider;
  server: ProviderTestServer;
}

export function serve(
  config: Config,
  backendOptions: FakeBackendOptions | FakeBackend = {},
  opts: { eventTransport?: EventTransport | EventTransportFn; runStore?: RunStore; taskStore?: any; streamReconnect?: { maxRetries?: number; initialDelay?: number } } = {},
): Served {
  const backend = backendOptions instanceof FakeBackend ? backendOptions : new FakeBackend(backendOptions);
  const provider = new OpenCodeProvider(config, {
    backendFactory: async () => backend as never,
    ...(opts.eventTransport ? { eventTransport: opts.eventTransport } : {}),
    ...(opts.streamReconnect ? { streamReconnect: opts.streamReconnect } : {}),
  });
  // The same run runtime options the real server builds (interaction policy, session lifetime).
  const server = createProviderTestServer(provider, {
    registry: registryOptionsOf(config, opts.runStore),
    ...(opts.taskStore ? { taskStore: opts.taskStore } : {}),
  });
  return { backend, provider, server };
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
