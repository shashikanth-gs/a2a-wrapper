/**
 * OpenTelemetry integration for `@a2a-wrapper/core`.
 *
 * @module telemetry
 */

export type {
  OtelCommonConfig,
  OtelConfig,
  OtelPropagationConfig,
  OtelCompat,
  OtelSpanNaming,
  OtelSpanConfig,
  OtelCopilotBackendConfig,
  OtelClaudeBackendConfig,
  OtelCodexBackendConfig,
  OtelOpenCodeBackendConfig,
  OtelCopilotConfig,
  OtelClaudeConfig,
  OtelCodexConfig,
  OtelOpenCodeConfig,
  OtelAntigravityConfig,
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
  resolveExporterHeaders,
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

export {
  PEER_HEADER,
  DEFAULT_PROPAGATION,
  resolvePropagationSettings,
  parseTraceparent,
  sanitizeTracestate,
  collectInboundCarrier,
  peerOf,
  isTrustedPeer,
  effectiveInboundPolicy,
  detectAmbientServerSpan,
  buildRemoteContext,
  decideInbound,
  type InboundPolicy,
  type UntrustedPolicy,
  type InboundCarrierName,
  type ServerSpanMode,
  type ResolvedPropagation,
  type ParsedTraceparent,
  type InboundCarrier,
  type InboundDecision,
} from "./propagation.js";

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
export {
  COMPAT_MODES,
  resolveCompat,
  compatRequestAttributes,
  compatToolAttributes,
} from "./compat.js";
export type { CompatRequestInfo, CompatSource } from "./compat.js";
export {
  SPAN_NAMING_MODES,
  resolveSpanNaming,
  requestSpanName,
  toolSpanName,
} from "./span-naming.js";
export type { SpanNamingSource } from "./span-naming.js";
