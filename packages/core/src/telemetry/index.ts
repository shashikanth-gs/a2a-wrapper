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
  getTaskOtelStore,
  runWithTaskOtelStore,
  type A2ATraceContext,
  type TaskOtelStore,
} from "./context.js";

export { buildTaskSpanAttributes, slugAgentId, agentIdentityFromCard } from "./attributes.js";

export { instrumentExecutor, type InstrumentExecutorOptions } from "./instrument.js";

export { observeAgentEvent } from "./emitter-bridge.js";
