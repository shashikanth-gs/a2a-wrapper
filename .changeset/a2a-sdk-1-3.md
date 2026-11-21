---
"@a2a-wrapper/core": patch
"a2a-copilot": patch
"a2a-claude": patch
"a2a-codex": patch
"a2a-opencode": patch
"a2a-antigravity": patch
---

chore(deps): upgrade `@a2a-js/sdk` to ^1.3.0

- Bumps the SDK range (dependency and peer range in core) from ^1.0.0 to ^1.3.0
- core: the SDK now routes v0.3 JSON-RPC requests by an exact `A2A-Version: 0.3` header; `createA2AServer` normalizes `0.3.x` values (e.g. `0.3.0`) to `0.3` so legacy clients keep working
