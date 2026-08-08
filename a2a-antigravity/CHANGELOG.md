# a2a-antigravity

## 0.2.0

### Minor Changes

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

## 0.1.1

### Patch Changes

Initial release of `a2a-antigravity`, an A2A protocol wrapper for Google Antigravity.

This package exposes Antigravity as a standalone HTTP A2A agent while keeping the public wrapper in Node/TypeScript. The Google Antigravity SDK remains isolated behind a private Python subprocess and JSONL bridge.

**Features:**

- **A2A-compliant server** - Agent Card, JSON-RPC, REST, and health endpoints via `@a2a-js/sdk`.
- **Google Antigravity SDK integration** - backed by `google-antigravity==0.1.5` through a private Python bridge.
- **Managed Python setup** - `a2a-antigravity setup` creates a virtual environment, installs bundled requirements, and verifies `google.antigravity` imports.
- **Gemini and Vertex auth** - supports Gemini API key auth and Vertex/ADC project/location configuration.
- **Tested Flash-Lite model** - example configs use `gemini-3.1-flash-lite`.
- **Command policy examples** - default config keeps SDK command policy defaults; `config.run-command.json` demonstrates trusted-workspace `run_command` enablement.
- **Sideband trace artifacts** - lifecycle, tool-start, usage, error, and response artifacts are mapped into A2A trace artifacts.
- **MCP passthrough** - stdio and Streamable HTTP MCP server configs are translated into Antigravity SDK config.
- **Memory materialization** - memory files are written to `AGENTS.md` and `.antigravity/skills/` before session startup.
- **A2A sub-agent delegation** - sub-agents are exposed through the shared `a2a-mcp-skillmap` bridge.
- **Subprocess lifecycle hardening** - bridge spawn errors, unexpected exits, write failures, shutdown, and signal handling are surfaced cleanly instead of hanging requests.
- **CI coverage** - GitHub Actions verifies TypeScript build/test plus managed Python setup and package contents before publish.

**Operational notes:**

- The default A2A port is `3040`, intentionally offset from `a2a-claude` on `3030`.
- The npm package does not run `pip` during install. Run `a2a-antigravity setup` once before starting the server, or provide your own Python with `ANTIGRAVITY_PYTHON`.
- `run_command` is denied by the Antigravity SDK default policy unless explicitly allowed.
