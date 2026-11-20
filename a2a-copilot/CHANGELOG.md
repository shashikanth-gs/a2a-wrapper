# Changelog

## 1.9.0

### Minor Changes

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

- a2bfdd2: feat(otel): Phase 3 backend passthrough (Hook F)

  - Core helpers: Copilot telemetry/onGetTraceContext, Claude OTel env + TRACEPARENT, Codex otel overrides
  - `withSpan` activates real OTel context so parent-link works
  - Shared `otel.exporter` endpoint inheritance
  - Wire Copilot / Claude / Codex; OpenCode/Antigravity documented

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

- 838c207: Fix: usage and lifecycle events now reach the configured event transport (#56). Previously, with `events.transport: "http"` (or a custom transport), a collector received `tool_call_*` events but no lifecycle events and no usage, because Copilot published usage only on the A2A event bus (`trace.usage`, `metadata["x-usage"]`).

  - New `agent_started` event once per task, and exactly one terminal `agent_finished` or `agent_error` event.
  - `agent_finished` carries `data.usage`, the same `UsageTelemetryData` summary that is sent as `x-usage` (totals plus the per-call `calls` log). `cost` is the provider-reported sum and stays `null` when none is reported; it is never estimated.
  - `agent_error` carries the failure message and `data.usage` (`null` when no LLM call had been made), so tokens spent before a failure are still accounted for.
  - The terminal event is awaited so it reaches the collector before the task is reported finished, capped at 2 seconds so a slow or unreachable collector cannot stall tasks.
  - With the default A2A transport, clients now also see `trace.lifecycle` sideband artifacts (`state: started` / `finished` / `error`) from Copilot, as they already do from Claude, Codex and Antigravity. `trace.usage` and `x-usage` are unchanged.
  - README documents the events Copilot emits and the HTTP payload shape.

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

## 1.8.2

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

## 1.8.1

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

## 1.7.0

### Minor Changes

- feat: add comprehensive LLM usage telemetry and tracking

### Patch Changes

- Updated dependencies
  - @a2a-wrapper/core@1.7.0

## 1.6.0 — 2026-06-03

### Added

- **Bring Your Own Model (BYOK)** — new `copilot.provider` config block lets you point the wrapper at any OpenAI-compatible endpoint instead of GitHub Copilot. Supports Ollama (local), OpenAI, Anthropic, Azure OpenAI, Azure AI Foundry, vLLM, LiteLLM, and any OpenAI-compatible API. The same `COPILOT_PROVIDER_*` env vars the `gh copilot` CLI uses are supported. No GitHub Copilot account required when using a custom provider.
- **New bundled example: `agents/ollama/`** — ready-to-run local agent backed by Ollama (verified with `qwen3.6`).
- **MCP custom headers** — `http` and `sse` MCP server configs now accept a `headers: Record<string, string>` map. Use for auth tokens and API keys against hosted MCP servers (Linear, Notion, remote GitHub MCP, etc.).
- **Env-var substitution extended** — `${ENV_VAR}` (explicit, recommended) and `$ENV_VAR` (bare, backward-compatible) substitution now applies to stdio `args`, stdio `env` values, and http/sse `headers` values. Keeps secrets out of `config.json`.

### Fixed

- **BYOK models emitting tool calls as plain text** — when a BYOK provider is configured and the model outputs a raw `{"name":...,"arguments":...}` JSON blob instead of a proper response (common with small local models lacking native tool-calling support), the wrapper detects it and returns an actionable error message instead of leaking raw JSON to the caller.
- **Logger level propagation** — `level: "debug"` in config now correctly reaches all child loggers. Previously, child loggers captured the level at module-import time before config was loaded.

### Changed

- **`@github/copilot-sdk` upgraded `0.2.2 → 1.0.0`** — migrated to the `RuntimeConnection` factory API; `session.destroy()` renamed to `session.disconnect()`. SDK 1.0.0 bumped CLI dependency to `@github/copilot@1.0.59`.
- **`@github/copilot` CLI upgraded `1.0.39 → 1.0.59`** — includes the v1.0.56 BYOK provider fix (custom providers now work correctly in headless SDK sessions), plus 20 versions of improvements.
- Updated dependencies
  - @a2a-wrapper/core@1.6.0

## 1.5.0 — 2026-05-13

### Added

- **A2A Sub-Agents** — new `subAgents` config section lets the parent agent expose remote A2A agents as MCP tools to the Copilot LLM. The wrapper spawns [`a2a-mcp-skillmap`](https://github.com/shashikanth-gs/a2a-mcp-skillmap) as a stdio MCP server and registers it under the reserved `a2a-subagents` key. Each remote skill becomes a callable tool the LLM can dispatch like any other MCP tool. See `agents/multi-agent/` for an example.
- **Pinned skillmap version** — the synthesized MCP entry invokes `npx -y a2a-mcp-skillmap@<pinned>` rather than the unpinned package name, so a future skillmap release cannot silently change semantics.
- **JSON schema for `config.json`** — `schemas/agent-config.schema.json` generated from the TypeScript types via `npm run schema`. Drift-detection and schema validation tests ship in CI.

### Changed

- Updated dependencies
  - @a2a-wrapper/core@1.5.0

## 1.4.0

### Added

- **Memory Persistence** — agents can now declare `memory.instructions` and `memory.skills` in their config.json. At startup, the executor materializes these files into the workspace at `.github/copilot-instructions.md` and `.github/skills/<name>/`, making them available to the Copilot LLM across sessions. Skills include SKILL.md manifests and optional resource directories (scripts/, references/, assets/).
- **configDir injection** — the CLI now automatically derives and injects `configDir` from the config file path, enabling relative path resolution in memory configs.

### Changed

- Updated dependencies
  - @a2a-wrapper/core@1.4.0

## 1.3.0

### Added

- **Event Transport Integration** — executor and MCP hooks now route all trace events (tool calls, reasoning) through the new `@a2a-wrapper/core` event transport abstraction instead of calling `publishTraceArtifact` directly. Supports A2A sideband (default), HTTP collectors, and custom transports.
- **Agent card delegates to core** — `buildAgentCard()` now delegates to `@a2a-wrapper/core`'s shared implementation, eliminating duplicated card construction logic.
- **MCP hooks refactored** — `McpEvidenceHooks` now uses `AgentEventEmitter` instead of raw `ExecutionEventBus`. Emits separate `tool_call_start` and `tool_call_end` events for better observability granularity.

### Changed

- **Fix MCP tool permissions hang in headless environments** — added `approveAll` from `@github/copilot-sdk` to `SessionManager.getOrCreate()` and `CopilotExecutor.buildContext()`. Without this, the SDK prompts for human approval on every MCP tool call and hangs indefinitely in Docker, Kubernetes, and CI environments.
- **Default events config** — defaults now include `events: { enabled: true, transport: "a2a" }`.
- Updated dependencies
  - @a2a-wrapper/core@1.3.0

## 1.2.2

### Changed

- Upgrade @github/copilot-sdk from ^0.1.25 to ^0.2.0 (stable release). vscode-jsonrpc is no longer a transitive dependency, resolving the Node 22 ESM crash upstream.

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
- GitHub Copilot SDK backend (`@github/copilot-sdk`) for LLM inference
- Real-time SSE streaming of status updates and artifact chunks
- Multi-turn conversation support via `contextId` → Copilot session mapping
- MCP tool server support — HTTP and stdio transports
- JSON config file with `$comment` annotations for easy customisation
- Environment variable and CLI argument overrides (priority: defaults ← JSON ← ENV ← CLI)
- `example` and `filesystem-assistant` bundled agent configurations
- Docker support with multi-stage build and corporate proxy CA injection
- `server.sh` lifecycle manager (start / stop / restart / status / logs / foreground)
- Health check endpoint at `/health`
- Context building endpoint at `/context/build`
- `--stream-artifacts` / `--no-stream-artifacts` flag for SSE vs. buffered output
- TypeScript public API exports for programmatic use

[Unreleased]: https://github.com/shashikanth-gs/a2a-wrapper/compare/copilot-v1.0.0...HEAD
[1.0.0]: https://github.com/shashikanth-gs/a2a-wrapper/releases/tag/copilot-v1.0.0
