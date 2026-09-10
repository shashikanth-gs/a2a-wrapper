---
"@a2a-wrapper/core": patch
"a2a-claude": patch
"a2a-copilot": patch
"a2a-opencode": patch
"a2a-codex": patch
"a2a-antigravity": patch
---

No code changes. A prior release run published every package's exact
target version under the `canary` npm dist-tag instead of `latest` (the
`canary` job's snapshot step no-ops when there are no pending changesets,
which was the case immediately after that Version Packages PR merged —
see the canary-job fix in a preceding commit). Since npm never allows
republishing an already-used version string, the only way to get a
`latest`-tagged release out is a fresh patch bump.
