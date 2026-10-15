---
"@a2a-wrapper/core": minor
---

feat(otel): optional OpenTelemetry task spans via `@opentelemetry/api`

- Optional peer `@opentelemetry/api` (no SDK/exporter in core)
- `instrumentExecutor` in `createA2AServer` for `a2a.task.execute` / cancel
- `AgentEventEmitter` respects emission policy (no duplicate tool spans when backend OTel is on)
- Exports: `setOtelTracer`, `withSpan`, `extractA2ATraceContext`, `getW3cTraceContext`, `resolveOtelEmissionPolicy`, …
