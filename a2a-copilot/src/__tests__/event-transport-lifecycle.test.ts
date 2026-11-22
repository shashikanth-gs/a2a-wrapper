/**
 * Tests — usage and lifecycle events reach the configured event transport (#56)
 *
 * Before the fix, the executor published per-call `trace.usage` and the usage
 * summary straight onto the A2A event bus and emitted no lifecycle events, so an
 * HTTP event collector saw `tool_call_*` events but no `agent_started`,
 * `agent_finished` or usage.
 *
 * These tests run the provider (through the real request handler) against a faked Copilot
 * session and a real local HTTP collector, mirroring the reproduction in the issue
 * (`events: { enabled: true, transport: "http", httpUrl, httpHeaders }`).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runTask, usagePayload as basePayload } from "./helpers/run-task.js";

const usagePayload = (o: Record<string, unknown> = {}) => basePayload({ model: "gpt-4.1", ...o });

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

// ─── Harness ─────────────────────────────────────────────────────────────────

/** One task through the provider; `fail` makes the non-streaming run throw after the usage events have fired. */
async function run(opts: {
  streaming: boolean;
  events: Record<string, unknown>;
  usage?: Record<string, unknown>[];
  fail?: Error;
}) {
  const r = await runTask({
    streaming: opts.streaming,
    events: opts.events,
    usage: opts.usage ?? [],
    ...(opts.fail ? { fail: opts.fail } : {}),
    copilot: { model: "gpt-4.1" },
  });
  return { summary: r.summary, elapsedMs: r.elapsedMs };
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
    const { summary, elapsedMs } = await run({
      streaming: true,
      events: { enabled: true, transport: "http", httpUrl: url, httpTimeout: 10_000 },
      usage: [usagePayload()],
    });
    // The terminal emit is capped at 2s; the default HTTP timeout alone would be 10s.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(summary.at(-1)).toMatchObject({ k: "status", state: "completed" });
  }, 15_000);
});

describe("A2A transport (default) and the existing x-usage path", () => {
  it("publishes trace.lifecycle artifacts and keeps x-usage on the completed status", async () => {
    const { summary } = await run({ streaming: true, events: { enabled: true, transport: "a2a" }, usage: [usagePayload()] });

    const lifecycle = summary
      .filter((e: any) => e.k === "artifact" && e.name === "trace.lifecycle")
      .map((e: any) => e.parts[0].data);
    expect(lifecycle.map((d: any) => d.state)).toEqual(["started", "finished"]);
    expect(lifecycle[1].usage.llmCalls).toBe(1);

    const completed = summary.find((e: any) => e.k === "status" && e.usage) as any;
    expect(completed?.usage.llmCalls).toBe(1);
  });

  it("on failure publishes started then error on the A2A transport, and a failed status", async () => {
    const { summary } = await run({ streaming: false, events: { enabled: true, transport: "a2a" }, usage: [], fail: new Error("boom") });
    const lifecycle = summary.filter((e: any) => e.k === "artifact" && e.name === "trace.lifecycle").map((e: any) => e.parts[0].data.state);
    expect(lifecycle).toEqual(["started", "error"]);
    expect(summary.at(-1)).toMatchObject({ k: "status", state: "failed", text: "Error: boom" });
  });
});
