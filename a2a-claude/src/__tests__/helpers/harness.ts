/** Test harness: serve a `ClaudeProvider` over scripted fake Claude queries through the real request handler. */

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
import { ClaudeProvider } from "../../claude/provider.js";
import { registryOptionsOf } from "../../server/index.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";
import type { ClaudeClientLike } from "../../claude/client-factory.js";
import { FakeClaudeClient, type FakeTurnScript } from "./fake-client.js";
import { ManualClient } from "./manual-client.js";

export type Config = Required<AgentConfig>;

/** A fresh workspace and config for each test; `ctx.config` is mutable until the first `serve`. */
export function useWorkspace(prefix = "a2a-claude-ws-"): { ws: string; config: Config } {
  const ctx = { ws: "", config: undefined as unknown as Config };
  beforeEach(() => {
    ctx.ws = mkdtempSync(join(tmpdir(), prefix));
    ctx.config = JSON.parse(JSON.stringify({ ...DEFAULTS, configDir: ctx.ws })) as Config;
    ctx.config.claude.workingDirectory = ctx.ws;
    ctx.config.events = { enabled: false } as Config["events"];
  });
  afterEach(() => rmSync(ctx.ws, { recursive: true, force: true }));
  return ctx;
}

export interface Served {
  client: FakeClaudeClient;
  provider: ClaudeProvider;
  server: ProviderTestServer;
}

export function serve(
  config: Config,
  scripts: FakeTurnScript[],
  opts: { eventTransport?: EventTransport | EventTransportFn; runStore?: RunStore; client?: FakeClaudeClient } = {},
): Served {
  const client = opts.client ?? new FakeClaudeClient(scripts);
  const provider = new ClaudeProvider(config, {
    clientFactory: () => client,
    ...(opts.eventTransport ? { eventTransport: opts.eventTransport } : {}),
  });
  // The same run runtime options the real server builds (interaction policy, session lifetime).
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

/** Serve a provider over a client the test drives by hand (`ManualClient`). */
export function serveManual(config: Config, opts: { runStore?: RunStore; eventTransport?: EventTransport | EventTransportFn } = {}) {
  const client = new ManualClient();
  const provider = new ClaudeProvider(config, {
    clientFactory: () => client as ClaudeClientLike,
    ...(opts.eventTransport ? { eventTransport: opts.eventTransport } : {}),
  });
  const server = createProviderTestServer(provider, { registry: registryOptionsOf(config, opts.runStore) });
  return { client, provider, server };
}
