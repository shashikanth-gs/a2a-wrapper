/**
 * Inbound trace-context propagation.
 *
 * Decides how a request span relates to the caller's W3C trace context:
 *
 * - **Carriers.** The caller's `traceparent` / `tracestate` are read from the
 *   HTTP request headers (`ctx.context.state.get("headers")`, populated by the
 *   A2A SDK's default context builder) and, failing that, from message
 *   metadata. Invalid values are ignored, never fatal.
 * - **Policy.** `continue` joins the caller's trace, `restart` starts a new
 *   trace with a span link to the caller, `ignore` discards the caller's
 *   context. Callers outside `trustedPeers` get the `untrusted` policy.
 * - **Server span.** With HTTP auto-instrumentation on the host there is already
 *   a recording SERVER span that extracted the context; `auto` nests under it
 *   instead of creating a duplicate.
 *
 * Design: docs/design/distributed-tracing.md (sections 8.2 to 8.4).
 *
 * `@opentelemetry/api` stays an optional peer: everything here degrades to a
 * no-op decision when it is not installed.
 *
 * @module telemetry/propagation
 */

import { createRequire } from "node:module";
import { BlockList, isIP } from "node:net";
import type { RequestContext } from "@a2a-js/sdk/server";
import { collectMetadata } from "./context.js";
import type { OtelConfig, OtelSpanLinkLike } from "./types.js";

const require = createRequire(import.meta.url);

// ─── Settings ────────────────────────────────────────────────────────────────

export type InboundPolicy = "continue" | "restart" | "ignore";
export type UntrustedPolicy = "restart" | "ignore";
export type InboundCarrierName = "header" | "metadata";
export type ServerSpanMode = "auto" | "own" | "nest";

/** Internal header the server middleware overwrites with the caller's address. */
export const PEER_HEADER = "x-a2a-peer";

export interface ResolvedPropagation {
  inbound: InboundPolicy;
  trustedPeers: string[];
  untrusted: UntrustedPolicy;
  carriers: InboundCarrierName[];
  serverSpan: ServerSpanMode;
  enrichServerSpan: boolean;
}

