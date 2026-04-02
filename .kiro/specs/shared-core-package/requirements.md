# Requirements Document

## Introduction

This document specifies the requirements for extracting shared infrastructure code from two A2A protocol wrapper projects (a2a-copilot and a2a-opencode) into a reusable `@a2a-wrapper/core` npm package. Both projects follow the same architectural pattern — wrapping a backend AI system behind a fully A2A-spec-compliant HTTP server — and share near-identical implementations of logging, configuration loading, event publishing, agent card building, server bootstrapping, session management, and CLI scaffolding. The goal is to eliminate duplication, centralize A2A spec compliance in one place, and make it trivial to add new wrapper projects or update for newer A2A spec versions.

The shared core package will be published independently on npm and consumed as a dependency by both a2a-copilot and a2a-opencode (and any future wrappers). Each wrapper project remains a separate open-source repository/package. Enterprise-level coding standards (CMMI Level 5) apply: extensive inline documentation, strict TypeScript, comprehensive test coverage, and semantic versioning.

## Glossary

- **Core_Package**: The `@a2a-wrapper/core` npm package containing all shared infrastructure code extracted from the two wrapper projects.
- **Wrapper_Project**: An independently published npm package (e.g. a2a-copilot, a2a-opencode) that depends on Core_Package and provides backend-specific integration code.
- **Agent_Card_Builder**: The module that constructs an A2A AgentCard object from resolved configuration, computing endpoint URLs and capability flags.
- **Config_Loader**: The module responsible for loading, merging, and resolving agent configuration from defaults, JSON files, environment variables, and CLI overrides using a layered deep-merge pipeline.
- **Event_Publisher**: The module providing helper functions for publishing A2A TaskStatusUpdateEvent and TaskArtifactUpdateEvent through the ExecutionEventBus.
- **Server_Factory**: The module that creates, wires, and starts an Express-based A2A HTTP server with standard routes (agent card, JSON-RPC, REST, health, context).
- **Session_Manager**: The module managing the mapping from A2A contextId to backend sessions, including TTL-based cleanup and task tracking.
- **Logger**: The structured logging module providing leveled, child-logger-capable logging with configurable root name.
- **Deferred**: The promise utility module providing externally-resolvable promises and sleep helpers.
- **CLI_Scaffold**: The module providing reusable CLI argument parsing patterns, main-loop scaffolding, and graceful shutdown handling.
- **Deep_Merge**: A utility function that recursively merges objects where arrays are replaced (not concatenated) and neither input is mutated.
- **Executor_Interface**: An abstract interface/contract that each Wrapper_Project implements to connect its backend system to the A2A server.
- **A2A_Spec**: The Agent-to-Agent protocol specification (currently v0.3.x) defining agent cards, task lifecycle, streaming, and transport formats.
- **Base_Config**: The set of configuration type interfaces shared across all wrappers: AgentCardConfig, ServerConfig, SessionConfig, FeatureFlags, TimeoutConfig, LoggingConfig, SkillConfig.
- **Backend_Config**: The wrapper-specific configuration section (e.g. CopilotConfig, OpenCodeConfig) that each Wrapper_Project defines independently.

## Requirements

### Requirement 1: Package Structure and Publishing

**User Story:** As a maintainer, I want the shared core to be a standalone npm package with its own versioning, so that wrapper projects can depend on it independently and receive updates via standard npm mechanisms.

#### Acceptance Criteria

1. THE Core_Package SHALL be publishable as `@a2a-wrapper/core` on npm with `"type": "module"` and ESM output targeting ES2022.
2. THE Core_Package SHALL emit TypeScript declaration files (`.d.ts`) and source maps alongside compiled JavaScript.
3. THE Core_Package SHALL declare `@a2a-js/sdk`, `express`, and `uuid` as peer dependencies so that Wrapper_Projects control exact versions.
4. THE Core_Package SHALL use semantic versioning where major bumps indicate breaking API changes, minor bumps indicate new features, and patch bumps indicate bug fixes.
5. THE Core_Package SHALL include a `tsconfig.json` with `strict: true`, `NodeNext` module resolution, and settings identical to the existing wrapper projects.
6. WHEN a new A2A_Spec version is released, THE Core_Package SHALL be the single location where protocol-level changes (agent card shape, event types, transport wiring) are updated.

### Requirement 2: Structured Logger

**User Story:** As a wrapper developer, I want a reusable structured logger with configurable root name, so that each wrapper project gets consistent logging without duplicating the implementation.

#### Acceptance Criteria

