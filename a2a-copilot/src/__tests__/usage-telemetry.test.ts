/**
 * Integration tests — LLM Usage Telemetry
 *
 * Tests for CopilotExecutor's usage telemetry behaviour:
 *   10.1  streaming + trackUsage:true  → K trace.usage artifacts
 *   10.2  streaming + trackUsage:false → 0 trace.usage artifacts
 *   10.3  final completed event has correct metadata["x-usage"] structure
 *   10.4  metadata["x-usage"] absent on failed / canceled / rejected events
 *   10.5  non-streaming mode emits same metadata["x-usage"] shape as streaming
 *
 * Strategy: mock the Copilot SDK + SessionManager so no real network calls
 * are made. The executor's event handling logic is exercised in isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import type { Message as A2AMessage } from "@a2a-js/sdk";

import { CopilotExecutor } from "../copilot/executor.js";
import type { CopilotSession } from "../copilot/session-manager.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build the minimal Required<AgentConfig> shape the executor needs. */
function makeConfig(overrides: {
  streaming?: boolean;
  trackUsage?: boolean;
} = {}): any {
  return {
    agentCard: { name: "Test Agent", description: "test" },
    server: { port: 3000, hostname: "0.0.0.0", advertiseHost: "localhost", advertiseProtocol: "http" },
    copilot: {
      cliUrl: "",
      model: "gpt-4",
      streaming: overrides.streaming !== false,
      systemPrompt: "",
      systemPromptMode: "append",
      contextFile: "context.md",
      contextPrompt: "",
      workspaceDirectory: "",
    },
    session: { reuseByContext: true, ttl: 3_600_000, cleanupInterval: 300_000, titlePrefix: "A2A" },
    features: {
      streamArtifactChunks: false,
      trackUsage: overrides.trackUsage ?? false,
    },
    timeouts: { prompt: 600_000 },
    logging: { level: "error" },
    mcp: {},
    customAgents: [],
    events: { enabled: true, transport: "a2a" },
    memory: undefined,
    configDir: undefined,
    subAgents: undefined,
  };
}

/** Build a minimal A2A message. */
function makeUserMessage(text: string): A2AMessage {
  return {
    kind: "message",
    messageId: "msg-1",
    role: "user",
    parts: [{ kind: "text", text }],
    contextId: "ctx-test",
  };
}

/** Build a minimal RequestContext. */
function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    taskId: "task-1",
    contextId: "ctx-1",
    userMessage: makeUserMessage("hello"),
    task: null,
    ...overrides,
  } as RequestContext;
}

/**
 * Build a mock ExecutionEventBus that records every published event.
 */
function makeMockBus() {
  const events: any[] = [];
  const bus = {
    publish: vi.fn((event: any) => { events.push(event); }),
    finished: vi.fn(),
    events,
  };
  return bus as typeof bus & ExecutionEventBus;
}

/**
 * Build a mock CopilotSession.
 *
 * The session stores registered event handlers and exposes
 * `emit(event, data)` so tests can fire synthetic SDK events.
 */
