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
| `EventsConfig` | Event transport config — `enabled`, `transport`, `httpUrl`, `httpTimeout`, `httpHeaders`. |
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

### Event Transport

Pluggable transport layer for sideband observability events (MCP tool calls, agent reasoning, lifecycle). Decouples event emission from A2A protocol internals so you can route trace data to any backend.

| Export | Description |
|---|---|
| `A2ATransport` | Default transport — publishes trace artifacts on the A2A `ExecutionEventBus`. Zero dependencies. |
| `HttpTransport` | POST events as JSON to a configurable HTTP endpoint. Supports custom headers for auth. |
| `AgentEventEmitter` | Per-execution emitter that stamps events with agent identity, trace context, UUID, and timestamp. |
| `resolveTransport(cfg, bus, taskId, contextId, custom?)` | Resolve the correct transport for a single task execution. |
| `createTransport(cfg)` | Create a built-in transport from JSON config. |
| `wrapTransport(transport)` | Normalize a function or object into an `EventTransport`. |
| `EventTransport` | Interface — implement `send(event)` for custom transports. |
| `EventTransportFn` | Convenience type — a plain `async (event) => void` function. |
| `AgentEvent` | Structured event with `eventId`, `eventType`, `agentId`, `traceId`, `data`. |
| `EventType` | Union: `tool_call_start`, `tool_call_end`, `thinking`, `decision`, `agent_started`, `agent_finished`, `agent_error`. |
| `TRACE_EXTENSION_URI` | Constant `"urn:x-a2a:trace:v1"` — declared in agent card capabilities and on trace artifacts. |
| `EventsConfig` | Config interface — `enabled`, `transport` (`"a2a"` or `"http"`), `httpUrl`, `httpTimeout`, `httpHeaders`. |

#### Built-in transports

| Transport | Config value | Description |
|---|---|---|
| A2A sideband | `"a2a"` (default) | Publishes trace artifacts on the `ExecutionEventBus`. Orchestrators discover them via the `urn:x-a2a:trace:v1` extension. |
| HTTP collector | `"http"` | POSTs each event as JSON to `httpUrl`. Supports `httpHeaders` for Bearer tokens / API keys. |

#### JSON config

```json
{
  "events": {
    "enabled": true,
    "transport": "http",
    "httpUrl": "https://telemetry.example.com/events",
    "httpTimeout": 5000,
    "httpHeaders": {
      "Authorization": "Bearer ${TELEMETRY_TOKEN}"
    }
  }
}
```

#### Custom transport (programmatic API)

For Kafka, Redis, databases, or any custom sink — pass a transport function to `createA2AServer()`:

```typescript
import { createA2AServer } from "@a2a-wrapper/core";

const handle = await createA2AServer(config, executorFactory, {
  eventTransport: async (event) => {
    await kafkaProducer.send({
      topic: "agent-traces",
      messages: [{ value: JSON.stringify(event) }],
    });
  },
});
```

Or implement the `EventTransport` interface for full control:

```typescript
import type { EventTransport, AgentEvent } from "@a2a-wrapper/core";

class MyTransport implements EventTransport {
  async send(event: AgentEvent): Promise<void> {
    await db.insert("events", {
      id: event.eventId,
      type: event.eventType,
      agent: event.agentId,
      trace: event.traceId,
      data: event.data,
      ts: event.timestamp,
    });
  }
}
```

#### Using the emitter inside an executor

```typescript
import { resolveTransport, AgentEventEmitter } from "@a2a-wrapper/core";

// Inside your executor's execute() method:
const transport = resolveTransport(config.events, bus, taskId, contextId);
const emitter = new AgentEventEmitter({
  agentId: "my-agent",
  agentName: "My Agent",
  traceId: ctx.contextId,
  transport,
});

// Emit events — they flow through the resolved transport
await emitter.emit("tool_call_start", { toolName: "read_file", arguments: { path: "/data.json" } });
await emitter.emit("tool_call_end", { toolName: "read_file", result: "...", durationMs: 42 });
await emitter.emit("thinking", { content: "The data shows a spike in CPU usage..." });
```

