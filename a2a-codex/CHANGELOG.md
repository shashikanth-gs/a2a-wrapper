# a2a-codex

## 1.7.1

### Patch Changes

- Updated dependencies [f3c7062]
- Updated dependencies [41e2d82]
  - @a2a-wrapper/core@2.1.0

## 1.7.0

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

## 1.6.1

### Patch Changes

- Updated dependencies
  - @a2a-wrapper/core@1.7.0

## 1.6.0

### Minor Changes

Initial release of `a2a-codex` — an A2A protocol wrapper for the OpenAI Codex SDK.

**Features:**

- **A2A-compliant server** — JSON-RPC and REST transports via `@a2a-js/sdk`, Agent Card at `/.well-known/agent-card.json`, health endpoint at `/health`
- **OpenAI Codex SDK integration** — backs every A2A task with a Codex thread (`@openai/codex-sdk`); supports `workspace-write`, `read-only`, and `danger-full-access` sandbox modes
- **Multi-turn context continuity** — each A2A `contextId` maps to a persistent Codex thread; turns are serialized per-context via a promise queue
- **AbortController cancellation** — `cancelTask` aborts the in-flight `runStreamed` call and publishes a `canceled` status
- **MCP tool support** — stdio and http transports; config baked at SDK construction time; `${ENV_VAR}` substitution in args/env/headers
- **Multi-agent delegation** — A2A sub-agents auto-bootstrapped via `bootstrapSubAgents` from `@a2a-wrapper/core`; synthesized as an MCP server entry before client construction
- **Sideband events** — reasoning summaries, command events, file-change events, and trace artifacts emitted through `AgentEventEmitter`
- **Streaming artifacts** — opt-in delta streaming via `features.streamArtifactChunks`; buffered artifact mode (Inspector-compatible) by default
- **Memory materialization** — memory files written to workspace before each session
- **JSON config** — `config.json` driven with `${ENV_VAR}` token substitution; precedence: defaults ← file ← env ← CLI
- **CLI** — `a2a-codex --config agents/example/config.json`; individual flags: `--port`, `--workspace`, `--model`, `--sandbox`, `--log-level`, etc.
- **Context API** — `GET /context` to read a context file; `POST /context/build` to generate one via a read-only Codex thread
- **Bundled example agents** — `agents/example/` (workspace engineer), `agents/read-only-reviewer/` (code review), `agents/multi-agent/` (lead engineer with sub-agent delegation)
