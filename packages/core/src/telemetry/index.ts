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
  W3cTraceContext,
} from "./types.js";
export { resolveOtelEmissionPolicy } from "./types.js";

export { setOtelTracer, getOtelTracer, tryGetGlobalTracer, withSpan } from "./api.js";

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
