/**
 * Optional OpenTelemetry tracer registry (skillmap-style).
 *
 * No hard dependency on `@opentelemetry/api`. Hosts that use the real API
 * obtain a tracer from their SDK and register it here (or rely on
 * {@link tryGetGlobalTracer} when the API package is installed).
 *
 * @module telemetry/api
 */

import { createRequire } from "node:module";
import type { OtelSpanLike, OtelTracerLike } from "./types.js";

const require = createRequire(import.meta.url);

let _tracer: OtelTracerLike | undefined;
let _warnedMissingProvider = false;

export function setOtelTracer(tracer: OtelTracerLike | undefined): void {
  _tracer = tracer;
}

export function getOtelTracer(): OtelTracerLike | undefined {
  return _tracer ?? tryGetGlobalTracer();
}

/**
 * Best-effort: if `@opentelemetry/api` is resolvable and a non-no-op provider
 * is registered, return its tracer. Never throws.
 */
export function tryGetGlobalTracer(name = "a2a-wrapper", version?: string): OtelTracerLike | undefined {
  try {
    const api = require("@opentelemetry/api") as {
      trace: {
        getTracer: (n: string, v?: string) => OtelTracerLike;
        getTracerProvider: () => { constructor?: { name?: string } };
      };
    };
    const provider = api.trace.getTracerProvider?.();
    const providerName = provider?.constructor?.name ?? "";
    if (!provider || providerName === "NoopTracerProvider") {
      return undefined;
    }
    return api.trace.getTracer(name, version);
  } catch {
    return undefined;
  }
}

/**
 * Run `block` under a span when a tracer is available; otherwise run plainly.
 * Always ends the span (including on throw).
 *
 * When `@opentelemetry/api` is installed and the span looks like a real API
 * span (`spanContext()`), the span is set as the active context so
 * {@link getW3cTraceContext} / Copilot `onGetTraceContext` / Claude
 * `TRACEPARENT` see this span as parent (Hook F).
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  block: (span: OtelSpanLike | undefined) => Promise<T>,
): Promise<T> {
  const tracer = getOtelTracer();
  if (!tracer) {
    if (!_warnedMissingProvider && process.env["A2A_OTEL_DEBUG"] === "1") {
      _warnedMissingProvider = true;
      console.warn("[a2a-wrapper/otel] no tracer registered; spans are no-ops");
    }
    return block(undefined);
  }

  const span = tracer.startSpan(name, { attributes });

  const run = async (): Promise<T> => {
    try {
      return await block(span);
    } catch (err) {
      try {
        span.recordException?.(err);
        // SpanStatusCode.ERROR === 2 in @opentelemetry/api
        span.setStatus?.({ code: 2, message: err instanceof Error ? err.message : String(err) });
      } catch {
        /* ignore span status failures */
      }
      throw err;
    } finally {
      span.end();
    }
  };

  try {
    const api = require("@opentelemetry/api") as {
      context: {
        active: () => unknown;
        with: <R>(ctx: unknown, fn: () => R) => R;
      };
      trace: { setSpan: (ctx: unknown, s: unknown) => unknown };
    };
    const maybeReal = span as OtelSpanLike & { spanContext?: () => unknown };
    if (typeof maybeReal.spanContext === "function") {
      const ctx = api.trace.setSpan(api.context.active(), span);
      return await api.context.with(ctx, run);
    }
  } catch {
    /* API missing or span not activatable — run without context bind */
  }

  return run();
}
