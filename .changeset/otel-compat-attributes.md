---
"@a2a-wrapper/core": minor
"a2a-antigravity": minor
"a2a-claude": minor
"a2a-codex": minor
"a2a-copilot": minor
"a2a-opencode": minor
---

feat(otel): opt-in Langfuse and Phoenix attribute sets (`otel.compat`)

- New `otel.compat: ["langfuse", "openinference"]` (env `A2A_OTEL_COMPAT`, default none). Adds `langfuse.observation.type` and the OpenInference `openinference.span.kind`, `agent.name`, `graph.node.*` (parent edge only when a parent agent is known) to the request span, and the tool equivalents to mirrored tool spans, so Langfuse and Phoenix draw their agent views.
- Standard attributes are never changed; with no compat selected the attribute set is identical to before.
- Content (`input.value`/`output.value`) and `llm.token_count.*` are intentionally not added.
- The JSON Schema of every wrapper gains `otel.compat`.
