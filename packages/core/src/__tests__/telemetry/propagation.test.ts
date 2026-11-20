/**
 * Inbound trace-context propagation (design: docs/design/distributed-tracing.md,
 * sections 8.2 to 8.4). Covers strict W3C validation, carrier selection, trust,
 * settings resolution, and how the request span is parented (continue / restart
 * / ignore, and nest / own for an ambient server span).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { context, trace, ROOT_CONTEXT, type Context } from "@opentelemetry/api";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import {
  setOtelTracer,
  instrumentExecutor,
  parseTraceparent,
  sanitizeTracestate,
  resolvePropagationSettings,
  collectInboundCarrier,
  isTrustedPeer,
  effectiveInboundPolicy,
  resolveExporterHeaders,
  PEER_HEADER,
  AgentEventEmitter,
  runWithTaskOtelStore,
  type A2AExecutor,
  type OtelTracerLike,
  type OtelSpanLike,
} from "../../index.js";

// ─── A minimal AsyncLocalStorage context manager (no SDK dependency) ─────────

class AlsContextManager {
  private als = new AsyncLocalStorage<Context>();
  active(): Context {
    return this.als.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F> {
    return this.als.run(ctx, () => fn.call(thisArg as never, ...args));
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.als.disable();
    return this;
  }
}

beforeAll(() => {
  context.setGlobalContextManager(new AlsContextManager() as never);
});
afterAll(() => {
  context.disable();
  setOtelTracer(undefined);
});
afterEach(() => {
  setOtelTracer(undefined);
  for (const k of ["A2A_OTEL_INBOUND", "A2A_OTEL_UNTRUSTED", "A2A_OTEL_TRUSTED_PEERS", "A2A_OTEL_CARRIERS", "A2A_OTEL_SERVER_SPAN", "A2A_OTEL_ENRICH_SERVER_SPAN"]) {
    delete process.env[k];
  }
});

// ─── Fakes ───────────────────────────────────────────────────────────────────

const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const CALLER_TRACE = "0af7651916cd43dd8448eb211c80319c";
const CALLER_SPAN = "b7ad6b7169203331";

interface Started {
  name: string;
  kind?: number;
  attributes: Record<string, string | number | boolean>;
  links: Array<{ traceId: string; spanId: string; attrs?: Record<string, unknown> }>;
  /** Span context of the parent the tracer was asked to use ("explicit" arg, else active). */
  parent?: { traceId: string; spanId: string; isRemote?: boolean };
  explicitParent: boolean;
  traceId: string;
}

function fakeTracer() {
  const started: Started[] = [];
  let n = 0;
  const tracer: OtelTracerLike = {
    startSpan(name, options, ctx) {
      const parentCtx = (ctx as Context | undefined) ?? context.active();
      const psc = trace.getSpanContext(parentCtx);
      const traceId = psc?.traceId ?? (++n).toString(16).padStart(32, "a");
      const spanId = (++n).toString(16).padStart(16, "b");
      started.push({
        name,
        kind: options?.kind,
        attributes: options?.attributes ?? {},
        links: (options?.links ?? []).map((l) => ({ traceId: l.context.traceId, spanId: l.context.spanId, attrs: l.attributes })),
        parent: psc ? { traceId: psc.traceId, spanId: psc.spanId, isRemote: psc.isRemote } : undefined,
        explicitParent: ctx !== undefined,
        traceId,
      });
      const span: OtelSpanLike = {
        setAttribute() {},
        end() {},
        spanContext: () => ({ traceId, spanId, traceFlags: 1 }),
      };
      return span;
    },
  };
  return { tracer, started };
}

/** An ambient span like the one HTTP auto-instrumentation leaves active. */
function ambientSpan(opts: { kind: number; recording?: boolean }) {
  const attrs: Record<string, unknown> = {};
  const span = {
    kind: opts.kind,
    isRecording: () => opts.recording !== false,
    setAttribute: (k: string, v: unknown) => {
      attrs[k] = v;
    },
    spanContext: () => ({ traceId: "c".repeat(32), spanId: "d".repeat(16), traceFlags: 1 }),
  };
  return { span, attrs };
}

