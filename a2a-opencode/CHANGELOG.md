# Changelog

## 1.8.0

### Minor Changes

- b8b0671: Support OpenCode 2.x alongside 1.x (#60). OpenCode 2 moved its whole server API under `/api/*`, requires HTTP Basic auth, and admits prompts to a durable inbox, so the 1.x client could not talk to it.

  - New 2.x client built on `@opencode/client`, behind a common `OpenCodeBackend` interface. The executor, session manager, permission handler and MCP manager are unchanged in behaviour and work with either generation.
  - `opencode.apiVersion` (`auto` | `1` | `2`, default `auto`) selects the protocol. `auto` probes `GET /api/info`; if the server is unreachable at startup, 1.x is assumed as before.
  - New `--api-version <auto|1|2>` CLI flag. There is deliberately no password flag (it would leak into process listings and shell history); use `OPENCODE_SERVER_PASSWORD`.
  - New `opencode.password` / `opencode.username` options and `OPENCODE_SERVER_PASSWORD` / `OPENCODE_API_VERSION` environment variables. A missing or wrong 2.x password now fails at startup with a clear message instead of at the first API call.
  - Forcing `apiVersion: "1"` against a 2.x server also fails at startup with a clear version error.
  - The event stream now waits (up to 5s) for the subscription to be live before a prompt is sent, and `disconnect()` aborts the underlying stream.
  - Fix: a fatal startup error no longer aborts the process on Windows with a libuv `Assertion failed ... UV_HANDLE_CLOSING` message. The CLI now exits via `process.exitCode` (with a forced-exit fallback) and the version probes release their HTTP response bodies.
  - `Promise.withResolvers` is polyfilled for Node 20, which `@opencode/client` needs for its event stream (Node 22+ has it natively).
  - Absolute project directories are passed through in either POSIX or Windows style, so the wrapper and the OpenCode server may run on different operating systems.
  - Fix: `a2a-opencode` now emits `agent_started` and exactly one `agent_finished` / `agent_error` per task through the configured event transport, as the other wrappers do. `agent_finished` carries `data.usage` (the shared `UsageTelemetryData` summary, one entry per LLM call, on both OpenCode 1.x and 2.x; `null` when no call was observed). Previously only `tool_call_*` events were emitted, although the README claimed lifecycle events. With the default A2A transport, clients now also see `trace.lifecycle` sideband artifacts. OpenCode's own `cost` figure is passed through and never estimated.
  - README gains a tested-versions matrix (OpenCode 1.19.6 and 2.3.2) and notes on 2.x behaviour differences. The JSON schema, `.env.example`, example agent configs and `start.sh` headers, CLI `--help`, and `docs/security.md` are updated for the new options; `server.sh` warns when 2.x generated a random password.

- f6efa31: feat(otel): opt-in Langfuse and Phoenix attribute sets (`otel.compat`)

  - New `otel.compat: ["langfuse", "openinference"]` (env `A2A_OTEL_COMPAT`, default none). Adds `langfuse.observation.type` and the OpenInference `openinference.span.kind`, `agent.name`, `graph.node.*` (parent edge only when a parent agent is known) to the request span, and the tool equivalents to mirrored tool spans, so Langfuse and Phoenix draw their agent views.
  - Standard attributes are never changed; with no compat selected the attribute set is identical to before.
  - Content (`input.value`/`output.value`) and `llm.token_count.*` are intentionally not added.
  - The JSON Schema of every wrapper gains `otel.compat`.

- dda8404: feat(events): event attribution, `events.transport: "both"`, and `${VAR}` in event settings

  - New `events.transport: "both"` sends each event to the A2A sideband and the HTTP collector with the same `eventId`; a failing collector never blocks the A2A copy.
  - `events.httpUrl` and `events.httpHeaders` values support `${VAR}` substitution (unset variable: left as written, warned once, value never logged). New env overrides `A2A_EVENTS_TRANSPORT` and `A2A_EVENTS_HTTP_URL`.
  - Every event now carries the orchestrator's `propagatedMetadata` (bounded to 64 keys / 8 KB, key charset `[A-Za-z0-9_.-]`, secret-looking keys redacted).
  - A2A trace artifacts gain `eventId`, `parentAgentId`, `otelTraceId`, `otelSpanId` in metadata and `event_id`, `parent_agent_id`, `propagated_metadata` in data.
  - The JSON Schema of every wrapper accepts `events.transport: "both"`.

- 079ce38: feat(otel): join the caller's distributed trace (design: `docs/design/distributed-tracing.md`)

  - `a2a.task.execute` now continues the W3C `traceparent` / `tracestate` sent by the caller (HTTP header for JSON-RPC and REST, message metadata as fallback), with strict validation.
  - Behaviour change: the request span is now `SpanKind.SERVER`. When `@opentelemetry/instrumentation-http` is active the span nests under the HTTP SERVER span as `INTERNAL` instead (`otel.span.server: "auto"`), so there are no duplicate SERVER spans.
  - New config: `otel.propagation.{inbound,trustedPeers,untrusted,carriers}`, `otel.span.{server,enrichServerSpan}`, `otel.exporter.headers`, `server.trustProxy`; env overrides `A2A_OTEL_INBOUND`, `A2A_OTEL_TRUSTED_PEERS`, `A2A_OTEL_UNTRUSTED`, `A2A_OTEL_CARRIERS`, `A2A_OTEL_SERVER_SPAN`, `A2A_OTEL_ENRICH_SERVER_SPAN`.
  - Trust: `trustedPeers` limits who may supply trace context; the caller address is set by the server from the socket (a client `x-a2a-peer` header is overwritten). Untrusted callers get `restart` (new trace plus span link) or `ignore`.
  - Request spans record `a2a.propagation.policy` and `a2a.propagation.source`.
  - Event-transport events and A2A artifact data carry `otelTraceId` / `otelSpanId`.
  - The JSON Schema of every wrapper gains the new `otel` and `server` fields.

- a2bfdd2: feat(otel): Phoenix demo, package identity attrs, usage flags

  - Replace Jaeger compose requirement with Arize Phoenix (`phoenix serve`, optional Docker)
  - CLI bootstrap defaults to `http/protobuf` via `@opentelemetry/exporter-trace-otlp-proto` (Phoenix rejects JSON)
  - Stamp `a2a.wrapper.core.version`, `a2a.wrapper.sdk`, `a2a.wrapper.sdk.version` on task spans
  - Wire all wrapper servers with package name/version
  - `otel.taskUsageRollup` (default true) + `otel.annotateUsageCalls` (default false; Claude/Codex per-call events)
  - Smoke scripts: `examples/otel-stack/smoke-export.mjs` + `smoke-providers.mjs` (copilot/claude executor → Phoenix)

- 55b2f9d: feat(otel): opt-in OpenTelemetry GenAI span names (`otel.spanNaming`)

  - New `otel.spanNaming: "legacy" | "semconv"` (env `A2A_OTEL_SPAN_NAMING`, default `legacy`). `semconv` names the request span `invoke_agent {agent}` and mirrored tool spans `execute_tool {tool}`; the default is unchanged.
  - Only names change, attributes are identical in both modes, and `a2a.task.cancel` is never renamed.
  - The JSON Schema of every wrapper gains `otel.spanNaming`.

### Patch Changes

- dc4be8a: chore(deps): upgrade `@a2a-js/sdk` to ^1.3.0

  - Bumps the SDK range (dependency and peer range in core) from ^1.0.0 to ^1.3.0
  - core: the SDK now routes v0.3 JSON-RPC requests by an exact `A2A-Version: 0.3` header; `createA2AServer` normalizes `0.3.x` values (e.g. `0.3.0`) to `0.3` so legacy clients keep working

- 8a7e7d3: Default `model` is now `auto` everywhere: no wrapper pins a model name in code (#95).

  - Core: new `AUTO_MODEL`, `isAutoModel` and `normalizeModel`. Unset, empty, `auto` and `default` (any case) all mean "let the provider choose".
  - a2a-copilot: the default changes from `claude-sonnet-4.5` to `auto`, passed as the literal `auto`, which the Copilot runtime accepts (the old default is rejected by the runtime bundled with `@github/copilot-sdk` 1.0.34). Example configs no longer pin models. A custom BYOK provider still requires an explicit model.
  - a2a-codex: `auto` (the new default) picks the first model Codex lists for the logged-in account (`codex debug models`, then the `models_cache.json` fallback, then Codex's own default), so a stale model pinned in `~/.codex/config.toml` is no longer inherited. Explicit names still win.
  - a2a-claude, a2a-opencode, a2a-antigravity: `auto`/`default`/empty resolve to unset so the backend applies its own default.

- 090ae9d: Upgrade `@opencode-ai/sdk` (1.x client) from `^1.15.13` to `^1.19.6` (#86). Type changes in the shipped v2 types are additive; no wrapper code changes. `@opencode/client` (2.x) is already at its latest, 2.3.2.
- a2bfdd2: feat(otel): BYOK cookout + shared mock-ollama; wire CLI OTel bootstrap

  - examples/mock-ollama/ — reusable fake Ollama (OpenAI + Anthropic) for any cookout
  - examples/otel-stack/cookout-byok.mjs layers Phoenix/OTel on that stub
  - Hand-rolled wrapper CLIs now call bootstrapOtelSdkFromConfig / shutdownOtelSdk
  - CLI bootstrap uses SimpleSpanProcessor for reliable short-lived export

- a2bfdd2: fix(otel): per-wrapper OTel schema — common at top, backend knobs only for that package

  OpenCode no longer advertises `otel.backend.codex` (and peers). Shared flags stay
  on `otel.*`; only `otel.backend.<this-wrapper>` appears in each agent schema.

- a2bfdd2: feat(otel): Phase 2 usage mapping + shared execution observability

  - Hook E: `applyUsageSummaryToActiveSpan` with anti-dupe policy — `a2a.task.usage.*` rollup always; `gen_ai.usage.*` only when backend OTel is off
  - Hook B: `createExecutionObservability` adopted by all wrappers
  - Hook C: `annotateSessionOnTaskSpan`; W3C `injectW3cTraceHeaders` for outbound calls
  - Docs: usage double-count rules in `docs/observability.md`

- Updated dependencies [dc4be8a]
- Updated dependencies [ba063f9]
- Updated dependencies [8a7e7d3]
- Updated dependencies [a2bfdd2]
- Updated dependencies [f6efa31]
- Updated dependencies [a2bfdd2]
- Updated dependencies [dda8404]
- Updated dependencies [079ce38]
- Updated dependencies [a2bfdd2]
- Updated dependencies [a2bfdd2]
- Updated dependencies [a2bfdd2]
- Updated dependencies [a2bfdd2]
- Updated dependencies [a2bfdd2]
- Updated dependencies [a2bfdd2]
- Updated dependencies [55b2f9d]
- Updated dependencies [98d2027]
  - @a2a-wrapper/core@2.2.0

## 1.7.2

### Patch Changes

- 4e2bd82: No code changes. A prior release run published every package's exact
  target version under the `canary` npm dist-tag instead of `latest` (the
  `canary` job's snapshot step no-ops when there are no pending changesets,
  which was the case immediately after that Version Packages PR merged —
  see the canary-job fix in a preceding commit). Since npm never allows
  republishing an already-used version string, the only way to get a
  `latest`-tagged release out is a fresh patch bump.
- Updated dependencies [4e2bd82]
  - @a2a-wrapper/core@2.1.1

## 1.7.1

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

- Updated dependencies [f3c7062]
- Updated dependencies [41e2d82]
- Updated dependencies [d6c2701]
  - @a2a-wrapper/core@2.1.0

## 1.6.1

### Patch Changes

- Updated dependencies
  - @a2a-wrapper/core@1.7.0

## 1.6.0 — 2026-06-03

### Added

- **MCP custom headers** — `remote` MCP server configs now accept a `headers: Record<string, string>` map. Use for auth tokens and API keys against hosted MCP servers (Linear, Notion, remote GitHub MCP, etc.). Header values support `${ENV_VAR}` substitution so secrets stay out of `config.json`.
- **Env-var substitution extended** — `${ENV_VAR}` (explicit, recommended) and `$ENV_VAR` (bare, backward-compatible) substitution now applies to local `command` args, local `environment` values, and remote `headers` values.
- **`@opencode-ai/sdk` upgraded `1.14.29 → 1.15.13`** — no breaking changes; v2 API surface is additive.

### Fixed

- **Logger level propagation** — `level: "debug"` in config now correctly reaches all child loggers. Previously, child loggers captured the level at module-import time before config was loaded.

### Changed

- Updated dependencies
  - @a2a-wrapper/core@1.6.0

## 1.5.0 — 2026-05-13

### Added

- **A2A Sub-Agents** — new `subAgents` config section lets the parent agent expose remote A2A agents as MCP tools to the OpenCode LLM. The wrapper spawns [`a2a-mcp-skillmap`](https://github.com/shashikanth-gs/a2a-mcp-skillmap) as a stdio MCP server and registers it under the reserved `a2a-subagents` key. Each remote skill becomes a callable tool the LLM can dispatch like any other MCP tool. See `agents/multi-agent/` for an example.
- **Pinned skillmap version** — the synthesized MCP entry invokes `npx -y a2a-mcp-skillmap@<pinned>` rather than the unpinned package name, so a future skillmap release cannot silently change semantics.
- **JSON schema for `config.json`** — `schemas/agent-config.schema.json` generated from the TypeScript types via `npm run schema`. Drift-detection and schema validation tests ship in CI.

### Changed

- Updated dependencies
  - @a2a-wrapper/core@1.5.0

## 1.4.0

### Added

- **Memory Persistence** — agents can now declare `memory.instructions` and `memory.skills` in their config.json. At startup, the executor materializes these files into the workspace at backend-specific paths. The target path is determined by the configured model: Claude models → `CLAUDE.md` + `.claude/skills/`, Codex models → `.codex/` + `.agents/skills/`, all others → `.opencode/instructions.md` + `.opencode/skills/`.
- **configDir injection** — the CLI now automatically derives and injects `configDir` from the config file path, enabling relative path resolution in memory configs.

### Changed

- Updated dependencies
  - @a2a-wrapper/core@1.4.0

## 1.3.0

### Added

- **Event Transport Integration** — executor now routes all trace events (tool calls, reasoning) through the new `@a2a-wrapper/core` event transport abstraction instead of calling `publishTraceArtifact` directly. Supports A2A sideband (default), HTTP collectors, and custom transports.
- **Agent card delegates to core** — `buildAgentCard()` now delegates to `@a2a-wrapper/core`'s shared implementation, eliminating duplicated card construction logic.
- **OpenCode SDK upgrade** — upgraded `@opencode-ai/sdk` from `1.3.13` to `1.4.3`. Renamed `FileDiff` → `SnapshotFileDiff` to match the new SDK export.

### Changed

- **Default events config** — defaults now include `events: { enabled: true, transport: "a2a" }`.
- Updated dependencies
  - @a2a-wrapper/core@1.3.0

## 1.2.1

### Changed

- Fix post-release bugs: Node 22 ESM resolution (postinstall patch for vscode-jsonrpc), auth error message clarity (GITHUB_TOKEN guidance), README corrections (message/\* method names, messageId in examples), and ResultManager race condition (publish task event before status-update in both executors).
- Updated dependencies
  - @a2a-wrapper/core@1.2.1

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-04-02

### Changed

- Migrated to monorepo structure with npm workspaces, Turborepo, and Changesets
- Extracted shared infrastructure to `@a2a-wrapper/core` package (logging, config, events, server factory, session management, CLI scaffold)
- Now depends on `@a2a-wrapper/core` for all shared functionality
- Consolidated community docs (CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, LICENSE) to repository root
- Unified CI/CD with Turborepo-powered GitHub Actions workflows
- Switched test script to `vitest --run` for non-interactive CI execution

## [1.0.0] - 2025-02-23

### Added

- A2A v0.3.0 protocol implementation over Express HTTP server
- Agent Card served at `/.well-known/agent-card.json`
- JSON-RPC endpoint at `/a2a/jsonrpc` — `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`
- REST endpoint at `/a2a/rest`
- OpenCode backend (`@opencode-ai/sdk`) for LLM inference via `opencode serve`
- SSE event streaming with automatic reconnect and polling fallback
- Multi-turn conversation support via `contextId` → OpenCode session mapping
- MCP tool server support — HTTP, SSE, stdio, and OAuth transports
- Auto-approval of tool permissions (`PermissionHandler`)
- JSON config file with `$comment` annotations for easy customisation
- Environment variable and CLI argument overrides (priority: defaults ← JSON ← ENV ← CLI)
- `example` bundled agent configuration
- Docker support with multi-stage build and corporate proxy CA injection
- `server.sh` lifecycle manager (start / stop / restart / status / logs / foreground)
- Health check endpoint at `/health`
- Context building endpoint at `/context/build`
- `--stream-artifacts` / `--no-stream-artifacts` flag for SSE vs. buffered output
- Postman collection for all A2A and system endpoints
- TypeScript public API exports for programmatic use

[Unreleased]: https://github.com/shashikanth-gs/a2a-wrapper/compare/opencode-v1.0.0...HEAD
[1.0.0]: https://github.com/shashikanth-gs/a2a-wrapper/releases/tag/opencode-v1.0.0
