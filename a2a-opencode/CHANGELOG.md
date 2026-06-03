# Changelog

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
- JSON-RPC endpoint at `/a2a/jsonrpc` — `tasks/send`, `tasks/sendSubscribe`, `tasks/get`, `tasks/cancel`
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