let taskSeq = 0;
function makeCtx(opts: { headers?: Record<string, unknown>; metadata?: Record<string, unknown>; taskId?: string } = {}): RequestContext {
  const state = new Map<string, unknown>();
  if (opts.headers) state.set("headers", opts.headers);
  return {
    // Unique per call: prior-attempt linking is keyed by task id.
    taskId: opts.taskId ?? `task-${++taskSeq}`,
    contextId: "ctx-1",
    userMessage: { messageId: "m1", role: 1, parts: [], metadata: opts.metadata },
    task: undefined,
    context: { state },
  } as unknown as RequestContext;
}

const noopExecutor: A2AExecutor = { initialize: async () => {}, shutdown: async () => {}, execute: async () => {} };
const bus = {} as ExecutionEventBus;

async function run(ctx: RequestContext, otel: Record<string, unknown>) {
  const { tracer, started } = fakeTracer();
  setOtelTracer(tracer);
  const wrapped = instrumentExecutor(noopExecutor, { otel: { enabled: true, ...otel } as never, agentName: "A" });
  await wrapped.execute(ctx, bus);
  return started.filter((s) => s.name === "a2a.task.execute");
}

// ─── W3C validation ──────────────────────────────────────────────────────────

describe("parseTraceparent (W3C section 3.2)", () => {
  it("accepts a valid version-00 header", () => {
    expect(parseTraceparent(TP)).toEqual({ version: "00", traceId: CALLER_TRACE, spanId: CALLER_SPAN, traceFlags: 1 });
  });
  it("reads the sampled flag", () => {
    expect(parseTraceparent(TP.replace(/-01$/, "-00"))?.traceFlags).toBe(0);
  });
  it.each([
    ["version ff", "ff-" + TP.slice(3)],
    ["all-zero trace id", `00-${"0".repeat(32)}-${CALLER_SPAN}-01`],
    ["all-zero parent id", `00-${CALLER_TRACE}-${"0".repeat(16)}-01`],
    ["uppercase hex", TP.toUpperCase()],
    ["too short", TP.slice(0, 54)],
    ["extra field on version 00", TP + "-extra"],
    ["not hex", `00-${"z".repeat(32)}-${CALLER_SPAN}-01`],
    ["empty", ""],
    ["not a string", 42],
    ["huge", "x".repeat(10_000)],
  ])("rejects %s", (_label, value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });
  it("accepts a higher version with extra fields (forward compatible)", () => {
    expect(parseTraceparent(`01-${CALLER_TRACE}-${CALLER_SPAN}-01-future`)?.traceId).toBe(CALLER_TRACE);
  });
});

describe("sanitizeTracestate", () => {
  it("keeps a valid value", () => {
    expect(sanitizeTracestate("vendor1=opaque,rojo=00f067aa0ba902b7")).toBe("vendor1=opaque,rojo=00f067aa0ba902b7");
  });
  it.each([
    ["more than 32 members", Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(",")],
    ["longer than 512 chars", "a=" + "x".repeat(600)],
    ["malformed member", "no-equals-sign"],
    ["empty", ""],
  ])("drops %s", (_label, value) => {
    expect(sanitizeTracestate(value)).toBeUndefined();
  });
});

// ─── Settings ────────────────────────────────────────────────────────────────

describe("resolvePropagationSettings", () => {
  it("defaults", () => {
    expect(resolvePropagationSettings({}, {})).toEqual({
      inbound: "continue", trustedPeers: [], untrusted: "restart", carriers: ["header", "metadata"], serverSpan: "auto", enrichServerSpan: false,
    });
  });
  it("reads the JSON block", () => {
    const s = resolvePropagationSettings(
      { propagation: { inbound: "restart", trustedPeers: ["10.0.0.0/8"], untrusted: "ignore", carriers: ["metadata"] }, span: { server: "own", enrichServerSpan: true } },
      {},
    );
    expect(s).toMatchObject({ inbound: "restart", trustedPeers: ["10.0.0.0/8"], untrusted: "ignore", carriers: ["metadata"], serverSpan: "own", enrichServerSpan: true });
  });
  it("environment overrides JSON", () => {
    const s = resolvePropagationSettings(
      { propagation: { inbound: "continue" } },
      { A2A_OTEL_INBOUND: "ignore", A2A_OTEL_TRUSTED_PEERS: "10.0.0.0/8, 192.168.1.5", A2A_OTEL_SERVER_SPAN: "NEST", A2A_OTEL_ENRICH_SERVER_SPAN: "true" },
    );
    expect(s).toMatchObject({ inbound: "ignore", trustedPeers: ["10.0.0.0/8", "192.168.1.5"], serverSpan: "nest", enrichServerSpan: true });
  });
  it("ignores invalid values instead of throwing", () => {
    expect(resolvePropagationSettings({ propagation: { inbound: "bogus" as never } }, { A2A_OTEL_SERVER_SPAN: "weird" }).inbound).toBe("continue");
    expect(resolvePropagationSettings({}, { A2A_OTEL_SERVER_SPAN: "weird" }).serverSpan).toBe("auto");
  });
});