1. THE Core_Package SHALL export a `Logger` class with `debug`, `info`, `warn`, and `error` methods that accept a message string and optional structured data object.
2. THE Core_Package SHALL export a `LogLevel` enum with values DEBUG (0), INFO (1), WARN (2), ERROR (3).
3. THE Logger SHALL support a `child(name)` method that returns a new Logger instance with the name formatted as `{parent}:{child}` and inheriting the parent's current log level.
4. THE Logger SHALL support a `setLevel(level)` method that changes the minimum log level at runtime.
5. THE Logger SHALL format output as `[ISO_timestamp] [LEVEL] [name] message {data}` and route ERROR to `console.error`, WARN to `console.warn`, and all others to `console.log`.
6. THE Core_Package SHALL export a `createLogger(rootName)` factory function that returns a new Logger instance, allowing each Wrapper_Project to set its own root name (e.g. "a2a-copilot", "a2a-opencode").
7. THE Logger SHALL suppress messages below the configured minimum level.

### Requirement 3: Promise Utilities

**User Story:** As a wrapper developer, I want shared promise utilities (Deferred, sleep), so that I do not duplicate these primitives across projects.

#### Acceptance Criteria

1. THE Core_Package SHALL export a `createDeferred<T>()` function that returns an object with `promise`, `resolve`, and `reject` properties.
2. THE Core_Package SHALL export a `Deferred<T>` TypeScript interface describing the shape returned by `createDeferred`.
3. THE Core_Package SHALL export a `sleep(ms)` function that returns a Promise resolving after the specified milliseconds.

### Requirement 4: Deep Merge Utility

**User Story:** As a wrapper developer, I want a shared deep-merge function, so that configuration layering logic is consistent and tested in one place.

#### Acceptance Criteria

1. THE Core_Package SHALL export a `deepMerge(target, source)` function that recursively merges `source` into `target`.
2. THE Deep_Merge function SHALL replace arrays rather than concatenating them.
3. THE Deep_Merge function SHALL return a new object without mutating either input.
4. THE Deep_Merge function SHALL skip `undefined` values in the source object.
5. THE Deep_Merge function SHALL handle `null` values by replacing the target value with `null`.

### Requirement 5: Base Configuration Types

**User Story:** As a wrapper developer, I want shared TypeScript interfaces for the common configuration sections, so that all wrappers have a consistent config shape and I only update shared types in one place.

#### Acceptance Criteria

1. THE Core_Package SHALL export interfaces for `AgentCardConfig`, `ServerConfig`, `SessionConfig`, `SkillConfig`, `LoggingConfig`, and `TimeoutConfig` that are identical to the current shared definitions in both projects.
2. THE Core_Package SHALL export a generic `BaseAgentConfig<TBackend>` interface that includes `agentCard`, `server`, `session`, `logging`, `timeouts`, and a generic `backend: TBackend` field for wrapper-specific configuration.
3. THE Core_Package SHALL export a `BaseFeatureFlags` interface containing the `streamArtifactChunks` flag shared by both projects.
4. WHEN a Wrapper_Project needs additional feature flags (e.g. `autoApprovePermissions`), THE Wrapper_Project SHALL extend `BaseFeatureFlags` with its own interface.
5. THE Core_Package SHALL export a `BaseMcpServerConfig` type or set of interfaces covering the common MCP server configuration patterns (at minimum: a type discriminator and enabled flag).

### Requirement 6: Configuration Loader

**User Story:** As a wrapper developer, I want a reusable config loading pipeline (defaults ← file ← env ← CLI), so that every wrapper gets the same layered merge behavior without reimplementing it.

#### Acceptance Criteria

1. THE Core_Package SHALL export a `loadConfigFile(filePath)` function that reads and parses a JSON file, returning the parsed object or throwing a descriptive error.
2. THE Core_Package SHALL export a `resolveConfig(defaults, configFilePath?, envOverrides?, cliOverrides?)` function that merges layers in order: defaults ← file ← env ← CLI using Deep_Merge.
3. THE Config_Loader SHALL accept a generic type parameter so that each Wrapper_Project can pass its own full config type (extending BaseAgentConfig) through the pipeline.
4. THE Core_Package SHALL export a `substituteEnvTokens(config, pathToArgs)` utility that replaces `$VAR_NAME` tokens in string arrays with matching environment variable values, leaving unmatched tokens unchanged.
5. IF a config file path is provided and the file cannot be read or parsed, THEN THE Config_Loader SHALL throw an Error with the absolute file path and the underlying error message.

### Requirement 7: Agent Card Builder

**User Story:** As a wrapper developer, I want a shared agent card builder, so that A2A AgentCard construction from config is consistent and spec-compliant across all wrappers.

#### Acceptance Criteria

