---
"@a2a-wrapper/core": minor
"a2a-copilot": patch
"a2a-claude": patch
"a2a-codex": patch
"a2a-opencode": patch
"a2a-antigravity": patch
---

feat(otel): Phase 2 usage mapping + shared execution observability

- Hook E: `applyUsageSummaryToActiveSpan` with anti-dupe policy — `a2a.task.usage.*` rollup always; `gen_ai.usage.*` only when backend OTel is off
- Hook B: `createExecutionObservability` adopted by all wrappers
- Hook C: `annotateSessionOnTaskSpan`; W3C `injectW3cTraceHeaders` for outbound calls
- Docs: usage double-count rules in `docs/observability.md`