function makeMockSession(sessionId = "sess-1") {
  const handlers: Map<string, Array<(event: unknown) => void>> = new Map();

  const session: CopilotSession & { emit: (event: string, data?: unknown) => void } = {
    sessionId,
    on: vi.fn((event: string, handler: (e: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      // Return an unsubscribe function
      return () => {
        const arr = handlers.get(event) ?? [];
        const idx = arr.indexOf(handler);
        if (idx !== -1) arr.splice(idx, 1);
      };
    }),
    send: vi.fn(async (_params: { prompt: string }) => {
      // Triggers session.idle so the streaming path resolves
    }),
    sendAndWait: vi.fn(async (_params: { prompt: string }) => {
      return { data: { content: "assistant response" } };
    }),
    disconnect: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    emit(event: string, data?: unknown) {
      const arr = handlers.get(event) ?? [];
      for (const h of arr) {
        h({ data });
      }
    },
  };

  return session;
}

/** Build a UsageCallRecord-shaped SDK event payload. */
function makeUsageEventData(overrides: Record<string, unknown> = {}) {
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

/**
 * Run an executor with a fully mocked session.
 *
 * - Patches `initialize()` to be a no-op.
 * - Patches `sessionManager.getOrCreate` to return the mock session.
 * - For streaming: after `session.send()` is resolved, automatically fires
 *   `usageEvents` payloads then `session.idle`.
 * - For non-streaming: after `session.sendAndWait()` resolves, fires
 *   `usageEvents` payloads synchronously before returning the response.
 */
async function runExecutor(opts: {
  config: any;
  usageEventPayloads?: Record<string, unknown>[];
  throwInExecute?: Error;
}) {
  const { config, usageEventPayloads = [] } = opts;

  const executor = new CopilotExecutor(config);
  const session = makeMockSession();
  const bus = makeMockBus();
  const ctx = makeContext();

  // Patch initialize to skip real Copilot SDK startup
  vi.spyOn(executor as any, "initialize").mockResolvedValue(undefined);

  // Build a fake SessionManager with trackTask / untrackTask
  const fakeSessionManager = {
    getOrCreate: vi.fn(async () => ({
      sessionId: session.sessionId,
      session,
      isNew: true,
    })),
    trackTask: vi.fn(),
    untrackTask: vi.fn(),
    getSessionForTask: vi.fn(),
    getContextForTask: vi.fn(() => "ctx-1"),
    startCleanup: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  (executor as any).sessionManager = fakeSessionManager;

  // Patch mcpHooks to avoid null-ref
  (executor as any).mcpHooks = { setEmitter: vi.fn(), clearEmitter: vi.fn() };

  const isStreaming = config.copilot.streaming !== false;

  if (isStreaming) {
    // After send() is called, fire usage events then idle
    session.send = vi.fn(async () => {
      for (const payload of usageEventPayloads) {
        session.emit("assistant.usage", payload);
      }
      session.emit("session.idle");
    });
  } else {
    // For non-streaming, fire usage events during sendAndWait resolution
    session.sendAndWait = vi.fn(async () => {
      // Usage events fire while sendAndWait "runs" — the subscription is set up
      // before sendAndWait is called per the implementation
      for (const payload of usageEventPayloads) {
        session.emit("assistant.usage", payload);
      }
      return { data: { content: "assistant response" } };
    });
  }

  await executor.execute(ctx, bus as any);

  return { bus, session };
}

// ─── 10.1 — Streaming + trackUsage:true → K trace.usage artifacts ────────────

describe("10.1 streaming mode, trackUsage:true emits K trace.usage artifacts", () => {
  it("emits exactly K trace.usage artifacts when K assistant.usage events fire", async () => {
    const K = 3;
    const { bus } = await runExecutor({
      config: makeConfig({ streaming: true, trackUsage: true }),
      usageEventPayloads: Array.from({ length: K }, (_, i) =>
        makeUsageEventData({ inputTokens: (i + 1) * 10 }),
      ),
    });

    const traceUsageArtifacts = bus.events.filter(
      (e: any) => e.kind === "artifact-update" && e.artifact?.name === "trace.usage",
    );
    expect(traceUsageArtifacts).toHaveLength(K);
  });

  it("emits 0 trace.usage artifacts when no assistant.usage events fire", async () => {
    const { bus } = await runExecutor({
      config: makeConfig({ streaming: true, trackUsage: true }),
      usageEventPayloads: [],
    });

    const traceUsageArtifacts = bus.events.filter(
      (e: any) => e.kind === "artifact-update" && e.artifact?.name === "trace.usage",
    );
    expect(traceUsageArtifacts).toHaveLength(0);
  });
});

// ─── 10.2 — Streaming + trackUsage:false → 0 trace.usage artifacts ───────────

describe("10.2 streaming mode, trackUsage:false emits 0 trace.usage artifacts", () => {
  it("emits no trace.usage artifacts regardless of K assistant.usage events", async () => {
    const { bus } = await runExecutor({
      config: makeConfig({ streaming: true, trackUsage: false }),
      usageEventPayloads: [
        makeUsageEventData({ inputTokens: 100 }),
        makeUsageEventData({ inputTokens: 200 }),
      ],
    });

    const traceUsageArtifacts = bus.events.filter(
      (e: any) => e.kind === "artifact-update" && e.artifact?.name === "trace.usage",
    );
    expect(traceUsageArtifacts).toHaveLength(0);
  });

  it("emits no trace.usage artifacts when trackUsage is absent from config", async () => {
    const config = makeConfig({ streaming: true });
    delete config.features.trackUsage; // absent is same as false

    const { bus } = await runExecutor({
      config,
      usageEventPayloads: [makeUsageEventData()],
    });

    const traceUsageArtifacts = bus.events.filter(
      (e: any) => e.kind === "artifact-update" && e.artifact?.name === "trace.usage",
    );
    expect(traceUsageArtifacts).toHaveLength(0);
  });
});

// ─── 10.3 — Final completed event has correct metadata["x-usage"] structure ──

describe("10.3 final completed event has correct metadata[\"x-usage\"] structure", () => {
  it("final completed event has final:true, state:completed, and a valid x-usage object", async () => {
    const { bus } = await runExecutor({
      config: makeConfig({ streaming: true }),
      usageEventPayloads: [makeUsageEventData({ inputTokens: 150, outputTokens: 75, cost: 0 })],
    });

    const finalCompleted = bus.events.find(
      (e: any) =>
        e.kind === "status-update" &&
        e.final === true &&
        e.status?.state === "completed",
    );

    expect(finalCompleted).toBeDefined();
    expect(finalCompleted.final).toBe(true);
    expect(finalCompleted.status.state).toBe("completed");

    const xUsage = finalCompleted.metadata?.["x-usage"];
    expect(xUsage).toBeDefined();

    // Shape checks — UsageTelemetryData fields
    expect(typeof xUsage.llmCalls).toBe("number");
    expect(xUsage.llmCalls).toBeGreaterThanOrEqual(0);

    expect(typeof xUsage.inputTokens).toBe("number");
    expect(xUsage.inputTokens).toBeGreaterThanOrEqual(0);

    expect(typeof xUsage.outputTokens).toBe("number");
    expect(xUsage.outputTokens).toBeGreaterThanOrEqual(0);

    // cost must be null or a finite number >= 0 (Requirement 5.3 / 10.3)
    if (xUsage.cost !== null) {
      expect(typeof xUsage.cost).toBe("number");
      expect(Number.isFinite(xUsage.cost)).toBe(true);
      expect(xUsage.cost).toBeGreaterThanOrEqual(0);
    }

    // calls array must be present
    expect(Array.isArray(xUsage.calls)).toBe(true);
  });

  it("x-usage reflects accumulated token counts from all usage events", async () => {
    const { bus } = await runExecutor({
      config: makeConfig({ streaming: true }),
      usageEventPayloads: [
        makeUsageEventData({ inputTokens: 100, outputTokens: 50, cost: 0.01 }),
        makeUsageEventData({ inputTokens: 200, outputTokens: 80, cost: 0.02 }),
      ],
    });

    const finalCompleted = bus.events.find(
      (e: any) => e.kind === "status-update" && e.final === true && e.status?.state === "completed",
    );

    const xUsage = finalCompleted?.metadata?.["x-usage"];
    expect(xUsage).toBeDefined();
    expect(xUsage.llmCalls).toBe(2);
    expect(xUsage.inputTokens).toBe(300);
    expect(xUsage.outputTokens).toBe(130);
    // cost: 0.01 + 0.02 = 0.03 (within float precision)
    expect(xUsage.cost).toBeCloseTo(0.03, 5);
  });

  it("x-usage is present and valid even when zero LLM calls were made", async () => {
    const { bus } = await runExecutor({
      config: makeConfig({ streaming: true }),
      usageEventPayloads: [],
    });

    const finalCompleted = bus.events.find(
      (e: any) => e.kind === "status-update" && e.final === true && e.status?.state === "completed",
    );

    const xUsage = finalCompleted?.metadata?.["x-usage"];
    expect(xUsage).toBeDefined();
    expect(xUsage.llmCalls).toBe(0);
    expect(xUsage.inputTokens).toBe(0);
    expect(xUsage.cost).toBeNull();
    expect(xUsage.calls).toEqual([]);
  });
});

// ─── 10.4 — metadata["x-usage"] absent on failed / canceled / rejected ────────

describe("10.4 metadata[\"x-usage\"] absent on failed, canceled, rejected events", () => {
  it("failed terminal event has no metadata[\"x-usage\"]", async () => {
    const executor = new CopilotExecutor(makeConfig({ streaming: true }));
    const bus = makeMockBus();

    // Patch mcpHooks before initialize runs so the finally block can clear it
    (executor as any).mcpHooks = { setEmitter: vi.fn(), clearEmitter: vi.fn() };

    // Provide a sessionManager stub BEFORE initialize() is patched, since
    // executor.execute() tries this.sessionManager!.untrackTask() in finally.
    // When initialize() throws, this.sessionManager stays null — we pre-set it.
    (executor as any).sessionManager = {
      getOrCreate: vi.fn(),
      trackTask: vi.fn(),
      untrackTask: vi.fn(),
      getContextForTask: vi.fn(() => "ctx-1"),
    };

    // Make initialize throw AFTER sessionManager stub is set
    vi.spyOn(executor as any, "initialize").mockImplementation(async () => {
      // Simulate a failure that happens inside execute() before session setup
      // but we need the catch branch to run, so throw from the try block.
      // We achieve this by having the sessionManager.getOrCreate throw instead,
      // keeping initialize() as a no-op:
    });

    // Force failure via getOrCreate throwing
    (executor as any).sessionManager.getOrCreate = vi.fn(async () => {
      throw new Error("forced session failure");
    });

    await executor.execute(makeContext(), bus as any);

    const terminalEvents = bus.events.filter(
      (e: any) => e.kind === "status-update" && e.final === true,
    );

    // There must be at least one final event (the failed one)
    expect(terminalEvents.length).toBeGreaterThanOrEqual(1);

    // The failed terminal event must not carry x-usage
    const failedEvents = terminalEvents.filter(
      (e: any) => e.status?.state === "failed",
    );
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);

    for (const event of failedEvents) {
      expect(event.metadata?.["x-usage"]).toBeUndefined();
    }
  });

  it("canceled event published by cancelTask has no metadata[\"x-usage\"]", async () => {
    const executor = new CopilotExecutor(makeConfig({ streaming: true }));
    const bus = makeMockBus();

    // cancelTask doesn't need the session to be set up
    (executor as any).sessionManager = {
      getSessionForTask: vi.fn(() => undefined),
      getContextForTask: vi.fn(() => "ctx-1"),
      untrackTask: vi.fn(),
    };

    await executor.cancelTask("task-cancel", bus as any);

    const canceledEvents = bus.events.filter(
      (e: any) => e.kind === "status-update" && e.status?.state === "canceled",
    );

    expect(canceledEvents.length).toBeGreaterThanOrEqual(1);
    for (const event of canceledEvents) {
      expect(event.metadata?.["x-usage"]).toBeUndefined();
    }
  });

  it("only the final completed event carries x-usage; working / submitted events do not", async () => {
    const { bus } = await runExecutor({
      config: makeConfig({ streaming: true }),
      usageEventPayloads: [makeUsageEventData()],
    });

    const nonCompletedStatusEvents = bus.events.filter(
      (e: any) =>
        e.kind === "status-update" &&
        !(e.final === true && e.status?.state === "completed"),
    );

    for (const event of nonCompletedStatusEvents) {
      expect(event.metadata?.["x-usage"]).toBeUndefined();
    }
  });
});

// ─── 10.5 — Non-streaming mode emits same metadata["x-usage"] shape ──────────

describe("10.5 non-streaming mode emits same metadata[\"x-usage\"] shape as streaming", () => {
  it("non-streaming: final completed event has the same x-usage structure as streaming", async () => {
    const streamingBusResult = await runExecutor({
      config: makeConfig({ streaming: true }),
      usageEventPayloads: [makeUsageEventData({ inputTokens: 100, outputTokens: 50, cost: 0 })],
    });
    const nonStreamingBusResult = await runExecutor({
      config: makeConfig({ streaming: false }),
      usageEventPayloads: [makeUsageEventData({ inputTokens: 100, outputTokens: 50, cost: 0 })],
    });

    const streamingFinal = streamingBusResult.bus.events.find(
      (e: any) => e.kind === "status-update" && e.final === true && e.status?.state === "completed",
    );
    const nonStreamingFinal = nonStreamingBusResult.bus.events.find(
      (e: any) => e.kind === "status-update" && e.final === true && e.status?.state === "completed",
    );

    expect(streamingFinal).toBeDefined();
    expect(nonStreamingFinal).toBeDefined();

    const sUsage = streamingFinal?.metadata?.["x-usage"];
    const nsUsage = nonStreamingFinal?.metadata?.["x-usage"];

    // Both must be present
    expect(sUsage).toBeDefined();
    expect(nsUsage).toBeDefined();

    // The shape (keys) must be identical
    const sKeys = Object.keys(sUsage).sort();
    const nsKeys = Object.keys(nsUsage).sort();
    expect(nsKeys).toEqual(sKeys);

    // The values must match for the fields from our identical mock usage events
    expect(nsUsage.llmCalls).toBe(sUsage.llmCalls);
    expect(nsUsage.inputTokens).toBe(sUsage.inputTokens);
    expect(nsUsage.outputTokens).toBe(sUsage.outputTokens);
    expect(nsUsage.cost).toBe(sUsage.cost);
    expect(nsUsage.calls).toHaveLength(sUsage.calls.length);
  });

  it("non-streaming: x-usage present even with zero usage events (zero-call task)", async () => {
    const { bus } = await runExecutor({
      config: makeConfig({ streaming: false }),
      usageEventPayloads: [],
    });

    const finalCompleted = bus.events.find(
      (e: any) => e.kind === "status-update" && e.final === true && e.status?.state === "completed",
    );

    expect(finalCompleted).toBeDefined();
    const xUsage = finalCompleted?.metadata?.["x-usage"];
    expect(xUsage).toBeDefined();
    expect(xUsage.llmCalls).toBe(0);
    expect(xUsage.cost).toBeNull();
  });

  it("non-streaming: x-usage accumulates multiple usage events correctly", async () => {
    const { bus } = await runExecutor({
      config: makeConfig({ streaming: false }),
      usageEventPayloads: [
        makeUsageEventData({ inputTokens: 50, outputTokens: 20, cost: null }),
        makeUsageEventData({ inputTokens: 75, outputTokens: 30, cost: 0.005 }),
      ],
    });

    const finalCompleted = bus.events.find(
      (e: any) => e.kind === "status-update" && e.final === true && e.status?.state === "completed",
    );

    const xUsage = finalCompleted?.metadata?.["x-usage"];
    expect(xUsage).toBeDefined();
    expect(xUsage.llmCalls).toBe(2);
    expect(xUsage.inputTokens).toBe(125);
    expect(xUsage.outputTokens).toBe(50);
    // First call cost:null, second cost:0.005 → sum of non-null = 0.005
    expect(xUsage.cost).toBeCloseTo(0.005, 6);
  });

  it("non-streaming: unsubscribes usage handlers after sendAndWait completes", async () => {
    const executor = new CopilotExecutor(makeConfig({ streaming: false }));
    const session = makeMockSession();
    const bus = makeMockBus();

    vi.spyOn(executor as any, "initialize").mockResolvedValue(undefined);

    (executor as any).sessionManager = {
      getOrCreate: vi.fn(async () => ({ sessionId: session.sessionId, session, isNew: true })),
      trackTask: vi.fn(),
      untrackTask: vi.fn(),
      getSessionForTask: vi.fn(),
      getContextForTask: vi.fn(() => "ctx-1"),
    };
    (executor as any).mcpHooks = { setEmitter: vi.fn(), clearEmitter: vi.fn() };

    let resolveWait!: (v: any) => void;
    const waitPromise = new Promise<any>((res) => { resolveWait = res; });

    session.sendAndWait = vi.fn(async () => {
      session.emit("assistant.usage", makeUsageEventData({ inputTokens: 42 }));
      resolveWait(undefined);
      return { data: { content: "done" } };
    });

    await executor.execute(makeContext(), bus as any);
    await waitPromise; // ensure sendAndWait was called

    // After execute(), emit another usage event — it should NOT be picked up
    // because the unsub should have been called in the finally block
    session.emit("assistant.usage", makeUsageEventData({ inputTokens: 9999 }));

    const finalCompleted = bus.events.find(
      (e: any) => e.kind === "status-update" && e.final === true && e.status?.state === "completed",
    );

    const xUsage = finalCompleted?.metadata?.["x-usage"];
    expect(xUsage).toBeDefined();
    // Only the event emitted during sendAndWait should be recorded
    expect(xUsage.inputTokens).toBe(42);
    expect(xUsage.llmCalls).toBe(1);
  });
});