1. THE Core_Package SHALL export a `buildAgentCard(config)` function that constructs an A2A `AgentCard` object from a resolved configuration containing `agentCard` and `server` sections.
2. THE Agent_Card_Builder SHALL compute `url`, `additionalInterfaces` (JSONRPC and REST), and all capability flags from the config.
3. THE Agent_Card_Builder SHALL use `advertiseProtocol` and `advertiseHost` from ServerConfig to construct endpoint URLs.
4. THE Agent_Card_Builder SHALL set `stateTransitionHistory` to `false` regardless of config input, as this capability is not implemented in the A2A v1.0 spec.
5. THE Agent_Card_Builder SHALL map `SkillConfig` arrays to the A2A skill format, including optional `examples` only when present.

### Requirement 8: A2A Event Publisher

**User Story:** As a wrapper developer, I want shared event publishing helpers, so that all wrappers emit spec-compliant A2A status and artifact events without duplicating the event construction logic.

#### Acceptance Criteria

1. THE Core_Package SHALL export a `publishStatus(bus, taskId, contextId, state, messageText?, final?)` function that publishes a `TaskStatusUpdateEvent` with a proper timestamp and optional agent message.
2. THE Core_Package SHALL export a `publishFinalArtifact(bus, taskId, contextId, text)` function that publishes a complete, non-appending artifact event with `lastChunk: true`.
3. THE Core_Package SHALL export a `publishStreamingChunk(bus, taskId, contextId, artifactId, chunkText)` function that publishes an appending artifact chunk with `lastChunk: false`.
4. THE Core_Package SHALL export a `publishLastChunkMarker(bus, taskId, contextId, artifactId, fullText)` function that publishes the final streaming chunk with `lastChunk: true`.
5. THE Core_Package SHALL export a `publishTraceArtifact(bus, taskId, contextId, traceKey, data)` function for structured DataPart trace artifacts.
6. THE Core_Package SHALL export a `publishThoughtArtifact(bus, taskId, contextId, traceKey, text)` function for TextPart trace artifacts.
7. THE Event_Publisher SHALL generate unique artifact IDs using UUID v4 for every published artifact.

### Requirement 9: A2A Server Factory

**User Story:** As a wrapper developer, I want a reusable server factory that sets up Express with all standard A2A routes, so that I only provide my executor and get a fully wired server.

#### Acceptance Criteria

1. THE Core_Package SHALL export a `createA2AServer(config, executorFactory)` function that creates an Express app with standard A2A routes and starts listening.
2. THE Server_Factory SHALL register routes for: agent card (`/.well-known/agent-card.json` and legacy paths), JSON-RPC (`/a2a/jsonrpc`), REST (`/a2a/rest`), and health check (`/health`).
3. THE Server_Factory SHALL add A2A-Version response header middleware that sets `A2A-Version: 0.3` on all responses.
4. THE Server_Factory SHALL implement a dynamic agent card handler that rewrites endpoint URLs based on the request's `Host` and `x-forwarded-proto` headers for reverse proxy compatibility.
5. THE Server_Factory SHALL accept an `executorFactory` parameter (a function or class) that the Wrapper_Project provides, so the server is decoupled from any specific backend.
6. THE Server_Factory SHALL return a `ServerHandle` object with `app`, `server`, `executor`, and `shutdown()` members.
7. THE Server_Factory SHALL support optional route registration hooks so that Wrapper_Projects can add custom routes (e.g. `/mcp/status`, `/context`, `/context/build`) before the server starts listening.

### Requirement 10: Session Manager Base Class

**User Story:** As a wrapper developer, I want a reusable session manager that handles contextId-to-session mapping, TTL cleanup, and task tracking, so that I only implement the backend-specific session creation logic.

#### Acceptance Criteria

1. THE Core_Package SHALL export an abstract `BaseSessionManager` class that manages the mapping from A2A contextId to session entries with `lastUsed` timestamps.
2. THE BaseSessionManager SHALL implement `startCleanup()` and `stopCleanup()` methods that periodically remove sessions exceeding the configured TTL.
3. THE BaseSessionManager SHALL implement `trackTask(taskId, sessionId, contextId?)`, `getSessionForTask(taskId)`, `getContextForTask(taskId)`, and `untrackTask(taskId)` methods for task-to-session mapping.
4. THE BaseSessionManager SHALL implement a `shutdown()` method that stops cleanup timers and clears all internal maps.
5. WHEN `reuseByContext` is enabled in SessionConfig, THE BaseSessionManager SHALL return existing sessions for known contextIds if they have not exceeded TTL.
6. WHEN a session exceeds TTL, THE BaseSessionManager SHALL remove the session from the context map during the next cleanup cycle.

### Requirement 11: CLI Scaffold

**User Story:** As a wrapper developer, I want reusable CLI scaffolding (argument parsing helpers, main-loop pattern, graceful shutdown), so that each wrapper's CLI entry point is minimal and consistent.

#### Acceptance Criteria

