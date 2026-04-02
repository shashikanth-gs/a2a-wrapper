# @a2a-wrapper/core

Shared infrastructure core for [A2A protocol](https://github.com/google/A2A) wrapper projects. Provides logging, configuration loading, event publishing, agent card building, server bootstrapping, session management, and CLI scaffolding — so each wrapper only needs to implement its backend-specific executor.

## Installation

```bash
npm install @a2a-wrapper/core
```

Peer dependencies (your wrapper project must install these):

```bash
npm install @a2a-js/sdk express uuid
```

## Quick Start

A minimal wrapper project using `createCli`:

```typescript
import {
  createCli,
  type BaseAgentConfig,
  type A2AExecutor,
} from "@a2a-wrapper/core";

// 1. Define your backend-specific config
interface MyBackendConfig {
  apiUrl: string;
}
type MyConfig = BaseAgentConfig<MyBackendConfig>;

// 2. Implement the executor interface
class MyExecutor implements A2AExecutor {
  constructor(private config: Required<MyConfig>) {}
  async initialize() { /* connect to backend */ }
  async shutdown() { /* cleanup */ }
  async execute(context: any, event: any) { /* handle A2A tasks */ }
}

// 3. Wire it up with createCli
createCli<MyConfig>({
  packageName: "my-a2a-wrapper",
  version: "1.0.0",
  defaults: { /* full default config */ } as Required<MyConfig>,
  usage: "Usage: my-a2a-wrapper [options]",
  executorFactory: (config) => new MyExecutor(config),
  parseBackendArgs: (values) => ({
    backend: { apiUrl: values["api-url"] as string },
  }),
  loadEnvOverrides: () => ({
    backend: { apiUrl: process.env.MY_API_URL },
  }),
  extraArgDefs: {
    "api-url": { type: "string" },
  },
});
```

Run it:

```bash
node dist/cli.js --port 3000 --log-level debug --api-url http://localhost:8080
```

## API Reference

All public symbols are exported from the package root (`@a2a-wrapper/core`). Imports from internal module paths are not supported.

### Utils

| Export | Description |
|---|---|
| `createLogger(rootName)` | Factory that returns a new `Logger` instance with the given root name. |
| `Logger` | Structured logger with `debug`, `info`, `warn`, `error` methods and `child(name)` for hierarchical naming. |
| `LogLevel` | Enum — `DEBUG`, `INFO`, `WARN`, `ERROR`. |
| `createDeferred<T>()` | Returns a `Deferred<T>` with externally-resolvable `promise`, `resolve`, and `reject`. |
| `sleep(ms)` | Returns a Promise that resolves after `ms` milliseconds. |
| `deepMerge(target, source)` | Recursively merges objects. Arrays are replaced, inputs are not mutated. |
| `substituteEnvTokens(args)` | Replaces `$VAR_NAME` tokens in string arrays with matching env var values. |

### Config

| Export | Description |
|---|---|
| `BaseAgentConfig<TBackend>` | Generic config interface — includes `agentCard`, `server`, `session`, `logging`, `timeouts`, and `backend: TBackend`. |
| `AgentCardConfig` | Agent card fields (name, description, skills, capabilities). |
| `ServerConfig` | Server fields (port, hostname, advertiseHost, advertiseProtocol). |
| `SessionConfig` | Session fields (reuseByContext, ttlMs, cleanupIntervalMs). |
| `BaseFeatureFlags` | Shared feature flags (`streamArtifactChunks`). |
| `TimeoutConfig` | Timeout settings. |
| `LoggingConfig` | Logging settings (level). |
| `BaseMcpServerConfig` | Common MCP server config pattern. |
| `SkillConfig` | Skill definition (id, name, description, tags, examples). |
| `loadConfigFile<T>(filePath)` | Reads and parses a JSON config file. Throws descriptive errors on failure. |
| `resolveConfig<T>(defaults, configFilePath?, envOverrides?, cliOverrides?)` | Merges config layers: defaults ← file ← env ← CLI. |

### Events

| Export | Description |
|---|---|
| `publishStatus(bus, taskId, contextId, state, messageText?, final?)` | Publishes a `TaskStatusUpdateEvent`. |
| `publishFinalArtifact(bus, taskId, contextId, text)` | Publishes a complete artifact (`lastChunk: true`). |
| `publishStreamingChunk(bus, taskId, contextId, artifactId, chunkText)` | Publishes an appending artifact chunk. |
| `publishLastChunkMarker(bus, taskId, contextId, artifactId, fullText)` | Publishes the final streaming chunk. |
| `publishTraceArtifact(bus, taskId, contextId, traceKey, data)` | Publishes a structured `DataPart` trace artifact. |
| `publishThoughtArtifact(bus, taskId, contextId, traceKey, text)` | Publishes a `TextPart` trace artifact. |

### Server

| Export | Description |
|---|---|
| `buildAgentCard(config)` | Constructs an A2A `AgentCard` from `AgentCardConfig` + `ServerConfig`. |
| `createA2AServer<T>(config, executorFactory, options?)` | Creates an Express app with standard A2A routes and starts listening. Returns a `ServerHandle`. |
| `ServerOptions` | Options for protocol version, custom route hooks. |
| `ServerHandle` | Returned by `createA2AServer` — contains `app`, `server`, `executor`, `shutdown()`. |

### Session

| Export | Description |
|---|---|
| `BaseSessionManager<TSession>` | Abstract class managing contextId → session mapping with TTL cleanup and task tracking. Subclass and implement `getOrCreate(contextId)`. |
| `SessionEntry<TSession>` | Interface for session entries with `session` and `lastUsed` fields. |

### Executor

| Export | Description |
|---|---|
| `A2AExecutor` | Interface contract for backend executors — `initialize()`, `shutdown()`, `execute()`, and optional `cancelTask()`, `getContextContent()`, `buildContext()`. |

### CLI

| Export | Description |
|---|---|
| `createCli<T>(options)` | Main entry point for wrapper CLIs. Handles arg parsing, config resolution, server creation, and graceful shutdown. |
| `CliOptions<T>` | Configuration for `createCli` — package name, version, defaults, usage, executor factory, arg definitions. |
| `parseCommonArgs<T>(argv, extraArgDefs?)` | Parses common CLI flags (`--port`, `--hostname`, `--log-level`, etc.) into typed config overrides. |
| `CommonArgsResult<T>` | Result of `parseCommonArgs` — config path and partial overrides. |

### A2A SDK Re-exports

| Export | Source |
|---|---|
| `AgentCard` | `@a2a-js/sdk` |
| `TaskState`, `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent` | `@a2a-js/sdk` |
| `ExecutionEventBus`, `RequestContext` | `@a2a-js/sdk/server` |

These re-exports isolate wrapper projects from direct SDK imports, so a major SDK upgrade only requires changes in `@a2a-wrapper/core`.

## Contributing

### Prerequisites

- Node.js ≥ 18
- npm

### Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type-check without emitting
npm run typecheck

# Clean build output
npm run clean
```

### Code Standards

- TypeScript with `strict: true`
- JSDoc on every exported symbol
- Property-based tests (fast-check) alongside unit tests (vitest)
- Follow [Keep a Changelog](https://keepachangelog.com/) for CHANGELOG.md

## License

MIT