### Server

| Export | Description |
|---|---|
| `buildAgentCard(config)` | Constructs an A2A `AgentCard` from `AgentCardConfig` + `ServerConfig`. |
| `createA2AServer<T>(config, executorFactory, options?)` | Creates an Express app with standard A2A routes and starts listening. Returns a `ServerHandle`. |
| `ServerOptions` | Options for protocol version, custom route hooks, and custom `eventTransport`. |
| `ServerHandle` | Returned by `createA2AServer` — contains `app`, `server`, `executor`, `eventTransport`, `shutdown()`. |

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

### Memory Persistence

Materialize instructions and skills into the agent's workspace at startup. The LLM reads these files as part of its context, giving it persistent knowledge across sessions.

| Export | Description |
|---|---|
| `materializeMemory(options)` | Main entry point — reads source files, validates manifests, writes to workspace. |
| `parseSkillManifest(content)` | Parse a SKILL.md file into frontmatter + body. |
| `formatSkillManifest(frontmatter, body)` | Serialize frontmatter + body back to SKILL.md format. |
| `validateSkillManifest(manifest)` | Validate name (kebab-case, ≤64 chars) and description. Returns `null` if valid. |
| `resolveMemoryPath(inputPath, configDir)` | Resolve relative/absolute paths against the config directory. |
| `WELL_KNOWN_PATHS` | Pre-defined backend path mappings (copilot, claude, opencode, codex). |
| `MemoryConfig` | Type — `{ instructions?: string; skills?: string[] }` |
| `SkillManifest` | Type — parsed SKILL.md frontmatter (name, description, license, compatibility, allowedTools). |
| `ParsedSkill` | Type — result of parsing: `{ manifest, body, rawFrontmatter }`. |
| `BackendPaths` | Type — `{ instructionsPath: string; skillsBaseDir: string }`. |
| `MaterializeOptions` | Type — input to `materializeMemory()`. |

#### Config example

```json
{
  "memory": {
    "instructions": "./memory/instructions.md",
    "skills": ["./memory/skills/code-review", "./memory/skills/testing"]
  }
}
```

#### SKILL.md format

```markdown
---
name: code-review
description: Provides code review guidelines and checklists
license: MIT
compatibility:
  - copilot
  - opencode
allowed-tools:
  - read_file
  - search_files
---

# Code Review Skill

Instructions for the LLM on how to perform code reviews...
```

#### Skill directory structure

```
memory/skills/code-review/
├── SKILL.md              # Required: manifest + instructions
├── scripts/              # Optional: executable scripts
├── references/           # Optional: reference documents
└── assets/               # Optional: static assets
```

#### Backend path mapping

| Backend | Instructions path | Skills base dir |
|---|---|---|
| Copilot | `.github/copilot-instructions.md` | `.github/skills/` |
| Claude | `CLAUDE.md` | `.claude/skills/` |
| OpenCode | `.opencode/instructions.md` | `.opencode/skills/` |
| Codex | `.codex/instructions.md` | `.agents/skills/` |

#### Usage in an executor

```typescript
import { materializeMemory, WELL_KNOWN_PATHS } from "@a2a-wrapper/core";

// In executor.initialize():
if (config.memory && workspaceDir) {
  await materializeMemory({
    memoryConfig: config.memory,
    configDir: config.configDir ?? process.cwd(),
    workspaceDir,
    paths: WELL_KNOWN_PATHS.copilot, // or .claude, .opencode, .codex
  });
}
```

#### Note on `agentCard.skills` vs `memory.skills`

These are different concepts:

- **`agentCard.skills`** — A2A protocol metadata advertised to orchestrators and callers. External-facing. Describes what the agent *can do* at a high level for discovery and routing.
- **`memory.skills`** — Internal instructions materialized into the workspace for the LLM. Never exposed externally. Tells the LLM *how* to do things — patterns, guidelines, tool usage rules.

Keep both in sync manually. You may want different descriptions: the agent card skill is marketing-friendly for orchestrators, while the memory skill is technical and detailed for the LLM.

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
