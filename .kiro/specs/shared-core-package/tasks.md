# Implementation Plan: @a2a-wrapper/core

## Overview

Extract shared infrastructure code from a2a-copilot and a2a-opencode into a reusable `@a2a-wrapper/core` npm package. Tasks are ordered foundationally: package scaffolding → utilities → config types/loader → events → server → session → executor → CLI → barrel export → tests → documentation. Each task builds on the previous, and all code is wired together by the final barrel export.

## Tasks

- [x] 1. Scaffold package structure and build configuration
  - [x] 1.1 Create `packages/core/package.json` with `@a2a-wrapper/core` name, `"type": "module"`, ES2022 target, peer dependencies (`@a2a-js/sdk`, `express`, `uuid`), dev dependencies (`typescript`, `vitest`, `fast-check`, `@types/express`, `@types/uuid`, `@types/node`), and standard scripts (`build`, `typecheck`, `test`, `clean`)
    - Include `"exports"` field pointing to `./dist/index.js` and `"types"` to `./dist/index.d.ts`
    - Include `"files": ["dist"]` for npm publishing
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - [x] 1.2 Create `packages/core/tsconfig.json` with `strict: true`, `NodeNext` module resolution, `ES2022` target, `declaration: true`, `declarationMap: true`, `sourceMap: true`, matching the existing wrapper project settings
    - _Requirements: 1.5_
  - [x] 1.3 Create the directory structure: `src/utils/`, `src/config/`, `src/events/`, `src/server/`, `src/session/`, `src/executor/`, `src/cli/`, `src/__tests__/`
    - _Requirements: 1.1_

- [x] 2. Implement utility modules (Logger, Deferred, deepMerge)
  - [x] 2.1 Create `src/utils/logger.ts` — `LogLevel` enum, `Logger` class with `debug`/`info`/`warn`/`error` methods, `child(name)`, `setLevel(level)`, `static parseLevel(str)`, and `createLogger(rootName)` factory function
    - Port from `a2a-copilot/src/utils/logger.ts`, replacing the hardcoded singleton with the `createLogger` factory
    - Include CMMI Level 5 JSDoc on every export and a module-level doc comment
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
  - [x] 2.2 Write property tests for Logger (Properties 1, 2, 3)
    - **Property 1: Logger naming chain** — `createLogger(root).child(c1).child(c2)` produces name `root:c1:c2`
    - **Validates: Requirements 2.3, 2.6**
    - **Property 2: Logger level suppression** — after `setLevel(L)`, only levels ≥ L produce output
    - **Validates: Requirements 2.4, 2.7**
    - **Property 3: Logger output format** — output matches `[ISO] [LEVEL] [name] msg {data}` pattern, routed to correct console method
    - **Validates: Requirements 2.5**
  - [x] 2.3 Create `src/utils/deferred.ts` — `Deferred<T>` interface, `createDeferred<T>()` function, `sleep(ms)` function
    - Port from `a2a-copilot/src/utils/deferred.ts` with full JSDoc
    - _Requirements: 3.1, 3.2, 3.3_
  - [x] 2.4 Write property test for Deferred (Property 4)
    - **Property 4: Deferred resolve round trip** — `createDeferred<T>()`, `resolve(value)`, `await promise` yields same value; `reject(reason)` yields same reason
    - **Validates: Requirements 3.1**
  - [x] 2.5 Create `src/utils/deep-merge.ts` — `deepMerge(target, source)` function and `substituteEnvTokens(args)` function
    - Port `deepMerge` from `a2a-copilot/src/config/loader.ts` into its own module, add generic type signature
    - Extract `substituteEnvTokens` as a standalone exported function
    - Include full JSDoc documenting merge rules (arrays replaced, undefined skipped, null replaces)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 6.4_
  - [x] 2.6 Write property tests for deepMerge (Properties 5, 6) and substituteEnvTokens (Property 9)
    - **Property 5: deepMerge immutability invariant** — neither input is mutated
    - **Validates: Requirements 4.3**
    - **Property 6: deepMerge correctness** — source keys override target, arrays replaced, undefined skipped, null replaces, nested objects recursively merged
    - **Validates: Requirements 4.1, 4.2, 4.4, 4.5**
    - **Property 9: Environment token substitution** — `$VAR_NAME` tokens replaced when env var exists, left unchanged otherwise
    - **Validates: Requirements 6.4**

