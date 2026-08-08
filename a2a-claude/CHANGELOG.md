# a2a-claude

## 0.3.0

### Minor Changes

- b3673aa: Add marketplace plugin support: `claude.marketplaces` and `claude.enabledPlugins` map to the SDK's flag-tier `settings` (`extraKnownMarketplaces` / `enabledPlugins`), so the SDK fetches and installs plugins itself — no pre-baked plugin directories, and no dependence on `settingSources` (marketplace plugins load even under full isolation).

  Because the SDK installs marketplace plugins asynchronously by default — installing nothing, reporting no error, and loading zero plugins on every subsequent run — the wrapper sets `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` for those sessions and runs a startup preflight that verifies every enabled plugin actually loaded, failing `initialize()` with the missing plugin names if not. The preflight diffs the session init message's plugin list rather than the `plugin_install` events, which report per-marketplace status and so read as successful even when the named plugin does not exist. The probe costs no tokens (init precedes any model call) and warms the plugin cache.

- 9e47b08: Add `claude.effort` and `claude.thinking`, mapping onto the Claude Agent SDK's `Options.effort` and `Options.thinking`. `effort` accepts `low`/`medium`/`high`/`xhigh`/`max` and is also settable via the `CLAUDE_EFFORT` environment variable; `thinking` accepts `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens?, display? }`, or `{ type: "disabled" }`.

  Both are additive and optional — `claude.model` remains a plain string and `claude.fallbackModel` is unchanged. Values are validated at `initialize()`, so an unsupported effort level or a malformed `thinking` object fails at startup with a message naming the allowed values rather than surfacing as an SDK error mid-task.

  Also fixes `features.emitThinkingEvents` producing no events at all. The SDK leaves `thinking.display` at `"omitted"`, so thinking blocks arrive with an empty string and the mapper's non-empty guard drops every one of them. When thinking events are enabled the wrapper now requests `display: "summarized"` — supplying a full `{ type: "adaptive", display: "summarized" }` when no thinking config is set, and filling in `display` on an explicit `adaptive`/`enabled` config that omits it. An explicit `display` (including `"omitted"`) and `{ type: "disabled" }` are both left untouched. Note that with thinking events on and no `claude.thinking` of your own, this turns adaptive thinking on and it costs thinking tokens.

- d6c2701: Add native A2A protocol v1.0 support, built on `@a2a-js/sdk@1.0.0`, while preserving full backward compatibility with A2A v0.3.x clients.

  **`@a2a-wrapper/core` (breaking):**

  - `buildAgentCard()` now produces the native v1.0 `AgentCard` shape (`supportedInterfaces[]` instead of `url`/`additionalInterfaces`/`protocolVersion`; `capabilities.extendedAgentCard` instead of `supportsAuthenticatedExtendedCard`; `stateTransitionHistory` removed). Callers reading the old v0.3 fields directly off the return value must update — the server itself still serves a fully v0.3-shaped card to legacy clients (see below).
  - `createA2AServer()`'s JSON-RPC/REST transports and the `/.well-known/agent-card.json` route now negotiate protocol version per-request via the `A2A-Version` header: `1.0`/absent-with-recent-header gets the native v1.0 card and wire shapes, while `0.3`/no-header-at-all (matching the SDK's own default) gets a fully v0.3-shaped card and JSON-RPC/REST translation via `@a2a-js/sdk`'s `compat/v0_3` layer.
  - `ServerOptions.protocolVersion` default changed from `"0.3"` to `"1.0"`.
  - New `ServerOptions.onListening` hook and `ServerOptions.agentCardSigning` option (Signed Agent Cards, RFC 7515 JWS, opt-in via `AgentCardConfig.signing` or the programmatic option).
  - New `extractUserText(message)` export centralizing inbound `Part` parsing for the v1.0 proto-oneof `Part` shape.
  - `TaskState` is now re-exported as a value (real numeric enum in v1.0, was a string-literal type in v0.3).
  - `@a2a-js/sdk` peer/dev dependency bumped to `^1.0.0`.

  **Wrapper packages (`a2a-claude`, `a2a-codex`, `a2a-copilot`, `a2a-opencode`, `a2a-antigravity`):**

  - Each wrapper's `createA2AServer()` public API is unchanged, but is now a thin delegate to `@a2a-wrapper/core`'s `createA2AServer` instead of duplicating Express/SDK server wiring — restoring the "A2A protocol code lives only in core" design.
  - `a2a-copilot` and `a2a-opencode` no longer ship their own local `event-publisher.ts`; both now use `@a2a-wrapper/core`'s (v1.0-aware) event publisher.
  - `@a2a-js/sdk` dependency bumped to `^1.0.0` (previously an inconsistent mix of `^0.3.9`/`^0.3.13`).

### Patch Changes

- Updated dependencies [d6c2701]
  - @a2a-wrapper/core@2.0.0

## Unreleased

### Minor Changes

- Native A2A v1.0 protocol support, fully backward compatible with v0.3.x clients — negotiated automatically per request via the `A2A-Version` header, no config changes needed. `createA2AServer()` is now a thin delegate to `@a2a-wrapper/core`'s server factory (upgraded to `@a2a-js/sdk@^1.0.0`) instead of duplicating Express/SDK wiring.

## 0.2.0

### Minor Changes

- 219f014: New wrapper: a2a-claude exposes Claude Code (via @anthropic-ai/claude-agent-sdk) as a spec-compliant A2A server — codex-parity feature set: streaming, per-context session resume, cancellation, permission-mode guardrails, MCP servers, A2A sub-agent delegation, memory materialization, and sideband observability events.
