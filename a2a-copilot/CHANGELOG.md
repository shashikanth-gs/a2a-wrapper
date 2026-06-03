# Changelog

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
- JSON-RPC endpoint at `/a2a/jsonrpc` — `tasks/send`, `tasks/sendSubscribe`, `tasks/get`, `tasks/cancel`
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