// ─── Carriers ────────────────────────────────────────────────────────────────

describe("collectInboundCarrier", () => {
  const carriers = ["header", "metadata"] as const;
  it("reads the header", () => {
    expect(collectInboundCarrier(makeCtx({ headers: { traceparent: TP } }), carriers)?.source).toBe("header");
  });
  it("falls back to message metadata", () => {
    const c = collectInboundCarrier(makeCtx({ metadata: { traceparent: TP, tracestate: "v=1" } }), carriers);
    expect(c?.source).toBe("metadata");
    expect(c?.tracestate).toBe("v=1");
  });
  it("the header wins over metadata", () => {
    const other = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
    const c = collectInboundCarrier(makeCtx({ headers: { traceparent: TP }, metadata: { traceparent: other } }), carriers);
    expect(c?.parsed.traceId).toBe(CALLER_TRACE);
  });
  it("skips an invalid header and uses valid metadata", () => {
    const c = collectInboundCarrier(makeCtx({ headers: { traceparent: "garbage" }, metadata: { traceparent: TP } }), carriers);
    expect(c?.source).toBe("metadata");
  });
  it("rejects repeated traceparent headers", () => {
    expect(collectInboundCarrier(makeCtx({ headers: { traceparent: [TP, TP] } }), ["header"])).toBeUndefined();
  });
  it("honours the configured carrier list", () => {
    expect(collectInboundCarrier(makeCtx({ headers: { traceparent: TP } }), ["metadata"])).toBeUndefined();
  });
  it("is empty without any context", () => {
    expect(collectInboundCarrier(makeCtx(), carriers)).toBeUndefined();
  });
});

// ─── Trust ───────────────────────────────────────────────────────────────────

describe("trusted peers", () => {
  it.each([
    ["10.1.2.3", ["10.0.0.0/8"], true],
    ["192.168.1.5", ["10.0.0.0/8"], false],
    ["192.168.1.5", ["192.168.1.5"], true],
    ["::ffff:10.1.2.3", ["10.0.0.0/8"], true],
    ["fd00::1", ["fd00::/8"], true],
    ["2001:db8::1", ["fd00::/8"], false],
    ["not-an-ip", ["10.0.0.0/8"], false],
    [undefined, ["10.0.0.0/8"], false],
  ])("peer %s in %j is trusted: %s", (peer, cidrs, expected) => {
    expect(isTrustedPeer(peer as string | undefined, cidrs as string[])).toBe(expected);
  });
  it("everyone is trusted when the list is empty", () => {
    expect(effectiveInboundPolicy({ inbound: "continue", trustedPeers: [], untrusted: "restart" }, undefined)).toBe("continue");
  });
  it("untrusted and unknown callers are downgraded (fail closed)", () => {
    const s = { inbound: "continue" as const, trustedPeers: ["10.0.0.0/8"], untrusted: "restart" as const };
    expect(effectiveInboundPolicy(s, "10.0.0.1")).toBe("continue");
    expect(effectiveInboundPolicy(s, "8.8.8.8")).toBe("restart");
    expect(effectiveInboundPolicy(s, undefined)).toBe("restart");
  });
});

// ─── How the request span is parented ────────────────────────────────────────

