/**
 * Tests — usage and lifecycle events reach the configured event transport (#56)
 *
 * Before the fix, CopilotExecutor published per-call `trace.usage` and the usage
 * summary straight onto the A2A event bus and emitted no lifecycle events, so an
 * HTTP event collector saw `tool_call_*` events but no `agent_started`,
 * `agent_finished` or usage.
 *
 * These tests run the executor against a mocked Copilot SDK session and a real
 * local HTTP collector, mirroring the reproduction in the issue
 * (`events: { enabled: true, transport: "http", httpUrl, httpHeaders }`).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import type { Message as A2AMessage } from "@a2a-js/sdk";

import { CopilotExecutor } from "../copilot/executor.js";
import type { CopilotSession } from "../copilot/session-manager.js";

// ─── Collector ───────────────────────────────────────────────────────────────

interface Collected {
  eventType: string;
  eventId: string;
  agentName: string;
  data: Record<string, any>;
  headers: Record<string, string | string[] | undefined>;
}

let collectorServer: Server | undefined;

/** Start an HTTP collector. `hang` makes it accept requests but never respond. */
async function startCollector(opts: { hang?: boolean } = {}) {
  const received: Collected[] = [];
  collectorServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        received.push({ ...JSON.parse(body), headers: req.headers });
      } catch {
        /* ignore malformed */
      }
      if (opts.hang) return; // never answer
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise<void>((r) => collectorServer!.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(collectorServer.address() as AddressInfo).port}/events`;
  return { url, received };
}

afterEach(async () => {
  if (collectorServer) {
    collectorServer.closeAllConnections?.();
    await new Promise<void>((r) => collectorServer!.close(() => r()));
    collectorServer = undefined;
  }
});

// ─── Harness (same approach as usage-telemetry.test.ts) ──────────────────────

function makeConfig(opts: { streaming: boolean; events: Record<string, unknown> }): any {
  return {
    agentCard: { name: "Test Agent", description: "test" },
    server: { port: 3000, hostname: "0.0.0.0", advertiseHost: "localhost", advertiseProtocol: "http" },
    copilot: {
      cliUrl: "", model: "gpt-4.1", streaming: opts.streaming, systemPrompt: "", systemPromptMode: "append",
      contextFile: "context.md", contextPrompt: "", workspaceDirectory: "",
    },
    session: { reuseByContext: true, ttl: 3_600_000, cleanupInterval: 300_000, titlePrefix: "A2A" },
    features: { streamArtifactChunks: false, trackUsage: false },
    timeouts: { prompt: 600_000 },
    logging: { level: "error" },
    mcp: {}, customAgents: [],
    events: opts.events,
    memory: undefined, configDir: undefined, subAgents: undefined,
  };
}

function makeUserMessage(text: string): A2AMessage {
  return {
    messageId: "msg-1", contextId: "ctx-test", taskId: "", role: 1,
    parts: [{ content: { $case: "text", value: text }, metadata: undefined }],
    metadata: undefined, extensions: [], referenceTaskIds: [],
  } as unknown as A2AMessage;
}

function makeContext(): RequestContext {
  return { taskId: "task-1", contextId: "ctx-1", userMessage: makeUserMessage("hello"), task: null } as RequestContext;
}

function makeMockBus() {
  const events: any[] = [];
  const bus = { publish: vi.fn((e: any) => { events.push(e); }), finished: vi.fn(), events };
  return bus as typeof bus & ExecutionEventBus;
}

function makeMockSession() {
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const session: CopilotSession & { emit: (event: string, data?: unknown) => void } = {
    sessionId: "sess-1",
    on: vi.fn((event: string, handler: (e: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return () => {
        const arr = handlers.get(event) ?? [];
        const i = arr.indexOf(handler);
        if (i !== -1) arr.splice(i, 1);
      };
    }),
    send: vi.fn(async () => {}),
    sendAndWait: vi.fn(async () => ({ data: { content: "assistant response" } })),
    disconnect: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    emit(event: string, data?: unknown) {
      for (const h of handlers.get(event) ?? []) h({ data });
    },
  } as any;
  return session;
}

function usagePayload(overrides: Record<string, unknown> = {}) {
  return {
    model: "gpt-4.1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, duration: 200, timeToFirstTokenMs: 80, cost: 1, apiEndpoint: null, initiator: null,
    ...overrides,
  };
}

/**
 * Run one task. `fail` makes the run throw after the usage events have fired
 * (non-streaming path), so the executor takes its error branch.
 */
async function run(opts: {
  streaming: boolean;
  events: Record<string, unknown>;
  usage?: Record<string, unknown>[];
  fail?: Error;
}) {
  const executor = new CopilotExecutor(makeConfig(opts));
  const session = makeMockSession();
  const bus = makeMockBus();
  vi.spyOn(executor as any, "initialize").mockResolvedValue(undefined);
  (executor as any).sessionManager = {
    getOrCreate: vi.fn(async () => ({ sessionId: session.sessionId, session, isNew: true })),
    trackTask: vi.fn(), untrackTask: vi.fn(), getSessionForTask: vi.fn(),
    getContextForTask: vi.fn(() => "ctx-1"), startCleanup: vi.fn(), shutdown: vi.fn(async () => {}),
  };
  (executor as any).mcpHooks = { setEmitter: vi.fn(), clearEmitter: vi.fn() };

  const fire = () => { for (const u of opts.usage ?? []) session.emit("assistant.usage", u); };
  if (opts.streaming) {
    session.send = vi.fn(async () => { fire(); session.emit("session.idle"); });
  } else {
    session.sendAndWait = vi.fn(async () => {
      fire();
      if (opts.fail) throw opts.fail;
      return { data: { content: "assistant response" } };
    });
  }

  const started = Date.now();
  await executor.execute(makeContext(), bus as any);
  return { bus, elapsedMs: Date.now() - started };
}

const types = (r: Collected[]) => r.map((e) => e.eventType);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HTTP event transport carries lifecycle and usage (#56)", () => {
  it("sends agent_started first and agent_finished last, with the usage summary", async () => {
    const { url, received } = await startCollector();
    await run({
      streaming: true,
      events: { enabled: true, transport: "http", httpUrl: url, httpHeaders: { Authorization: "Bearer t0ken" } },
      usage: [usagePayload({ inputTokens: 100, outputTokens: 50, cost: 1 }), usagePayload({ inputTokens: 30, outputTokens: 20, cost: 2 })],
    });

    // The terminal event is awaited, so the collector already has everything when execute() returns.
    const t = types(received);
    expect(t[0]).toBe("agent_started");
    expect(t[t.length - 1]).toBe("agent_finished");
    expect(t.filter((x) => x === "agent_finished")).toHaveLength(1);
    expect(t).not.toContain("agent_error");

    const finished = received[received.length - 1];
    expect(finished.agentName).toBe("Test Agent");
    expect(finished.data.backend).toBe("copilot");
    expect(finished.data.usage).toMatchObject({
      inputTokens: 130, outputTokens: 70, llmCalls: 2, model: "gpt-4.1", cost: 3,
    });
    expect(finished.data.usage.calls).toHaveLength(2);
    // Auth headers configured for the transport are delivered.
    expect(finished.headers["authorization"]).toBe("Bearer t0ken");
  });

  it("gives every event a distinct UUID event id", async () => {
    const { url, received } = await startCollector();
    await run({ streaming: true, events: { enabled: true, transport: "http", httpUrl: url }, usage: [usagePayload()] });
    const ids = received.map((e) => e.eventId);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never estimates cost: stays null when the provider reports none", async () => {
    const { url, received } = await startCollector();
    await run({
      streaming: true,
      events: { enabled: true, transport: "http", httpUrl: url },
      usage: [usagePayload({ cost: undefined }), usagePayload({ cost: undefined })],
    });
    const finished = received.find((e) => e.eventType === "agent_finished")!;
    expect(finished.data.usage.cost).toBeNull();
    expect(finished.data.usage.calls.every((c: any) => c.cost === null)).toBe(true);
  });

  it("reports usage: null when no LLM call was recorded", async () => {
    const { url, received } = await startCollector();
    await run({ streaming: true, events: { enabled: true, transport: "http", httpUrl: url }, usage: [] });
    const finished = received.find((e) => e.eventType === "agent_finished")!;
    // accumulator.summary() is always present; with zero calls the totals are zero.
    expect(finished.data.usage.llmCalls).toBe(0);
    expect(finished.data.usage.cost).toBeNull();
  });

  it("works in non-streaming mode too", async () => {
    const { url, received } = await startCollector();
    await run({ streaming: false, events: { enabled: true, transport: "http", httpUrl: url }, usage: [usagePayload()] });
    expect(types(received)[0]).toBe("agent_started");
    const finished = received.find((e) => e.eventType === "agent_finished")!;
    expect(finished.data.usage.llmCalls).toBe(1);
  });

  it("on failure sends agent_error (with usage spent so far) and no agent_finished", async () => {
    const { url, received } = await startCollector();
    await run({
      streaming: false,
      events: { enabled: true, transport: "http", httpUrl: url },
      usage: [usagePayload({ inputTokens: 42 })],
      fail: new Error("boom"),
    });
    const t = types(received);
    expect(t[0]).toBe("agent_started");
    expect(t).toContain("agent_error");
    expect(t).not.toContain("agent_finished");
    const err = received.find((e) => e.eventType === "agent_error")!;
    expect(err.data.backend).toBe("copilot");
    expect(err.data.message).toContain("boom");
    expect(err.data.usage).toMatchObject({ inputTokens: 42, llmCalls: 1 });
  });

  it("agent_error carries usage: null when no call was made before the failure", async () => {
    const { url, received } = await startCollector();
    await run({ streaming: false, events: { enabled: true, transport: "http", httpUrl: url }, usage: [], fail: new Error("early") });
    const err = received.find((e) => e.eventType === "agent_error")!;
    expect(err.data.usage).toBeNull();
  });

  it("sends nothing when events are disabled", async () => {
    const { url, received } = await startCollector();
    await run({ streaming: true, events: { enabled: false, transport: "http", httpUrl: url }, usage: [usagePayload()] });
    expect(received).toHaveLength(0);
  });

  it("does not let an unresponsive collector stall task completion", async () => {
    const { url } = await startCollector({ hang: true });
    const { bus, elapsedMs } = await run({
      streaming: true,
      events: { enabled: true, transport: "http", httpUrl: url, httpTimeout: 10_000 },
      usage: [usagePayload()],
    });
    // The terminal emit is capped at 2s; the default HTTP timeout alone would be 10s.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(bus.finished).toHaveBeenCalled();
  }, 15_000);
});

describe("A2A transport (default) and the existing x-usage path", () => {
  it("publishes trace.lifecycle artifacts and keeps x-usage on the completed status", async () => {
    const { bus } = await run({ streaming: true, events: { enabled: true, transport: "a2a" }, usage: [usagePayload()] });

    const lifecycle = bus.events
      .filter((e: any) => e?.kind === "artifactUpdate" && e.data?.artifact?.name === "trace.lifecycle")
      .map((e: any) => e.data.artifact.parts[0].content.value);
    expect(lifecycle.map((d: any) => d.state)).toEqual(["started", "finished"]);
    expect(lifecycle[1].usage.llmCalls).toBe(1);

    const completed = bus.events.find(
      (e: any) => e?.kind === "statusUpdate" && e.data?.metadata?.["x-usage"],
    );
    expect(completed?.data.metadata["x-usage"].llmCalls).toBe(1);
  });
});
