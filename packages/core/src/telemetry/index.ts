/**
 * OpenTelemetry integration for `@a2a-wrapper/core`.
 *
 * @module telemetry
 */

export type {
  OtelConfig,
  OtelEmissionPolicy,
  OtelTracerLike,
  OtelSpanLike,
  OtelSpanContextLike,
  OtelSpanLinkLike,
  W3cTraceContext,
} from "./types.js";
export { resolveOtelEmissionPolicy } from "./types.js";

export {
  setOtelTracer,
  getOtelTracer,
  tryGetGlobalTracer,
  withSpan,
  type WithSpanOptions,
} from "./api.js";

export {
  bootstrapOtelSdkFromConfig,
  shutdownOtelSdk,
} from "./cli-bootstrap.js";

export {
  extractA2ATraceContext,
  getW3cTraceContext,
  injectW3cTraceHeaders,
  getTaskOtelStore,
  runWithTaskOtelStore,
  type A2ATraceContext,
  type TaskOtelStore,
} from "./context.js";

export {
  buildTaskSpanAttributes,
  slugAgentId,
  agentIdentityFromCard,
  type TaskInvocationKind,
} from "./attributes.js";

export { getCorePackageVersion, readPackageIdentity } from "./package-meta.js";

export { instrumentExecutor, type InstrumentExecutorOptions } from "./instrument.js";

export { observeAgentEvent } from "./emitter-bridge.js";

export {
  applyUsageSummaryToActiveSpan,
  applyUsageCallToActiveSpan,
} from "./usage-bridge.js";

export {
  createExecutionObservability,
  annotateSessionOnTaskSpan,
  type CreateExecutionObservabilityOptions,
  type ExecutionObservability,
} from "./observability.js";

export {
  resolveOtlpEndpoint,
  buildCopilotTelemetryOptions,
  shouldPropagateCopilotTraceContext,
  createCopilotTraceContextProvider,
  buildClaudeOtelEnv,
  mergeCodexOtelOverrides,
  isOpenCodeBackendOtelEnabled,
} from "./backend-passthrough.js";