describe("request span parenting", () => {
  it("continue: SERVER span, remote parent from the header", async () => {
    const [s] = await run(makeCtx({ headers: { traceparent: TP } }), {});
    expect(s.kind).toBe(1);
    expect(s.explicitParent).toBe(true);
    expect(s.parent).toEqual({ traceId: CALLER_TRACE, spanId: CALLER_SPAN, isRemote: true });
    expect(s.traceId).toBe(CALLER_TRACE);
    expect(s.attributes["a2a.propagation.policy"]).toBe("continue");
    expect(s.attributes["a2a.propagation.source"]).toBe("header");
  });

  it("continue: message metadata is a carrier too", async () => {
    const [s] = await run(makeCtx({ metadata: { traceparent: TP } }), {});
    expect(s.parent?.traceId).toBe(CALLER_TRACE);
    expect(s.attributes["a2a.propagation.source"]).toBe("metadata");
  });

  it("continue: an invalid header is ignored and the request still gets a span", async () => {
    const [s] = await run(makeCtx({ headers: { traceparent: "bogus" } }), {});
    expect(s.kind).toBe(1);
    expect(s.explicitParent).toBe(false);
    expect(s.attributes["a2a.propagation.source"]).toBe("none");
  });

  it("no inbound context: SERVER span in the active context (unchanged behaviour otherwise)", async () => {
    const [s] = await run(makeCtx(), {});
    expect(s.kind).toBe(1);
    expect(s.parent).toBeUndefined();
    expect(s.links).toEqual([]);
  });

  it("restart: new trace with a link to the caller", async () => {
    const [s] = await run(makeCtx({ headers: { traceparent: TP } }), { propagation: { inbound: "restart" } });
    expect(s.explicitParent).toBe(true);
    expect(s.parent).toBeUndefined();
    expect(s.traceId).not.toBe(CALLER_TRACE);
    expect(s.links).toEqual([{ traceId: CALLER_TRACE, spanId: CALLER_SPAN, attrs: { "a2a.link_reason": "inbound_trace_restart" } }]);
  });

  it("ignore: new trace, caller context discarded, no link", async () => {
    const [s] = await run(makeCtx({ headers: { traceparent: TP } }), { propagation: { inbound: "ignore" } });
    expect(s.parent).toBeUndefined();
    expect(s.traceId).not.toBe(CALLER_TRACE);
    expect(s.links).toEqual([]);
  });

  it("trusted peer continues, untrusted peer is restarted", async () => {
    const otel = { propagation: { inbound: "continue", trustedPeers: ["10.0.0.0/8"], untrusted: "restart" } };
    const [trusted] = await run(makeCtx({ headers: { traceparent: TP, [PEER_HEADER]: "10.1.1.1" } }), otel);
    expect(trusted.traceId).toBe(CALLER_TRACE);
    const [untrusted] = await run(makeCtx({ headers: { traceparent: TP, [PEER_HEADER]: "203.0.113.9" } }), otel);
    expect(untrusted.traceId).not.toBe(CALLER_TRACE);
    expect(untrusted.links).toHaveLength(1);
    const [unknown] = await run(makeCtx({ headers: { traceparent: TP } }), otel);
    expect(unknown.traceId).not.toBe(CALLER_TRACE);
  });

  it("environment variable overrides the JSON policy", async () => {
    process.env["A2A_OTEL_INBOUND"] = "ignore";
    const [s] = await run(makeCtx({ headers: { traceparent: TP } }), { propagation: { inbound: "continue" } });
    expect(s.traceId).not.toBe(CALLER_TRACE);
  });

  it("is a no-op when OTel is disabled", async () => {
    const { tracer, started } = fakeTracer();
    setOtelTracer(tracer);
    const wrapped = instrumentExecutor(noopExecutor, { otel: { enabled: false }, agentName: "A" });
    await wrapped.execute(makeCtx({ headers: { traceparent: TP } }), bus);
    expect(started).toEqual([]);
  });

  describe("an ambient server span (HTTP auto-instrumentation)", () => {
    const inAmbient = <T,>(span: unknown, fn: () => Promise<T>): Promise<T> =>
      context.with(trace.setSpan(ROOT_CONTEXT, span as never), fn);

    it("auto: nests as INTERNAL under a recording SERVER span and does not re-extract", async () => {
      const { span } = ambientSpan({ kind: 1 });
      const [s] = await inAmbient(span, () => run(makeCtx({ headers: { traceparent: TP } }), {}));
      expect(s.kind).toBe(0);
      expect(s.explicitParent).toBe(false);
      expect(s.parent?.spanId).toBe("d".repeat(16)); // child of the ambient span
      expect(s.attributes["a2a.propagation.policy"]).toBe("nested");
    });

    it("auto: ignores an ambient span that is not a recording SERVER span", async () => {
      const notServer = ambientSpan({ kind: 0 }).span;
      const [a] = await inAmbient(notServer, () => run(makeCtx({ headers: { traceparent: TP } }), {}));
      expect(a.kind).toBe(1);
      expect(a.traceId).toBe(CALLER_TRACE);
      const unsampled = ambientSpan({ kind: 1, recording: false }).span;
      const [b] = await inAmbient(unsampled, () => run(makeCtx({ headers: { traceparent: TP } }), {}));
      expect(b.kind).toBe(1);
    });

    it("own: always creates our SERVER span (the documented duplicate)", async () => {
      const { span } = ambientSpan({ kind: 1 });
      const [s] = await inAmbient(span, () => run(makeCtx({ headers: { traceparent: TP } }), { span: { server: "own" } }));
      expect(s.kind).toBe(1);
      expect(s.traceId).toBe(CALLER_TRACE);
    });

    it("nest: never extracts, even without an ambient span", async () => {
      const [s] = await run(makeCtx({ headers: { traceparent: TP } }), { span: { server: "nest" } });
      expect(s.kind).toBe(0);
      expect(s.explicitParent).toBe(false);
      expect(s.traceId).not.toBe(CALLER_TRACE);
    });

    it("enrichServerSpan adds a2a.* attributes to the ambient span, off by default", async () => {
      const off = ambientSpan({ kind: 1 });
      await inAmbient(off.span, () => run(makeCtx(), {}));
      expect(off.attrs).toEqual({});
      const on = ambientSpan({ kind: 1 });
      await inAmbient(on.span, () => run(makeCtx(), { span: { enrichServerSpan: true } }));
      expect(on.attrs["a2a.task.id"]).toMatch(/^task-\d+$/);
      expect(on.attrs["a2a.context.id"]).toBe("ctx-1");
    });
  });
});

