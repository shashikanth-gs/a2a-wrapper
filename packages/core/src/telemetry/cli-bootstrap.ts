/**
 * Optional CLI OTel SDK bootstrap (Phase 4).
 *
 * Dynamically imports `@opentelemetry/sdk-node` + an OTLP HTTP exporter when
 * `otel.enabled` and `otel.exporter.endpoint` are set. If those packages are
 * not installed, logs a one-line hint and continues (spans stay no-op unless
 * the host registered a tracer another way).
 *
 * Protocol selection:
 * - `http/protobuf` (default) → `@opentelemetry/exporter-trace-otlp-proto`
 *   (required by Arize Phoenix; also what Copilot prefers)
 * - `http/json` → `@opentelemetry/exporter-trace-otlp-http`
 *
 * @module telemetry/cli-bootstrap
 */

import { setOtelTracer, getOtelTracer } from "./api.js";
import type { OtelConfig } from "./types.js";

type Shutdownable = { shutdown: () => Promise<void> };

let _sdk: Shutdownable | undefined;
let _warnedSkip = false;

function tracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/$/, "");
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
}

function normalizeProtocol(protocol?: string): "http/protobuf" | "http/json" {
  const p = (protocol ?? "http/protobuf").toLowerCase();
  if (p === "http/json" || p === "json") return "http/json";
  return "http/protobuf";
}

async function loadExporter(
  protocol: "http/protobuf" | "http/json",
): Promise<{ OTLPTraceExporter: new (opts: { url: string }) => unknown; used: string }> {
  if (protocol === "http/json") {
    const expSpec = "@opentelemetry/exporter-trace-otlp-http";
    const expMod = (await import(expSpec)) as Record<string, unknown>;
    return {
      OTLPTraceExporter: expMod.OTLPTraceExporter as new (opts: { url: string }) => unknown,
      used: expSpec,
    };
  }

  // Prefer protobuf package; fall back to http-json only with a clear failure
  // if protobuf is missing (Phoenix rejects application/json with 415).
  const protoSpec = "@opentelemetry/exporter-trace-otlp-proto";
  try {
    const expMod = (await import(protoSpec)) as Record<string, unknown>;
    return {
      OTLPTraceExporter: expMod.OTLPTraceExporter as new (opts: { url: string }) => unknown,
      used: protoSpec,
    };
  } catch (protoErr) {
    const msg = protoErr instanceof Error ? protoErr.message : String(protoErr);
    throw new Error(
      `http/protobuf requires optional peer \`${protoSpec}\` ` +
        `(Phoenix and many collectors reject JSON). Install it, or set ` +
        `otel.exporter.protocol to "http/json". (${msg})`,
    );
  }
}

/**
 * Start a NodeSDK + OTLP HTTP exporter and register the tracer for core hooks.
 * No-op when already bootstrapped, when OTel is disabled, or when endpoint is missing.
 */
export async function bootstrapOtelSdkFromConfig(
  otel?: OtelConfig | null,
): Promise<boolean> {
  if (!otel?.enabled) return false;
  const endpoint = otel.exporter?.endpoint;
  if (!endpoint) return false;
  if (getOtelTracer() && _sdk) return true;

  try {
    // Specifiers are variables so tsc does not require the optional peer packages
    // to be present at compile time (they are optionalPeers for CLI hosts).
    const sdkSpec = "@opentelemetry/sdk-node";
    const apiSpec = "@opentelemetry/api";
    const protocol = normalizeProtocol(otel.exporter?.protocol);
    const [sdkMod, apiMod, exporter] = await Promise.all([
      import(sdkSpec) as Promise<Record<string, unknown>>,
      import(apiSpec) as Promise<Record<string, unknown>>,
      loadExporter(protocol),
    ]);

    const NodeSDK = sdkMod.NodeSDK as new (opts: Record<string, unknown>) => Shutdownable & {
      start: () => void | Promise<void>;
    };
    const api = apiMod as {
      trace: { getTracer: (name: string, version?: string) => import("./types.js").OtelTracerLike };
    };

    const serviceName = otel.serviceName ?? "a2a-wrapper";
    const sdk = new NodeSDK({
      serviceName,
      traceExporter: new exporter.OTLPTraceExporter({ url: tracesUrl(endpoint) }),
    });
    await Promise.resolve(sdk.start());
    _sdk = sdk;
    setOtelTracer(api.trace.getTracer(otel.tracerName ?? "a2a-wrapper"));
    return true;
  } catch (err) {
    if (!_warnedSkip) {
      _warnedSkip = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        "[a2a-wrapper/otel] CLI OTel bootstrap skipped — install optional deps " +
          "`@opentelemetry/sdk-node` and `@opentelemetry/exporter-trace-otlp-proto` " +
          "(protobuf; preferred) or `@opentelemetry/exporter-trace-otlp-http` (JSON), " +
          `plus @opentelemetry/api. (${msg})`,
      );
    }
    return false;
  }
}

/** Flush/shutdown the SDK started by {@link bootstrapOtelSdkFromConfig}. */
export async function shutdownOtelSdk(): Promise<void> {
  if (!_sdk) return;
  const sdk = _sdk;
  _sdk = undefined;
  try {
    await sdk.shutdown();
  } catch {
    /* ignore shutdown errors */
  }
}
