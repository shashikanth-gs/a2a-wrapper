---
"@a2a-wrapper/core": minor
"a2a-antigravity": minor
"a2a-claude": minor
"a2a-codex": minor
"a2a-copilot": minor
"a2a-opencode": minor
---

feat(otel): opt-in OpenTelemetry GenAI span names (`otel.spanNaming`)

- New `otel.spanNaming: "legacy" | "semconv"` (env `A2A_OTEL_SPAN_NAMING`, default `legacy`). `semconv` names the request span `invoke_agent {agent}` and mirrored tool spans `execute_tool {tool}`; the default is unchanged.
- Only names change, attributes are identical in both modes, and `a2a.task.cancel` is never renamed.
- The JSON Schema of every wrapper gains `otel.spanNaming`.