// ─── Exporter headers ────────────────────────────────────────────────────────

describe("resolveExporterHeaders", () => {
  it("substitutes ${VAR} and leaves other values alone", () => {
    expect(resolveExporterHeaders({ Authorization: "Basic ${AUTH}", "x-static": "1" }, { AUTH: "abc" })).toEqual({
      Authorization: "Basic abc",
      "x-static": "1",
    });
  });
  it("keeps the token for an unset variable (and warns without printing a value)", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warns.push(String(m));
    try {
      expect(resolveExporterHeaders({ Authorization: "Bearer ${MISSING}" }, {})).toEqual({ Authorization: "Bearer ${MISSING}" });
    } finally {
      console.warn = orig;
    }
    expect(warns.join("\n")).toContain("MISSING");
  });
  it("returns undefined for no headers", () => {
    expect(resolveExporterHeaders(undefined, {})).toBeUndefined();
    expect(resolveExporterHeaders({}, {})).toBeUndefined();
  });
});

// ─── Event correlation ───────────────────────────────────────────────────────

describe("event transport correlation", () => {
  const mk = () => {
    const sent: Array<Record<string, unknown>> = [];
    const emitter = new AgentEventEmitter({
      agentId: "a", agentName: "A", traceId: "legacy-trace",
      transport: { send: async (e: unknown) => void sent.push(e as Record<string, unknown>) } as never,
    });
    return { sent, emitter };
  };

  it("stamps otelTraceId / otelSpanId while a request span is active", async () => {
    const { sent, emitter } = mk();
    const span = { setAttribute() {}, end() {}, spanContext: () => ({ traceId: CALLER_TRACE, spanId: CALLER_SPAN, traceFlags: 1 }) };
    const store = { span, policy: {}, taskId: "t", contextId: "c", agentId: "a", agentName: "A", toolSpans: new Map() };
    await runWithTaskOtelStore(store as never, () => emitter.emit("thinking", {}));
    expect(sent[0]).toMatchObject({ otelTraceId: CALLER_TRACE, otelSpanId: CALLER_SPAN, traceId: "legacy-trace" });
  });

  it("leaves events untouched without an active span", async () => {
    const { sent, emitter } = mk();
    await emitter.emit("thinking", {});
    expect(sent[0]).not.toHaveProperty("otelTraceId");
  });
});
