# Changelog

## 2.1.0

### Minor Changes

- f3c7062: Handle Claude rate limit events instead of failing the turn generically.

  Rate-limit signals were previously unrecognised: `rate_limit_event`,
  `system/api_retry`, and assistant `rate_limit` errors all fell through to a
  debug log, and the turn surfaced as `failed` with `"Error during execution."`

  A rejection now ends the turn immediately with an `input-required` status naming
  the limit type and reset time, plus structured metadata (`reason`,
  `rateLimitType`, `resetsAt`, `resetsAtIso`, `utilization`, and `errorCode` /
  `canPurchaseCredits` when the SDK reports them). The task stays non-terminal, so
  the client continues the same conversation on the same task once the limit
  resets. Configurable via `rateLimit.taskState` for clients that require a
  terminal state.

  This does not shorten the SDK's own retry behaviour: a `system/api_retry` is
  deliberately treated as a warning that does not end the turn, so the SDK's
  internal retries still run to exhaustion inside the same `timeouts.prompt`
  window. The turn ends only once the SDK gives up and emits an assistant
  `rate_limit` error. Those retries are at least visible now, as `rate_limit`
  sideband events with `action: "retrying"` carrying the SDK's `attempt`,
  `maxRetries`, and `delayMs`.

  A rejection whose overage window is still open is treated as a warning rather
  than a rejection, since the request may proceed on overage credits; if it does
  not, the assistant `rate_limit` error still ends the turn. Limit details are
  never fabricated — a limit type or reset time is inherited by a later signal
  only from a snapshot that reported pressure, utilization is never inherited, and
  a reset time that is not in the future is dropped.

  Adds a `rate_limit` sideband event type to `@a2a-wrapper/core`, gated by
  `features.emitRateLimitEvents`.

- 41e2d82: Hold the A2A Task open while Claude has background work in flight.

  A Task used to reach a terminal state as soon as Claude's first turn ended —
  even when that turn had just started a background process and said it was
  waiting on the result. A2A gives an agent no way to open a new turn against a
  terminal Task, so the follow-up report had nowhere to land.

  The Task now stays in `working` for as long as Claude reports background work
  running, and completes only once a turn ends with nothing left. Each turn
  publishes its own `response` artifact and a non-final `working` status update
  whose `metadata.backgroundTasks` lists what is still in flight. Chains of any
  length work this way, as rounds of one Task rather than several Tasks.

  Controlled by `features.holdTaskForBackgroundWork` (default `true`; set
  `false` for the old complete-at-first-result behavior) and
  `features.emitBackgroundTaskEvents` (default `true`), which publishes a new
  `background_tasks` sideband event — added to `@a2a-wrapper/core` — each time
  the live set changes.

  Bumps `@anthropic-ai/claude-agent-sdk` from `0.3.202` to `0.3.245`. The
  feature needs at least `0.3.235`, the first version to emit
  `background_tasks_changed`.

  Three changes apply even with `holdTaskForBackgroundWork` off:

  - Queries now use streaming input rather than a string prompt. A string prompt
    makes the SDK close the CLI subprocess's stdin on the first result, which
    ends the process before a second round is possible. This is not switchable.
  - `agent_started` / `agent_finished` are emitted once per A2A Task rather than
    once per SDK turn.
  - A success result with empty text no longer publishes an empty `response`
    artifact.

  See the a2a-claude README for caveats, including how `claude.maxTurns` and
  `timeouts.prompt` now span a held-open Task's rounds.

## 2.0.0

### Major Changes

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

## Unreleased

### Major Changes

- **Native A2A protocol v1.0 support, backward compatible with v0.3.x.** Built on `@a2a-js/sdk@^1.0.0` and its `compat/v0_3` translation layer.
  - `buildAgentCard()` now produces the native v1.0 `AgentCard` shape (`supportedInterfaces[]` instead of `url`/`additionalInterfaces`/`protocolVersion`; `capabilities.extendedAgentCard` instead of `supportsAuthenticatedExtendedCard`; `stateTransitionHistory` removed). **Breaking** for any caller reading the old v0.3 fields directly off the return value — the server itself still serves a fully v0.3-shaped card to legacy clients.
  - `createA2AServer()`'s JSON-RPC/REST transports and the `/.well-known/agent-card.json` route negotiate protocol version per-request via the `A2A-Version` header. `ServerOptions.protocolVersion` default changed from `"0.3"` to `"1.0"`.
  - New `ServerOptions.onListening` hook and `ServerOptions.agentCardSigning` option (Signed Agent Cards, RFC 7515 JWS, opt-in via `AgentCardConfig.signing` or the programmatic option).
  - New `extractUserText(message)` export centralizing inbound `Part` parsing for the v1.0 proto-oneof `Part` shape.
  - `TaskState` is now re-exported as a value (real numeric enum in v1.0, was a string-literal type in v0.3).

