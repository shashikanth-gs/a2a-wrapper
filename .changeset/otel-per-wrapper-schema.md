---
"@a2a-wrapper/core": patch
"a2a-copilot": patch
"a2a-claude": patch
"a2a-codex": patch
"a2a-opencode": patch
"a2a-antigravity": patch
---

fix(otel): per-wrapper OTel schema — common at top, backend knobs only for that package

OpenCode no longer advertises `otel.backend.codex` (and peers). Shared flags stay
on `otel.*`; only `otel.backend.<this-wrapper>` appears in each agent schema.
