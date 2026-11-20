---
"@a2a-wrapper/core": minor
"a2a-antigravity": minor
"a2a-claude": minor
"a2a-codex": minor
"a2a-copilot": minor
"a2a-opencode": minor
---

feat(otel): join the caller's distributed trace (design: `docs/design/distributed-tracing.md`)

- `a2a.task.execute` now continues the W3C `traceparent` / `tracestate` sent by the caller (HTTP header for JSON-RPC and REST, message metadata as fallback), with strict validation.
- Behaviour change: the request span is now `SpanKind.SERVER`. When `@opentelemetry/instrumentation-http` is active the span nests under the HTTP SERVER span as `INTERNAL` instead (`otel.span.server: "auto"`), so there are no duplicate SERVER spans.
- New config: `otel.propagation.{inbound,trustedPeers,untrusted,carriers}`, `otel.span.{server,enrichServerSpan}`, `otel.exporter.headers`, `server.trustProxy`; env overrides `A2A_OTEL_INBOUND`, `A2A_OTEL_TRUSTED_PEERS`, `A2A_OTEL_UNTRUSTED`, `A2A_OTEL_CARRIERS`, `A2A_OTEL_SERVER_SPAN`, `A2A_OTEL_ENRICH_SERVER_SPAN`.
- Trust: `trustedPeers` limits who may supply trace context; the caller address is set by the server from the socket (a client `x-a2a-peer` header is overwritten). Untrusted callers get `restart` (new trace plus span link) or `ignore`.
- Request spans record `a2a.propagation.policy` and `a2a.propagation.source`.
- Event-transport events and A2A artifact data carry `otelTraceId` / `otelSpanId`.
- The JSON Schema of every wrapper gains the new `otel` and `server` fields.