1. THE Core_Package SHALL export a `createCli(options)` function that accepts a configuration object specifying: the package name, version, default config, a usage string, a function to parse wrapper-specific CLI args into config overrides, and an executor factory.
2. THE CLI_Scaffold SHALL implement the standard main-loop pattern: parse args → resolve config → set log level → create server → register SIGINT/SIGTERM handlers for graceful shutdown.
3. THE CLI_Scaffold SHALL support `--agent-json` / `--config`, `--port`, `--hostname`, `--advertise-host`, `--agent-name`, `--agent-description`, `--stream-artifacts` / `--no-stream-artifacts`, `--log-level`, `--help`, and `--version` as common flags shared across all wrappers.
4. THE CLI_Scaffold SHALL allow each Wrapper_Project to define additional wrapper-specific flags (e.g. `--opencode-url`, `--cli-url`) via the args-parsing callback.
5. IF `--help` is passed, THEN THE CLI_Scaffold SHALL print the usage string and exit with code 0.
6. IF `--version` is passed, THEN THE CLI_Scaffold SHALL print the package version and exit with code 0.
7. IF a fatal error occurs during startup, THEN THE CLI_Scaffold SHALL log the error with stack trace and exit with code 1.

### Requirement 12: Executor Interface Contract

**User Story:** As a wrapper developer, I want a clearly defined executor interface, so that I know exactly what methods my backend-specific executor must implement to plug into the shared server.

#### Acceptance Criteria

1. THE Core_Package SHALL export an `A2AExecutor` TypeScript interface (or abstract class) that defines the contract a Wrapper_Project's executor must satisfy.
2. THE A2AExecutor interface SHALL extend or be compatible with the `@a2a-js/sdk/server` `TaskExecutor` type so it can be passed directly to `DefaultRequestHandler`.
3. THE A2AExecutor interface SHALL include an `initialize(): Promise<void>` method for async startup logic.
4. THE A2AExecutor interface SHALL include a `shutdown(): Promise<void>` method for cleanup.
5. THE A2AExecutor interface SHALL optionally include `getContextContent(): Promise<string | null>` and `buildContext(prompt?: string): Promise<string>` methods for context file operations.

### Requirement 13: Wrapper Project Integration

**User Story:** As a wrapper developer, I want clear integration points so that after extracting shared code, each wrapper project contains only its backend-specific code and a thin CLI/config layer.

#### Acceptance Criteria

1. WHEN a Wrapper_Project depends on Core_Package, THE Wrapper_Project SHALL import all shared utilities (Logger, Deferred, Deep_Merge, Event_Publisher, Agent_Card_Builder, Server_Factory, Config_Loader, Session_Manager, CLI_Scaffold) from `@a2a-wrapper/core`.
2. THE Wrapper_Project SHALL define its own backend-specific config interface (e.g. `CopilotConfig`, `OpenCodeConfig`) and compose it with `BaseAgentConfig<TBackend>`.
3. THE Wrapper_Project SHALL implement the `A2AExecutor` interface with its backend-specific logic.
4. THE Wrapper_Project SHALL provide a defaults object and an env-overrides function for its backend-specific config fields.
5. WHEN the Core_Package is updated to a new minor or patch version, THE Wrapper_Project SHALL be able to upgrade without code changes (backward compatible).

### Requirement 14: Documentation and Code Quality

**User Story:** As a maintainer operating at CMMI Level 5, I want extensive inline documentation and strict coding standards, so that the codebase is auditable, maintainable, and onboarding-friendly.

#### Acceptance Criteria

1. THE Core_Package SHALL include JSDoc comments on every exported function, class, interface, type alias, and enum member.
2. THE Core_Package SHALL include a module-level doc comment at the top of every source file describing the module's purpose and responsibilities.
3. THE Core_Package SHALL pass `tsc --strict --noEmit` with zero errors and zero warnings.
4. THE Core_Package SHALL include a README.md with: package overview, installation instructions, quick-start example, API reference summary, and contribution guidelines.
5. THE Core_Package SHALL include a CHANGELOG.md following Keep a Changelog format.

### Requirement 15: Extensibility for Future Wrappers and Spec Versions

**User Story:** As a maintainer, I want the core package architecture to support adding new wrapper projects and adapting to future A2A spec versions with minimal effort.

#### Acceptance Criteria

1. THE Core_Package SHALL use generic type parameters in Config_Loader, Server_Factory, and CLI_Scaffold so that new Wrapper_Projects can plug in without modifying core code.
2. THE Server_Factory SHALL accept a protocol version parameter so that future A2A spec versions can be supported by changing a single value.
3. THE Core_Package SHALL isolate all A2A SDK type imports behind re-exported type aliases so that a major SDK upgrade requires changes only in Core_Package, not in Wrapper_Projects.
4. WHEN a new backend integration is needed, THE developer SHALL be able to create a new Wrapper_Project by: implementing A2AExecutor, defining a backend config type, providing defaults, and calling `createCli()` — with no changes to Core_Package.