## 1.7.0

### Minor Changes

- feat: add comprehensive LLM usage telemetry and tracking

## 1.6.1 — 2026-06-06

### Added

- **`publishTask`** — new exported helper. Registers a bare `Task` object with the A2A result manager before any status events are published. Previously duplicated in each wrapper; now shared from core so all wrappers can import it without a local copy.

## 1.6.0 — 2026-06-03

### Added

- **`substituteEnvTokensInString`** — new exported helper. Replaces `${VAR}` (explicit form) and `$VAR` (bare form) tokens in a single string. Works mid-string, e.g. `"Bearer ${TOKEN}"`.
- **`substituteEnvTokensInRecord`** — new exported helper. Applies env-var substitution to every value of a `Record<string, string>`, e.g. HTTP headers or process environment maps. Returns `undefined` for `undefined` input.
- Both helpers are exported from the `@a2a-wrapper/core` barrel so wrapper loaders don't duplicate the implementation.

### Changed

- **`substituteEnvTokens` (existing)** — now supports `${VAR}` in addition to bare `$VAR`. Backward-compatible.

## 1.5.0 — 2026-05-13

### Added

- **A2A Sub-Agents** — new `subAgents` config section lets a parent A2A agent expose remote A2A agents as MCP tools by spawning [`a2a-mcp-skillmap`](https://github.com/shashikanth-gs/a2a-mcp-skillmap) as a stdio MCP child process. The bridge is registered under the reserved `a2a-subagents` key in the resolved `mcp` map, so wrapper-side MCP wiring discovers it without any wrapper-specific code.
- **Bootstrap pipeline** — single entry point `bootstrapSubAgents()` orchestrates the full sequence: validate → build → write bridge config → probe → synthesize MCP descriptor. Wrapper integration is ~10 lines per wrapper.
- **Pinned skillmap version** — new `SKILLMAP_PACKAGE_VERSION` constant pins the `a2a-mcp-skillmap` version invoked via `npx` (pinned to `0.2.1`). Bumping the pin is a deliberate, reviewable change.
- **Reachability probe** — `probeSubAgents()` runs parallel HTTP probes against each sub-agent's effective URL at startup with structured `ProbeResult`s. Failures log warnings but never abort startup.
- **Sync budget** — new `SubAgentsOptions.syncBudgetMs` field controls how long the bridge waits for an A2A response before returning a task handle for async polling.
- **Reserved-key collision detection** — fail-fast validation rejects configs that manually define an MCP server under `a2a-subagents`.
- **Env-var substitution** — `auth.token` may reference environment variables via `${VAR}` syntax. Missing variables produce a startup warning and the auth block is omitted.
- **`BaseAgentConfig.subAgents`** — optional `subAgents?: SubAgentsConfig` field added to the base config type.
- **JSON schema** — `schemas/agent-config.schema.json` generated from TypeScript types via `npm run schema`. Drift-detection and schema validation tests ship in CI.

### New Exports

- Types: `SubAgentConfig`, `SubAgentAuthConfig`, `SubAgentsOptions`, `SubAgentsConfig`, `SynthesizedMcpDescriptor`, `ProbeResult`, `BootstrapInput`, `BootstrapResult`, `BridgeConfigSource`, `BridgeConfigAgentEntry`, `BridgeConfig`, `ValidationOutcome`, `SubAgentValidationReason`, `SubAgentValidationErrorDetails`
- Functions: `validateSubAgents`, `buildBridgeConfig`, `resolveBridgeConfigPath`, `writeBridgeConfig`, `probeSubAgents`, `buildSynthesizedMcpEntry`, `bootstrapSubAgents`
- Error class: `SubAgentValidationError`
- Constants: `SUBAGENTS_MCP_KEY`, `SKILLMAP_PACKAGE_VERSION`

## 1.4.0

### Added

- **Memory Persistence** — new `memory` config section allows agents to declare instructions and skills that are materialized into the workspace at startup. The core package provides a backend-agnostic materializer (`materializeMemory()`) that reads source files, validates SKILL.md frontmatter, and writes content to backend-specific paths before the executor handles its first request.
- **SKILL.md Parser** — `parseSkillManifest()`, `formatSkillManifest()`, and `validateSkillManifest()` functions for parsing YAML frontmatter from skill files. Uses a lightweight regex-based parser (no js-yaml dependency). Supports kebab-case name validation, arrays, quoted strings, and round-trip fidelity.
- **Well-Known Backend Paths** — `WELL_KNOWN_PATHS` constant with pre-defined path mappings for Copilot (`.github/`), Claude (`CLAUDE.md` + `.claude/`), OpenCode (`.opencode/`), and Codex (`.codex/` + `.agents/`). Wrappers can use these or define their own `BackendPaths`.
- **Path Resolution** — `resolveMemoryPath()` utility for resolving relative/absolute paths against the config directory.
- **BaseAgentConfig extended** — added optional `memory?: MemoryConfig` and `configDir?: string` fields to the base config type.
- **CLI scaffold injects configDir** — `createCli()` now automatically populates `configDir` from the config file path for memory path resolution.

### New Exports

- Types: `MemoryConfig`, `SkillManifest`, `ParsedSkill`, `BackendPaths`, `MaterializeOptions`
- Functions: `materializeMemory`, `parseSkillManifest`, `formatSkillManifest`, `validateSkillManifest`, `resolveMemoryPath`
- Constants: `WELL_KNOWN_PATHS`

## 1.3.0

### Added

- **Event Transport Abstraction** — new pluggable transport layer for sideband observability events. Built-in `A2ATransport` (default, publishes trace artifacts on the A2A EventBus) and `HttpTransport` (POSTs events as JSON to any HTTP collector). Custom transports (Kafka, Redis, DB) supported via the programmatic `createA2AServer()` API.
- **AgentEventEmitter** — per-execution emitter that stamps every event with agent identity, trace context, UUID, and ISO timestamp before routing through the transport.
- **EventsConfig** — new config section on `BaseAgentConfig` for controlling event emission, transport type, HTTP endpoint, timeout, and custom headers.
- **TRACE_EXTENSION_URI** — agent cards now declare `urn:x-a2a:trace:v1` in `capabilities.extensions` so orchestrators can discover sideband trace data.
- **ServerOptions.eventTransport** — `createA2AServer()` now accepts an optional custom event transport for programmatic use.

### Changed

- **Trace artifacts now include extension metadata** — `publishTraceArtifact()` and `publishThoughtArtifact()` now emit `extensions: [TRACE_EXTENSION_URI]` and `metadata: { traceType, timestamp }` on every trace artifact, allowing orchestrators to reliably distinguish trace artifacts from response artifacts.
- **Fix flaky property-based test** — excluded `-0` from the `fc.double()` arbitrary in the config loader round-trip test. `-0` doesn't survive JSON serialization (`JSON.stringify(-0)` → `"0"` → `+0`), causing intermittent failures.

## 1.2.1

### Changed

- Fix post-release bugs: Node 22 ESM resolution (postinstall patch for vscode-jsonrpc), auth error message clarity (GITHUB_TOKEN guidance), README corrections (message/\* method names, messageId in examples), and ResultManager race condition (publish task event before status-update in both executors).

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-04-02

### Added

- Initial extraction of shared infrastructure from `a2a-copilot` and `a2a-opencode`.
- `Logger` class with `createLogger` factory, `LogLevel` enum, and hierarchical child loggers.
- `Deferred<T>` interface with `createDeferred` and `sleep` utilities.
- `deepMerge` function with immutable recursive merge and `substituteEnvTokens` for env var interpolation.
- `BaseAgentConfig<TBackend>` generic config type system with `AgentCardConfig`, `ServerConfig`, `SessionConfig`, `BaseFeatureFlags`, `TimeoutConfig`, `LoggingConfig`, `BaseMcpServerConfig`, and `SkillConfig`.
- `loadConfigFile<T>` and `resolveConfig<T>` for layered config resolution (defaults ← file ← env ← CLI).
- Event publisher functions: `publishStatus`, `publishFinalArtifact`, `publishStreamingChunk`, `publishLastChunkMarker`, `publishTraceArtifact`, `publishThoughtArtifact`.
- `buildAgentCard` for constructing A2A-spec-compliant agent cards from config.
- `createA2AServer<T>` server factory with standard A2A routes, dynamic agent card URL rewriting, and configurable `A2A-Version` header.
- `BaseSessionManager<TSession>` abstract class with TTL-based cleanup and task tracking.
- `A2AExecutor` interface defining the executor contract for wrapper projects.
- `createCli<T>` CLI scaffold with common flag parsing, graceful shutdown, and extensible arg definitions.
- Barrel export (`src/index.ts`) with A2A SDK type re-exports for upgrade isolation.
- 19 property-based tests (fast-check) covering all correctness properties from the design document.
