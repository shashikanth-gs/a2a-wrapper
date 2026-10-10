---
"@a2a-wrapper/core": minor
"a2a-claude": minor
"a2a-codex": minor
---

feat(otel): Phase 5 attribute ownership + gateway ID mapping

- docs/otel-attribute-ownership.md aligned with draft GenAI A2A #254
- Span attrs: gen_ai.operation.name, a2a.method.name, session.id, a2a.gateway.*
- extractA2ATraceContext reads conversation/session/passkey/spectrum/ticket metadata
- Claude + Codex applyUsageSummaryToActiveSpan + x-usage on completed turns