- [x] 3. Checkpoint — Ensure all utility tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement configuration types and loader
  - [x] 4.1 Create `src/config/types.ts` — export `SkillConfig`, `AgentCardConfig`, `ServerConfig`, `SessionConfig`, `BaseFeatureFlags`, `TimeoutConfig`, `LoggingConfig`, `BaseMcpServerConfig`, and `BaseAgentConfig<TBackend>` generic interface
    - Unify the shared type definitions from both `a2a-copilot/src/config/types.ts` and `a2a-opencode/src/config/types.ts`
    - The `backend: TBackend` field replaces the project-specific `copilot`/`opencode` fields
    - Include CMMI Level 5 JSDoc on every interface, field, and type parameter
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
  - [x] 4.2 Create `src/config/loader.ts` — export `loadConfigFile<T>(filePath)` and `resolveConfig<T>(defaults, configFilePath?, envOverrides?, cliOverrides?)` using `deepMerge` from utils
    - Port from `a2a-copilot/src/config/loader.ts`, replacing the hardcoded `DEFAULTS` import with a generic `defaults` parameter
    - `resolveConfig` merges layers: defaults ← file ← env ← CLI
    - Throw descriptive errors with absolute file path on failure
    - _Requirements: 6.1, 6.2, 6.3, 6.5_
  - [x] 4.3 Write property tests for config loader (Properties 7, 8)
    - **Property 7: Config file round trip** — write JSON to temp file, `loadConfigFile` returns deeply equal object
    - **Validates: Requirements 6.1**
    - **Property 8: Config merge precedence** — CLI > env > file > defaults for any overlapping key
    - **Validates: Requirements 6.2**

- [x] 5. Implement event publisher
  - [x] 5.1 Create `src/events/event-publisher.ts` — export `publishStatus`, `publishFinalArtifact`, `publishStreamingChunk`, `publishLastChunkMarker`, `publishTraceArtifact`, `publishThoughtArtifact`
    - Port from `a2a-copilot/src/copilot/event-publisher.ts` with full JSDoc
    - All artifact IDs generated via UUID v4
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_
  - [x] 5.2 Write property tests for event publisher (Properties 13, 14)
    - **Property 13: Event publisher structure correctness** — each function produces events with correct `kind`, `append`, `lastChunk`, and part types
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6**
    - **Property 14: Artifact ID uniqueness** — N calls produce N unique artifact IDs
    - **Validates: Requirements 8.7**

- [x] 6. Implement server modules (agent card builder, server factory)
  - [x] 6.1 Create `src/server/agent-card.ts` — export `buildAgentCard(config)` that constructs an A2A `AgentCard` from `AgentCardConfig` + `ServerConfig`
    - Port from `a2a-copilot/src/server/agent-card.ts`, parameterize to accept `{ agentCard: AgentCardConfig; server: ServerConfig }` instead of full `AgentConfig`
    - Always set `stateTransitionHistory: false`
    - Map `SkillConfig` arrays including optional `examples`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - [x] 6.2 Write property tests for agent card builder (Properties 10, 11, 12)
    - **Property 10: Agent card construction from config** — URL, additionalInterfaces, name, description, capabilities match input
    - **Validates: Requirements 7.1, 7.2, 7.3**
    - **Property 11: stateTransitionHistory invariant** — always `false` regardless of input
    - **Validates: Requirements 7.4**
    - **Property 12: Skill mapping preserves data** — id, name, description, tags preserved; examples present iff non-empty in input
    - **Validates: Requirements 7.5**
  - [x] 6.3 Create `src/server/factory.ts` — export `ServerOptions`, `ServerHandle`, and `createA2AServer<T>(config, executorFactory, options?)` function
    - Port shared wiring from `a2a-copilot/src/server/index.ts` and `a2a-opencode/src/server/index.ts`
    - Accept `executorFactory` parameter to decouple from specific backends
    - Register standard routes: agent card (`.well-known/agent-card.json` + legacy), JSON-RPC, REST, health
    - Add A2A-Version response header middleware with configurable `protocolVersion` (default `"0.3"`)
    - Implement dynamic agent card URL rewriting from `Host` / `x-forwarded-proto` headers
    - Support `registerRoutes` hook for wrapper-specific custom routes
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_
  - [x] 6.4 Write property tests for server factory (Properties 15, 16)
    - **Property 15: A2A-Version header reflects configured protocol version** — all responses include correct `A2A-Version` header
    - **Validates: Requirements 9.3, 15.2**
    - **Property 16: Dynamic agent card URL rewriting** — agent card URLs use request's Host/proto, not static config
    - **Validates: Requirements 9.4**

