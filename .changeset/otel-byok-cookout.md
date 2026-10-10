---
"@a2a-wrapper/core": patch
"a2a-copilot": patch
"a2a-claude": patch
"a2a-codex": patch
"a2a-opencode": patch
"a2a-antigravity": patch
---

feat(otel): BYOK mock-Ollama cookout; wire CLI OTel bootstrap on all wrappers

- examples/otel-stack/mock-ollama.mjs (OpenAI Responses + Anthropic Messages)
- examples/otel-stack/cookout-byok.mjs end-to-end against Phoenix
- Hand-rolled wrapper CLIs now call bootstrapOtelSdkFromConfig / shutdownOtelSdk
- CLI bootstrap uses SimpleSpanProcessor for reliable short-lived export
