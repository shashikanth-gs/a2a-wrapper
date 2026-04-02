# Changelog

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
