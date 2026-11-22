/** Run one task through the provider and the real request handler with a manual session that plays usage events. */

import { createProviderTestServer, summarizeEvent, type EventSummary } from "@a2a-wrapper/core";
import { CopilotProvider } from "../../copilot/provider.js";
import { makeConfig, type ConfigOptions } from "./config.js";
import { ManualClient, ManualSession } from "./manual-session.js";

/** An `assistant.usage` event payload. */
export function usagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-4",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    duration: 200,
    timeToFirstTokenMs: 80,
    cost: 0,
    apiEndpoint: null,
    initiator: null,
    ...overrides,
  };
}

export interface RunTaskOptions extends ConfigOptions {
  usage?: Record<string, unknown>[];
  /** Non-streaming: make `sendAndWait` throw after the usage events fired. */
  fail?: Error;
  /** Make the session fail to open. */
  failCreate?: Error;
  /** The answer text. */
  text?: string;
}

export async function runTask(opts: RunTaskOptions = {}) {
  const config = makeConfig(opts);
  const session = new ManualSession();
  const client = new ManualClient([session]);
  if (opts.failCreate) client.failCreate = opts.failCreate;
  const provider = new CopilotProvider(config, { clientFactory: () => client as never });
  const server = createProviderTestServer(provider);

  const fire = (): void => {
    for (const u of opts.usage ?? []) session.emit("assistant.usage", u);
  };
  if (config.copilot.streaming) {
    session.send.mockImplementation(async () => {
      queueMicrotask(() => {
        fire();
        if (opts.text) session.emit("assistant.message_delta", { deltaContent: opts.text });
        session.emit("session.idle");
      });
      return "m";
    });
  } else {
    session.sendAndWait.mockImplementation(async () => {
      fire();
      if (opts.fail) throw opts.fail;
      return { data: { content: opts.text ?? "assistant response" } };
    });
  }

  const started = Date.now();
  const { events, error } = await server.stream({ text: "hello", contextId: "ctx-1" });
  const summary: EventSummary[] = events.map(summarizeEvent);
  return { events, error, summary, session, server, provider, elapsedMs: Date.now() - started };
}

/** The `x-usage` of the completed status. */
export function xUsageOf(summary: EventSummary[]): any {
  const done = summary.find((e) => e.k === "status" && e.state === "completed") as { usage?: unknown } | undefined;
  return done?.usage;
}