export const DEFAULT_PROPAGATION: Readonly<ResolvedPropagation> = Object.freeze<ResolvedPropagation>({
  inbound: "continue",
  trustedPeers: [],
  untrusted: "restart",
  carriers: ["header", "metadata"] as InboundCarrierName[],
  serverSpan: "auto",
  enrichServerSpan: false,
});

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[a2a-wrapper/otel] ${message}`);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], what: string): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const v = String(value).trim().toLowerCase();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  warnOnce(`${what}:${v}`, `ignoring invalid ${what} "${v}" (expected ${allowed.join(" | ")})`);
  return undefined;
}

function list(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const out = raw.map((x) => String(x).trim()).filter(Boolean);
  return out;
}

function bool(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

/**
 * Resolve propagation settings. Precedence: environment variables, then the
 * JSON `otel` block, then defaults (the loaders' usual order, with env able to
 * override a file).
 */
export function resolvePropagationSettings(
  otel?: OtelConfig | null,
  env: Record<string, string | undefined> = process.env,
): ResolvedPropagation {
  const p = otel?.propagation;
  const s = otel?.span;

  const inbound =
    pick(env["A2A_OTEL_INBOUND"], ["continue", "restart", "ignore"] as const, "A2A_OTEL_INBOUND") ??
    pick(p?.inbound, ["continue", "restart", "ignore"] as const, "otel.propagation.inbound") ??
    DEFAULT_PROPAGATION.inbound;
  const untrusted =
    pick(env["A2A_OTEL_UNTRUSTED"], ["restart", "ignore"] as const, "A2A_OTEL_UNTRUSTED") ??
    pick(p?.untrusted, ["restart", "ignore"] as const, "otel.propagation.untrusted") ??
    DEFAULT_PROPAGATION.untrusted;
  const trustedPeers = list(env["A2A_OTEL_TRUSTED_PEERS"]) ?? list(p?.trustedPeers) ?? [];

  const rawCarriers = list(env["A2A_OTEL_CARRIERS"]) ?? list(p?.carriers);
  const carriers = (rawCarriers ?? [...DEFAULT_PROPAGATION.carriers]).filter(
    (c): c is InboundCarrierName => c === "header" || c === "metadata",
  );

  const serverSpan =
    pick(env["A2A_OTEL_SERVER_SPAN"], ["auto", "own", "nest"] as const, "A2A_OTEL_SERVER_SPAN") ??
    pick(s?.server, ["auto", "own", "nest"] as const, "otel.span.server") ??
    DEFAULT_PROPAGATION.serverSpan;
  const enrichServerSpan =
    bool(env["A2A_OTEL_ENRICH_SERVER_SPAN"]) ?? s?.enrichServerSpan ?? DEFAULT_PROPAGATION.enrichServerSpan;

  return { inbound, trustedPeers, untrusted, carriers, serverSpan, enrichServerSpan };
}

// ─── W3C validation ──────────────────────────────────────────────────────────

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  spanId: string;
  traceFlags: number;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ALL_ZERO_32 = "0".repeat(32);
const ALL_ZERO_16 = "0".repeat(16);

/**
 * Strictly parse a `traceparent` value (W3C Trace Context, section 3.2).
 * Returns `undefined` for anything a vendor "MUST ignore": version `ff`, an
 * all-zero trace or parent id, non-lowercase hex, extra fields on version `00`.
 */
export function parseTraceparent(value: unknown): ParsedTraceparent | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (v.length < 55 || v.length > 512) return undefined;
  const m = TRACEPARENT_RE.exec(v);
  if (!m) return undefined;
  const [, version, traceId, spanId, flags, extra] = m;
  if (version === "ff") return undefined;
  if (version === "00" && (extra !== undefined || v.length !== 55)) return undefined;
  if (traceId === ALL_ZERO_32 || spanId === ALL_ZERO_16) return undefined;
  return { version, traceId, spanId, traceFlags: parseInt(flags, 16) };
}

const TRACESTATE_MEMBER_RE =
  /^[a-z0-9][a-z0-9_\-*/]{0,255}(@[a-z0-9][a-z0-9_\-*/]{0,13})?=[\x21-\x2b\x2d-\x3c\x3e-\x7e]([\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,254}[\x21-\x2b\x2d-\x3c\x3e-\x7e])?$/;

/**
 * Validate a `tracestate` value; return it unchanged when valid, `undefined`
 * (drop the whole header, which W3C allows) when it is too large or malformed.
 */
export function sanitizeTracestate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || v.length > 512) return undefined;
  const members = v.split(",").map((m) => m.trim()).filter(Boolean);
  if (members.length === 0 || members.length > 32) return undefined;
  for (const m of members) if (!TRACESTATE_MEMBER_RE.test(m)) return undefined;
  return v;
}

/** First string of a header value; `undefined` when absent or repeated (W3C: multiple traceparent headers are invalid). */
function singleHeader(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length === 1 && typeof value[0] === "string" ? value[0] : undefined;
  return undefined;
}

// ─── Carriers ────────────────────────────────────────────────────────────────

export interface InboundCarrier {
  source: InboundCarrierName;
  parsed: ParsedTraceparent;
  tracestate?: string;
}

function requestHeaders(ctx: RequestContext): Record<string, unknown> {
  try {
    const state = (ctx as unknown as { context?: { state?: Map<string, unknown> } }).context?.state;
    const h = state?.get?.("headers");
    return h && typeof h === "object" ? (h as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** First valid inbound W3C context, honouring the configured carrier order. */
export function collectInboundCarrier(
  ctx: RequestContext,
  carriers: readonly InboundCarrierName[],
): InboundCarrier | undefined {
  for (const source of carriers) {
    if (source === "header") {
      const h = requestHeaders(ctx);
      const parsed = parseTraceparent(singleHeader(h["traceparent"]));
      if (parsed) return { source, parsed, tracestate: sanitizeTracestate(singleHeader(h["tracestate"])) };
    } else if (source === "metadata") {
      const meta = collectMetadata(ctx);
      const parsed = parseTraceparent(meta["traceparent"]);
      if (parsed) return { source, parsed, tracestate: sanitizeTracestate(meta["tracestate"]) };
    }
  }
  return undefined;
}

// ─── Trust ───────────────────────────────────────────────────────────────────

/** The caller address recorded by the server middleware (unspoofable), if any. */
export function peerOf(ctx: RequestContext): string | undefined {
  const v = singleHeader(requestHeaders(ctx)[PEER_HEADER]);
  return v ? v.trim() : undefined;
}

function normalizeAddress(addr: string): { ip: string; family: "ipv4" | "ipv6" } | undefined {
  let ip = addr.trim();
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = isIP(ip);
  if (family === 4) return { ip, family: "ipv4" };
  if (family === 6) return { ip, family: "ipv6" };
  return undefined;
}

const blockListCache = new Map<string, BlockList>();

function blockListFor(cidrs: readonly string[]): BlockList {
  const key = cidrs.join("|");
  const cached = blockListCache.get(key);
  if (cached) return cached;
  const list = new BlockList();
  for (const entry of cidrs) {
    const [addr, prefix] = entry.split("/");
    const n = normalizeAddress(addr ?? "");
    if (!n) {
      warnOnce(`cidr:${entry}`, `ignoring invalid trusted peer "${entry}"`);
      continue;
    }
    if (prefix === undefined) list.addAddress(n.ip, n.family);
    else list.addSubnet(n.ip, Number(prefix), n.family);
  }
  blockListCache.set(key, list);
  return list;
}

/** True when `peer` matches one of the CIDRs (or single IPs). Unknown peers are untrusted. */
export function isTrustedPeer(peer: string | undefined, cidrs: readonly string[]): boolean {
  if (!peer) return false;
  const n = normalizeAddress(peer);
  if (!n) return false;
  try {
    return blockListFor(cidrs).check(n.ip, n.family);
  } catch {
    return false;
  }
}

/**
 * Policy for this request: the configured policy, downgraded to `untrusted`
 * when `trustedPeers` is set and the caller is not in it. With `trustedPeers`
 * set an unknown caller (no middleware) is treated as untrusted (fail closed).
 */
export function effectiveInboundPolicy(
  settings: Pick<ResolvedPropagation, "inbound" | "trustedPeers" | "untrusted">,
  peer: string | undefined,
): InboundPolicy {
  if (settings.trustedPeers.length === 0) return settings.inbound;
  return isTrustedPeer(peer, settings.trustedPeers) ? settings.inbound : settings.untrusted;
}

// ─── OpenTelemetry API (optional) ────────────────────────────────────────────

interface OtelApi {
  context: { active: () => unknown };
  trace: {
    setSpanContext: (ctx: unknown, sc: unknown) => unknown;
    getActiveSpan: () => unknown;
  };
  ROOT_CONTEXT: unknown;
  createTraceState?: (s?: string) => unknown;
}

function loadApi(): OtelApi | undefined {
  try {
    return require("@opentelemetry/api") as OtelApi;
  } catch {
    return undefined;
  }
}

/** OpenTelemetry `SpanKind` numeric values we use. */
export const SPAN_KIND_INTERNAL = 0;
export const SPAN_KIND_SERVER = 1;

interface AmbientSpan {
  isRecording?: () => boolean;
  setAttribute?: (k: string, v: string | number | boolean) => void;
  kind?: number;
}

/**
 * The active span when it is a **recording SERVER** span (typically created by
 * HTTP auto-instrumentation). The API `Span` has no `kind` getter, so this
 * reads it off the SDK span object defensively; an unsampled or unreadable
 * span counts as "no ambient server span".
 */
export function detectAmbientServerSpan(): AmbientSpan | undefined {
  try {
    const span = loadApi()?.trace.getActiveSpan() as AmbientSpan | undefined;
    if (!span || typeof span.isRecording !== "function" || !span.isRecording()) return undefined;
    return span.kind === SPAN_KIND_SERVER ? span : undefined;
  } catch {
    return undefined;
  }
}

/** Build an OpenTelemetry Context whose active span context is the remote caller. */
export function buildRemoteContext(carrier: InboundCarrier): unknown | undefined {
  const api = loadApi();
  if (!api) return undefined;
  try {
    const traceState = carrier.tracestate && api.createTraceState ? api.createTraceState(carrier.tracestate) : undefined;
    return api.trace.setSpanContext(api.context.active(), {
      traceId: carrier.parsed.traceId,
      spanId: carrier.parsed.spanId,
      traceFlags: carrier.parsed.traceFlags,
      isRemote: true,
      ...(traceState ? { traceState } : {}),
    });
  } catch {
    return undefined;
  }
}

// ─── Decision ────────────────────────────────────────────────────────────────

export type InboundMode = "nest" | "own";

export interface InboundDecision {
  /** `nest`: child of the active (ambient) context; `own`: we own the server side. */
  mode: InboundMode;
  /** Span kind to create (INTERNAL when nesting, SERVER when we own it). */
  kind: number;
  /** Policy applied (`nested` when the host already handled propagation). */
  policy: InboundPolicy | "nested";
  /** Where the caller's context came from, or `none`. */
  source: InboundCarrierName | "none";
  /** Parent Context to start the span in; `undefined` = the active context. */
  parentContext?: unknown;
  /** Span links to attach (the caller's context under `restart`). */
  links?: OtelSpanLinkLike[];
  /** The ambient server span, when nesting under one. */
  ambient?: AmbientSpan;
}

/**
 * Decide parent, kind and links for the request span. Pure with respect to the
 * request (reads headers/metadata) and the ambient OpenTelemetry context.
 */
export function decideInbound(ctx: RequestContext, settings: ResolvedPropagation): InboundDecision {
  const ambient = settings.serverSpan === "own" ? undefined : detectAmbientServerSpan();
  const nest = settings.serverSpan === "nest" || (settings.serverSpan === "auto" && ambient !== undefined);
  if (nest) {
    return { mode: "nest", kind: SPAN_KIND_INTERNAL, policy: "nested", source: "none", ambient };
  }

  const carrier = collectInboundCarrier(ctx, settings.carriers);
  if (!carrier) {
    return { mode: "own", kind: SPAN_KIND_SERVER, policy: settings.inbound, source: "none" };
  }

  const policy = effectiveInboundPolicy(settings, peerOf(ctx));
  const base = { mode: "own" as const, kind: SPAN_KIND_SERVER, policy, source: carrier.source };

  if (policy === "continue") {
    const parentContext = buildRemoteContext(carrier);
    // Without the OTel API there is nothing to parent; behave as before.
    return parentContext === undefined ? base : { ...base, parentContext };
  }

  const api = loadApi();
  const rootContext = api?.ROOT_CONTEXT;
  if (policy === "restart") {
    return {
      ...base,
      parentContext: rootContext,
      links: [
        {
          context: {
            traceId: carrier.parsed.traceId,
            spanId: carrier.parsed.spanId,
            traceFlags: carrier.parsed.traceFlags,
          },
          attributes: { "a2a.link_reason": "inbound_trace_restart" },
        },
      ],
    };
  }
  return { ...base, parentContext: rootContext };
}
