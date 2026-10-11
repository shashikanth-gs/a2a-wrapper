---
"@a2a-wrapper/core": patch
"a2a-copilot": patch
"a2a-claude": patch
"a2a-codex": patch
"a2a-opencode": patch
"a2a-antigravity": patch
---

feat(otel): BYOK cookout + shared mock-ollama; wire CLI OTel bootstrap

- examples/mock-ollama/ — reusable fake Ollama (OpenAI + Anthropic) for any cookout
- examples/otel-stack/cookout-byok.mjs layers Phoenix/OTel on that stub
- Hand-rolled wrapper CLIs now call bootstrapOtelSdkFromConfig / shutdownOtelSdk
- CLI bootstrap uses SimpleSpanProcessor for reliable short-lived export
