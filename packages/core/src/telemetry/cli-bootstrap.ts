/**
 * Optional CLI OTel SDK bootstrap (Phase 4).
 *
 * Dynamically imports `@opentelemetry/sdk-node` + OTLP HTTP exporter when
 * `otel.enabled` and `otel.exporter.endpoint` are set. If those packages are
 * not installed, logs a one-line hint and continues (spans stay no-op unless
 * the host registered a tracer another way).
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
    const expSpec = "@opentelemetry/exporter-trace-otlp-http";
    const apiSpec = "@opentelemetry/api";
    const [sdkMod, expMod, apiMod] = await Promise.all([
      import(sdkSpec) as Promise<Record<string, unknown>>,
      import(expSpec) as Promise<Record<string, unknown>>,
      import(apiSpec) as Promise<Record<string, unknown>>,
    ]);

    const NodeSDK = sdkMod.NodeSDK as new (opts: Record<string, unknown>) => Shutdownable & {
      start: () => void | Promise<void>;
    };
    const OTLPTraceExporter = expMod.OTLPTraceExporter as new (opts: { url: string }) => unknown;
    const api = apiMod as {
      trace: { getTracer: (name: string, version?: string) => import("./types.js").OtelTracerLike };
    };

    const serviceName = otel.serviceName ?? "a2a-wrapper";
    const sdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter({ url: tracesUrl(endpoint) }),
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
          "`@opentelemetry/sdk-node` and `@opentelemetry/exporter-trace-otlp-http` " +
          `(and ensure @opentelemetry/api is present). (${msg})`,
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
