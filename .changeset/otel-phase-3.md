---
"@a2a-wrapper/core": minor
"a2a-copilot": minor
"a2a-claude": minor
"a2a-codex": minor
---

feat(otel): Phase 3 backend passthrough (Hook F)

- Core helpers: Copilot telemetry/onGetTraceContext, Claude OTel env + TRACEPARENT, Codex otel overrides
- `withSpan` activates real OTel context so parent-link works
- Shared `otel.exporter` endpoint inheritance
- Wire Copilot / Claude / Codex; OpenCode/Antigravity documented
