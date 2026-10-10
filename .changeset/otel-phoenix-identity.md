---
"@a2a-wrapper/core": minor
"a2a-claude": minor
"a2a-codex": minor
"a2a-copilot": minor
"a2a-opencode": minor
"a2a-antigravity": minor
---

feat(otel): Phoenix demo, package identity attrs, usage flags

- Replace Jaeger compose requirement with Arize Phoenix (`phoenix serve`, optional Docker)
- CLI bootstrap defaults to `http/protobuf` via `@opentelemetry/exporter-trace-otlp-proto` (Phoenix rejects JSON)
- Stamp `a2a.wrapper.core.version`, `a2a.wrapper.sdk`, `a2a.wrapper.sdk.version` on task spans
- Wire all wrapper servers with package name/version
- `otel.taskUsageRollup` (default true) + `otel.annotateUsageCalls` (default false; Claude/Codex per-call events)
- Smoke scripts: `examples/otel-stack/smoke-export.mjs` + `smoke-providers.mjs` (copilot/claude executor → Phoenix)
