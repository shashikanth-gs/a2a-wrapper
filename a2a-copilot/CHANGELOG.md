# Changelog

## 1.4.0

### Minor Changes

- **Memory Persistence** — agents can now declare `memory.instructions` and `memory.skills` in their config.json. At startup, the executor materializes these files into the workspace at `.github/copilot-instructions.md` and `.github/skills/<name>/`, making them available to the Copilot LLM across sessions. Skills include SKILL.md manifests and optional resource directories (scripts/, references/, assets/).
- **configDir injection** — the CLI now automatically derives and injects `configDir` from the config file path, enabling relative path resolution in memory configs.

### Patch Changes

- Updated dependencies
  - @a2a-wrapper/core@1.4.0

## 1.3.0

### Minor Changes

- **Event Transport Integration** — executor and MCP hooks now route all trace events (tool calls, reasoning) through the new `@a2a-wrapper/core` event transport abstraction instead of calling `publishTraceArtifact` directly. Supports A2A sideband (default), HTTP collectors, and custom transports.
- **Agent card delegates to core** — `buildAgentCard()` now delegates to `@a2a-wrapper/core`'s shared implementation, eliminating duplicated card construction logic.
- **MCP hooks refactored** — `McpEvidenceHooks` now uses `AgentEventEmitter` instead of raw `ExecutionEventBus`. Emits separate `tool_call_start` and `tool_call_end` events for better observability granularity.

### Patch Changes

- **Fix MCP tool permissions hang in headless environments** — added `approveAll` from `@github/copilot-sdk` to `SessionManager.getOrCreate()` and `CopilotExecutor.buildContext()`. Without this, the SDK prompts for human approval on every MCP tool call and hangs indefinitely in Docker, Kubernetes, and CI environments.
- **Default events config** — defaults now include `events: { enabled: true, transport: "a2a" }`.
- Updated dependencies
  - @a2a-wrapper/core@1.3.0

## 1.2.2

### Patch Changes

- Upgrade @github/copilot-sdk from ^0.1.25 to ^0.2.0 (stable release). vscode-jsonrpc is no longer a transitive dependency, resolving the Node 22 ESM crash upstream.

## 1.2.1

### Patch Changes

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
