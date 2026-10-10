#!/usr/bin/env node
/**
 * Emit one wrapper-shaped span to a local Phoenix (or any OTLP HTTP collector).
 *
 *   phoenix serve   # UI http://127.0.0.1:6006  OTLP HTTP …/v1/traces
 *   node examples/otel-stack/smoke-export.mjs
 *
 * Requires optional peers:
 *   @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto
 */

import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const corePkg = join(root, "packages/core/package.json");
const { version: coreVersion } = require(corePkg);

const endpoint = process.env.OTEL_EXPORTER_ENDPOINT ?? "http://127.0.0.1:6006";
const phoenixApi = process.env.PHOENIX_API ?? "http://127.0.0.1:6006";

async function loadCore() {
  // Prefer built dist; fall back to telling the user to build.
  const dist = pathToFileURL(join(root, "packages/core/dist/index.js")).href;
  try {
    return await import(dist);
  } catch {
    console.error("Build core first: (cd packages/core && npm run build)");
    process.exit(1);
  }
}

const core = await loadCore();
const ok = await core.bootstrapOtelSdkFromConfig({
  enabled: true,
  serviceName: "a2a-wrapper-smoke",
  exporter: { endpoint, protocol: "http/protobuf" },
});
if (!ok) {
  console.error(
    "bootstrapOtelSdkFromConfig failed — install @opentelemetry/sdk-node and " +
      "@opentelemetry/exporter-trace-otlp-proto (and @opentelemetry/api).",
  );
  process.exit(1);
}

const taskId = `smoke-${Date.now()}`;
await core.withSpan(
  "a2a.task.execute",
  core.buildTaskSpanAttributes({
    taskId,
    contextId: "smoke-conversation",
    agentName: "Smoke Agent",
    wrapperName: "a2a-wrapper-smoke",
    wrapperVersion: "0.0.0-smoke",
    coreVersion,
    messageId: "msg-smoke-1",
    invocation: 1,
    invocationKind: "new",
  }),
  async (span) => {
    span?.setAttribute?.("a2a.task.usage.input_tokens", 3);
    span?.setAttribute?.("a2a.task.usage.output_tokens", 1);
    span?.setAttribute?.("a2a.task.usage.llm_calls", 1);
    await new Promise((r) => setTimeout(r, 50));
  },
);

await core.shutdownOtelSdk();
console.log(`Exported smoke span taskId=${taskId} → ${endpoint}/v1/traces`);

// Give Phoenix a moment to index, then list projects.
await new Promise((r) => setTimeout(r, 1500));
try {
  const res = await fetch(`${phoenixApi}/v1/projects`);
  const body = await res.text();
  console.log(`Phoenix GET /v1/projects → ${res.status}`);
  console.log(body.slice(0, 2000));
} catch (err) {
  console.warn("Could not query Phoenix API (is phoenix serve running?)", err);
  process.exitCode = 2;
}
