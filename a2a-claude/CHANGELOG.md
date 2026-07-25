# a2a-claude

## Unreleased

### Minor Changes

- Native A2A v1.0 protocol support, fully backward compatible with v0.3.x clients — negotiated automatically per request via the `A2A-Version` header, no config changes needed. `createA2AServer()` is now a thin delegate to `@a2a-wrapper/core`'s server factory (upgraded to `@a2a-js/sdk@^1.0.0`) instead of duplicating Express/SDK wiring.

## 0.2.0

### Minor Changes

- 219f014: New wrapper: a2a-claude exposes Claude Code (via @anthropic-ai/claude-agent-sdk) as a spec-compliant A2A server — codex-parity feature set: streaming, per-context session resume, cancellation, permission-mode guardrails, MCP servers, A2A sub-agent delegation, memory materialization, and sideband observability events.
