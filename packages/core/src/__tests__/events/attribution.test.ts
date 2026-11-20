/**
 * P2 of the distributed-tracing design: event attribution, `transport: "both"`,
 * `${VAR}` substitution and env overrides in `events.*`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  AgentEventEmitter,
  resolveTransport,
  createTransport,
  resolveEventsConfig,
  substituteEnv,
  sanitizePropagatedMetadata,
  MAX_PROPAGATED_KEYS,
  MAX_PROPAGATED_BYTES,
  type AgentEvent,
} from "../../index.js";
import { _resetEventsConfigWarnings } from "../../events/events-config.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env["A2A_EVENTS_TRANSPORT"];
  delete process.env["A2A_EVENTS_HTTP_URL"];
});
beforeEach(() => _resetEventsConfigWarnings());

/** SDK v1.0 part shape: `content: { $case: "data", value }`. */
const partData = (p: { content?: { $case?: string; value?: Record<string, unknown> } } | undefined) =>
  p?.content?.$case === "data" ? p.content.value : undefined;

function fakeBus() {
  const published: Array<{ kind: string; data: { artifact?: { metadata?: Record<string, unknown>; parts?: Array<{ content?: { $case?: string; value?: Record<string, unknown> } }> } } }> = [];
  return { bus: { publish: (e: never) => void published.push(e), finished: () => {} } as never, published };
}

// ─── propagated metadata ─────────────────────────────────────────────────────

describe("sanitizePropagatedMetadata", () => {
  it("keeps ordinary values", () => {
    expect(sanitizePropagatedMetadata({ tenant: "acme", n: 3, nested: { a: 1 } })).toEqual({ tenant: "acme", n: 3, nested: { a: 1 } });
  });
  it.each([[undefined], [null], ["str"], [[1, 2]], [42]])("rejects non-objects: %j", (v) => {
    expect(sanitizePropagatedMetadata(v)).toBeUndefined();
  });
  it("drops keys with a disallowed charset", () => {
    expect(sanitizePropagatedMetadata({ "ok-key.1": 1, "bad key": 2, "x/y": 3, "": 4 })).toEqual({ "ok-key.1": 1 });
  });
  it("redacts the value of secret-looking keys but keeps the key", () => {
    const out = sanitizePropagatedMetadata({ apiKey: "sk-123", Authorization: "Bearer x", user_password: "p", sessionToken: "t", tenant: "acme" });
    expect(out).toEqual({ apiKey: "[redacted]", Authorization: "[redacted]", user_password: "[redacted]", sessionToken: "[redacted]", tenant: "acme" });
  });
  it(`caps the number of keys at ${MAX_PROPAGATED_KEYS}`, () => {
    const big = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizePropagatedMetadata(big)!)).toHaveLength(MAX_PROPAGATED_KEYS);
  });
  it("caps the serialized size and drops what does not fit", () => {
    const out = sanitizePropagatedMetadata({ small: "a", huge: "x".repeat(MAX_PROPAGATED_BYTES + 10), after: "b" })!;
    expect(out).toEqual({ small: "a", after: "b" });
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_PROPAGATED_BYTES);
  });
  it("drops values that cannot be serialized", () => {
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    expect(sanitizePropagatedMetadata({ cyc, big: BigInt(1) as never, ok: 1 })).toEqual({ ok: 1 });
  });
  it("returns undefined when nothing remains", () => {
    expect(sanitizePropagatedMetadata({ "bad key": 1 })).toBeUndefined();
    expect(sanitizePropagatedMetadata({})).toBeUndefined();
  });
});

// ─── events config ───────────────────────────────────────────────────────────

describe("resolveEventsConfig / substituteEnv", () => {
  it("substitutes ${VAR} in the URL and every header value", () => {
    const cfg = resolveEventsConfig(
      { transport: "http", httpUrl: "${COLLECTOR}/events", httpHeaders: { Authorization: "Bearer ${TOKEN}", "x-static": "1" } },
      { COLLECTOR: "https://c.example", TOKEN: "abc" },
    );
    expect(cfg.httpUrl).toBe("https://c.example/events");
    expect(cfg.httpHeaders).toEqual({ Authorization: "Bearer abc", "x-static": "1" });
  });
  it("leaves an unset variable as written and warns once, naming the variable but no value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { OTHER: "secret-value" };
    resolveEventsConfig({ httpHeaders: { A: "${MISSING}", B: "${MISSING}" } }, env);
    resolveEventsConfig({ httpHeaders: { A: "${MISSING}" } }, env);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain("MISSING");
    expect(msg).not.toContain("secret-value");
    expect(resolveEventsConfig({ httpHeaders: { A: "${MISSING}" } }, env).httpHeaders).toEqual({ A: "${MISSING}" });
  });
  it("environment overrides JSON", () => {
    const cfg = resolveEventsConfig({ transport: "a2a", httpUrl: "http://old" }, { A2A_EVENTS_TRANSPORT: "BOTH", A2A_EVENTS_HTTP_URL: "http://new" });
    expect(cfg).toMatchObject({ transport: "both", httpUrl: "http://new" });
  });
  it("ignores an invalid transport override", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveEventsConfig({ transport: "http" }, { A2A_EVENTS_TRANSPORT: "kafka" }).transport).toBe("http");
    expect(warn).toHaveBeenCalled();
  });
  it("does not mutate its input", () => {
    const input = { httpUrl: "${X}", httpHeaders: { A: "${X}" } };
    resolveEventsConfig(input, { X: "1" });
    expect(input).toEqual({ httpUrl: "${X}", httpHeaders: { A: "${X}" } });
  });
  it("substituteEnv handles several tokens in one value", () => {
    expect(substituteEnv("${A}-${B}", "t", { A: "1", B: "2" })).toBe("1-2");
  });
});