- [x] 7. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement session manager and executor interface
  - [x] 8.1 Create `src/session/base-session-manager.ts` — export abstract `BaseSessionManager<TSession>` class and `SessionEntry<TSession>` interface
    - Implement `startCleanup()`, `stopCleanup()`, `trackTask()`, `getSessionForTask()`, `getContextForTask()`, `untrackTask()`, `shutdown()`
    - Abstract `getOrCreate(contextId)` for subclass implementation
    - Protected helpers: `getSessionEntry`, `setSessionEntry`, `deleteSessionEntry`
    - TTL-based cleanup removes expired sessions from context map
    - Idempotent `startCleanup` (no-op if timer already running)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_
  - [x] 8.2 Write property tests for BaseSessionManager (Properties 17, 18)
    - **Property 17: Session reuse within TTL** — `getOrCreate` twice within TTL returns same session; `lastUsed` updated
    - **Validates: Requirements 10.1, 10.5**
    - **Property 18: Task tracking round trip** — `trackTask` → `getSessionForTask`/`getContextForTask` returns correct values; `untrackTask` → both return `undefined`
    - **Validates: Requirements 10.3**
  - [x] 8.3 Create `src/executor/types.ts` — export `A2AExecutor` interface with `initialize()`, `shutdown()`, `execute()`, `cancelTask?()`, `getContextContent?()`, `buildContext?()`
    - Must be compatible with `@a2a-js/sdk/server` `AgentExecutor` / `TaskExecutor` type
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

- [x] 9. Implement CLI scaffold
  - [x] 9.1 Create `src/cli/scaffold.ts` — export `CliOptions<T>` interface and `createCli<T>(options)` function
    - Implement standard main-loop: parse args → resolve config → set log level → create server → register SIGINT/SIGTERM
    - Parse common flags: `--agent-json`/`--config`, `--port`, `--hostname`, `--advertise-host`, `--agent-name`, `--agent-description`, `--stream-artifacts`/`--no-stream-artifacts`, `--log-level`, `--help`, `--version`
    - Accept `extraArgDefs` for wrapper-specific flags and `parseBackendArgs` callback
    - Accept `loadEnvOverrides` callback for wrapper-specific env vars
    - `--help` prints usage and exits 0; `--version` prints version and exits 0
    - Fatal errors log with stack trace and exit 1
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_
  - [x] 9.2 Write property test for CLI scaffold (Property 19)
    - **Property 19: CLI common flag parsing** — random valid flag combinations produce correct typed config overrides (e.g. `--port "3001"` → `server.port === 3001`)
    - **Validates: Requirements 11.3**

- [x] 10. Create public API barrel export and type re-exports
  - [x] 10.1 Create `src/index.ts` — barrel export all public symbols from utils, config, events, server, session, executor, and cli modules
    - Re-export A2A SDK type aliases behind core-owned names for SDK upgrade isolation
    - Ensure every exported symbol has JSDoc
    - _Requirements: 13.1, 15.3_

- [x] 11. Checkpoint — Ensure all tests pass and `tsc --strict --noEmit` succeeds
  - Ensure all tests pass, ask the user if questions arise.
  - Run `tsc --strict --noEmit` to verify zero errors and zero warnings
  - _Requirements: 14.3_

- [x] 12. Create documentation files
  - [x] 12.1 Create `packages/core/README.md` with package overview, installation instructions, quick-start example showing how a wrapper project uses `createCli`, API reference summary listing all exported modules and key functions, and contribution guidelines
    - _Requirements: 14.4_
  - [x] 12.2 Create `packages/core/CHANGELOG.md` following Keep a Changelog format with an initial `[0.1.0]` entry documenting the extraction from a2a-copilot and a2a-opencode
    - _Requirements: 14.5_

- [x] 13. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (19 total)
- All code uses TypeScript with `strict: true` and CMMI Level 5 inline documentation
- The core package has zero runtime knowledge of any specific backend (CopilotConfig, OpenCodeConfig)
