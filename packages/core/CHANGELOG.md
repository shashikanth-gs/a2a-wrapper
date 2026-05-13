# Changelog

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