// ─── both transports ─────────────────────────────────────────────────────────

describe('events.transport: "both"', () => {
  const event = (over: Partial<AgentEvent> = {}): AgentEvent => ({
    eventId: "evt-1", eventType: "tool_call_start", agentId: "a", agentName: "A", traceId: "t",
    parentAgentId: "parent", timestamp: "2026-01-01T00:00:00Z", data: {}, otelTraceId: "1".repeat(32), otelSpanId: "2".repeat(16),
    propagatedMetadata: { tenant: "acme" }, ...over,
  });

  it("sends the A2A artifact and the HTTP POST with the same eventId", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { bus, published } = fakeBus();
    const t = resolveTransport({ transport: "both", httpUrl: "http://collector/events", httpHeaders: { Authorization: "Bearer ${T}" } }, bus, "task", "ctx", undefined);
    process.env["T"] = "tok";
    await t.send(event());
    delete process.env["T"];

    expect(published).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const art = published[0]!.data.artifact!;
    expect(art.metadata).toMatchObject({ eventId: "evt-1", parentAgentId: "parent", otelTraceId: "1".repeat(32), otelSpanId: "2".repeat(16) });
    expect(partData(art.parts![0])).toMatchObject({ event_id: "evt-1", parent_agent_id: "parent", propagated_metadata: { tenant: "acme" } });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body));
    expect(body.eventId).toBe("evt-1");
    expect(body.propagatedMetadata).toEqual({ tenant: "acme" });
  });

  it("resolves ${VAR} in headers at send time config resolution", async () => {
    process.env["COLLECTOR_TOKEN"] = "abc";
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { bus } = fakeBus();
    await resolveTransport({ transport: "http", httpUrl: "http://c", httpHeaders: { Authorization: "Bearer ${COLLECTOR_TOKEN}" } }, bus, "t", "c").send(event());
    delete process.env["COLLECTOR_TOKEN"];
    const init = (fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1];
    expect(init.headers["Authorization"]).toBe("Bearer abc");
  });

  it("a failing collector never blocks the A2A copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bus, published } = fakeBus();
    await resolveTransport({ transport: "both", httpUrl: "http://down" }, bus, "t", "c").send(event());
    expect(published).toHaveLength(1);
  });

  it("requires httpUrl", () => {
    const { bus } = fakeBus();
    expect(() => resolveTransport({ transport: "both" }, bus, "t", "c")).toThrow(/httpUrl/);
  });

  it("is selectable with A2A_EVENTS_TRANSPORT", async () => {
    process.env["A2A_EVENTS_TRANSPORT"] = "both";
    process.env["A2A_EVENTS_HTTP_URL"] = "http://collector";
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { bus, published } = fakeBus();
    await resolveTransport({}, bus, "t", "c").send(event());
    expect(published).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("createTransport('both') falls back to HTTP only with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await createTransport({ transport: "both", httpUrl: "http://c" }).send(event());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it("omits optional artifact fields that are absent", async () => {
    const { bus, published } = fakeBus();
    await resolveTransport({}, bus, "t", "c").send(event({ parentAgentId: null, otelTraceId: undefined, otelSpanId: undefined, propagatedMetadata: undefined }));
    const art = published[0]!.data.artifact!;
    expect(art.metadata).not.toHaveProperty("parentAgentId");
    expect(art.metadata).not.toHaveProperty("otelTraceId");
    expect(partData(art.parts![0])).not.toHaveProperty("propagated_metadata");
    expect(art.metadata).toHaveProperty("eventId");
  });
});

// ─── emitter ─────────────────────────────────────────────────────────────────

describe("AgentEventEmitter propagatedMetadata", () => {
  const mk = (propagatedMetadata?: Record<string, unknown>) => {
    const sent: AgentEvent[] = [];
    const emitter = new AgentEventEmitter({ agentId: "a", agentName: "A", traceId: "t", propagatedMetadata, transport: { send: async (e) => void sent.push(e) } });
    return { sent, emitter };
  };
  it("stamps sanitized metadata on every event", async () => {
    const { sent, emitter } = mk({ tenant: "acme", token: "s3cret", "bad key": 1 });
    await emitter.emit("thinking", {});
    await emitter.emit("decision", {});
    expect(sent).toHaveLength(2);
    for (const e of sent) expect(e.propagatedMetadata).toEqual({ tenant: "acme", token: "[redacted]" });
  });
  it("omits the field when no metadata was supplied", async () => {
    const { sent, emitter } = mk({});
    await emitter.emit("thinking", {});
    expect(sent[0]).not.toHaveProperty("propagatedMetadata");
  });
});
