# a2a-codex

[![npm version](https://img.shields.io/npm/v/a2a-codex.svg)](https://www.npmjs.com/package/a2a-codex)
[![CI](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

OpenAI Codex is a production-grade software engineering agent. It handles repository navigation, multi-step planning, shell command execution, file editing, and sandbox isolation — all the plumbing you'd spend months building from scratch.

**a2a-codex** exposes it as a standalone, interoperable agent via the [A2A protocol](https://github.com/google-deepmind/a2a). Drop a JSON config file in, get a fully spec-compliant A2A server out. Any orchestrator that speaks A2A can discover and call it — no Codex-specific integration code required.

> **The pattern:** MCP is the vertical rail — how agents access tools. A2A is the horizontal rail — how agents talk to each other. This library adds the horizontal rail to OpenAI Codex.

**Features:**
- Native [A2A v1.0](https://a2a-protocol.org) protocol, backward compatible with v0.3.x clients — Agent Card, JSON-RPC, REST, streaming
- Powered by `@openai/codex-sdk` — any model your account lists (`codex debug models`); default `auto`
- Repository sandboxing — `read-only`, `workspace-write`, `danger-full-access` modes
- MCP tool support — stdio and Streamable HTTP transports
- Multi-turn context continuity — each A2A `contextId` maps to a persistent Codex thread
- AbortController-based cancellation
- Multi-agent delegation via A2A sub-agents
- Sideband events — reasoning summaries, command events, file-change events
- JSON config file with layered overrides (JSON → env vars → CLI flags)
- Docker-ready with corporate proxy CA support
- TypeScript source with full type declarations

## Quick Start

**Option A — OpenAI API key:**

```bash
npm install -g a2a-codex

export OPENAI_API_KEY=sk-...
export WORKSPACE_DIR=/path/to/your/repo
a2a-codex --config agents/example/config.json
```

**Option B — ChatGPT subscription (no API key needed):**

If you have a ChatGPT Plus or Pro subscription and have already run `codex login` locally, the Codex CLI reads credentials from `~/.codex/auth.json` automatically — no `OPENAI_API_KEY` required. The model defaults to `auto`: the wrapper picks the first model Codex lists for your account (the same list as `codex debug models`), so a stale model pinned by the desktop app in `~/.codex/config.toml` is never used. To pin one yourself:

```bash
export WORKSPACE_DIR=/path/to/your/repo
export CODEX_MODEL=<a model from `codex debug models`>   # optional
a2a-codex --config agents/example/config.json
```

The agent card is available at `http://localhost:3020/.well-known/agent-card.json`.

## Release Channels

| Channel | Install | Cadence |
|---|---|---|
| Stable | `npm install a2a-codex` | Manually reviewed and approved — see [Release Process](https://github.com/shashikanth-gs/a2a-wrapper/blob/main/CONTRIBUTING.md#release-process) |
| Canary | `npm install a2a-codex@canary` | Every merge to `main` that passes CI |

Canary builds publish automatically after each merge, tagged like `a2a-codex@1.7.1-canary-20260812081117`. They're unreviewed and have no changelog entry — useful for trying a fix ahead of a stable release, not for production. `npm install a2a-codex` always resolves to the latest stable release regardless of how many canaries have shipped since.

## Architecture

```
A2A Client (Orchestrator / Inspector / curl)
  │
  │  JSON-RPC or REST over HTTP
  ▼
Express Server  (a2a-codex)
  │  ├─ /.well-known/agent-card.json  → Agent Card
  │  ├─ /a2a/jsonrpc                  → JSON-RPC  (message/send, message/stream, …)
  │  ├─ /a2a/rest                     → REST handler
  │  ├─ /context                      → Read context.md
  │  ├─ /context/build                → Trigger context discovery
  │  └─ /health                       → Health check
  ▼
@a2a-wrapper/core  (everything A2A: task lifecycle, cancel, queue, contextId → Codex thread binding)
  │  ProviderExecutor contract
  ▼
CodexProvider
  ├─ CodexTurn       (one turn: ThreadEvent → artifacts, trace events, usage)
  ├─ EventMapper     (ThreadEvent → A2A sideband events)
  └─ @openai/codex-sdk
       └─ Codex Thread (sandboxed repository operations; a rollout file on disk, resumable by id)
```

Core owns the A2A protocol and `@a2a-js/sdk`; this package only knows the Codex SDK and CLI.

## Required Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | No* | OpenAI API key; omit after authenticating with `codex login` |
| `WORKSPACE_DIR` | Yes* | Absolute path to the Git repository Codex will operate in |
| `CODEX_MODEL` | No** | Pin a model; default `auto` = first model your account lists (`codex debug models`) |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` (default: `info`) |
| `PORT` | No | A2A server port (default: from config, fallback `3020`) |
| `ADVERTISE_HOST` | No | Hostname embedded in agent card URLs (default: `localhost`) |
| `STREAM_ARTIFACTS` | No | Set `"true"` to stream artifact chunks (default: buffered) |

\* Authentication requires either `OPENAI_API_KEY` or credentials from `codex login`. `WORKSPACE_DIR` can instead be set via `codex.workingDirectory` or `--workspace`.

\** `auto` (also unset, empty or `default`) resolves at startup from `codex debug models`, falling back to Codex's model cache (`<CODEX_HOME>/models_cache.json`), then to Codex's own default if neither is available. The first listed model is the account's top-priority one, which may be the most capable and most expensive; pin a cheaper one if needed.

## Configuration Reference

All settings live in a single JSON config file. Priority order: **built-in defaults ← config file ← environment variables ← CLI flags**.

### Minimal config

```json
{
  "agentCard": {
    "name": "My Codex Agent",
    "description": "Repository-scoped software engineering agent"
  },
  "server": { "port": 3020 },
  "codex": {
    "workingDirectory": "${WORKSPACE_DIR}"
  }
}
```

### Full config reference

> `agentCard.protocolVersion` below is optional and kept only for backward
> compatibility with older config files — the server negotiates A2A v1.0 vs.
> v0.3.x automatically per request and no longer reads this field. See
> [Protocol Versions](../packages/core/README.md#protocol-versions) for how
> negotiation works.

```json
{
  "agentCard": {
    "name": "Codex Workspace Engineer",
    "description": "...",
    "version": "1.0.0",
    "protocolVersion": "0.3.0",
    "streaming": true,
    "defaultInputModes": ["text"],
    "defaultOutputModes": ["text"],
    "skills": [
      {
        "id": "workspace-engineering",
        "name": "Workspace Engineering",
        "description": "Inspect, modify, and validate code within the configured repository.",
        "tags": ["code", "repository", "tests", "refactoring"]
      }
    ]
  },

  "server": {
    "port": 3020,
    "hostname": "0.0.0.0",
    "advertiseHost": "localhost",
    "advertiseProtocol": "http"
  },

  "codex": {
    "workingDirectory": "${WORKSPACE_DIR}",
    "model": "${CODEX_MODEL}",
    "sandboxMode": "workspace-write",
    "approvalPolicy": "never",
    "networkAccessEnabled": false,
    "webSearchMode": "disabled",
    "skipGitRepoCheck": false,
    "additionalDirectories": [],
    "developerInstructions": "Operate only within the configured workspace.",
    "baseUrl": "https://api.openai.com/v1",
    "contextFile": "context.md",
    "contextPrompt": "Explore this repository…"
  },

  "session": {
    "reuseByContext": true,
    "ttl": 3600000,
    "idleTtl": 1800000,
    "cleanupInterval": 300000
  },

  "features": {
    "streamArtifactChunks": false,
    "emitReasoningSummaries": true,
    "emitCommandEvents": true,
    "emitFileChangeEvents": true
  },

  "timeouts": {
    "prompt": 600000
  },

  "logging": {
    "level": "info"
  }
}
```

### Sandbox modes

| Mode | File access | When to use |
|---|---|---|
| `read-only` | No writes | Code review, repository analysis |
| `workspace-write` | Writes within `workingDirectory` only (default) | General engineering tasks |
| `danger-full-access` | Unrestricted | Only inside an isolated container or VM |

> **Security note:** Never use `danger-full-access` outside a fully isolated environment. The wrapper logs a warning on startup if this mode is set.

### Approval policy

| Policy | Behaviour |
|---|---|
| `never` | Auto-approve all tool calls (default — required for headless A2A) |
| `on-failure` | Approve only when a command fails |
| `untrusted` | Approve tools from untrusted sources |
| `on-request` | **Not supported** — interactive approvals are incompatible with headless A2A execution |

**There are no approvals and no questions to answer.** a2a-codex drives Codex through the exec SDK (`@openai/codex-sdk`, one `codex exec` process per turn), which has no channel for asking a person: Codex runs with the approval policy above, and a tool call it cannot run unapproved fails inside Codex. So, unlike a2a-copilot, a2a-claude and a2a-opencode, there is no `interactions` config section and a task never goes to `input-required`. (For MCP tools that need approval under `never`, see `defaultToolsApprovalMode` in the MCP section.) Interactive approvals would need Codex's app-server protocol, which is experimental and not used here.

## AGENTS.md and `.agents/skills/`

Codex reads `AGENTS.md` in the workspace root for project-level instructions. Place agent configuration, coding standards, and tool usage rules there. The wrapper materializes memory-backed instructions to that path before each session.

Skills can be placed in `.agents/skills/<skill-name>/SKILL.md`. Configure them via the `memory` block in `config.json`.

```
your-repo/
├── AGENTS.md                          ← project instructions for Codex
└── .agents/
    └── skills/
        ├── security-audit/
        │   └── SKILL.md               ← skill instructions
        └── test-generation/
            └── SKILL.md
```

## MCP Support Matrix

| Transport | Supported | Notes |
|---|---|---|
| `stdio` | Yes | Spawns process at startup; args/env support `${VAR}` substitution |
| `http` (Streamable HTTP) | Yes | HTTP headers support `${VAR}` substitution for auth tokens |
| `sse` | **No** | SSE-only MCP servers are not supported; use `http` or `stdio` instead |

MCP configuration is baked at SDK construction time. All MCP servers must be declared in `config.json` before the agent starts — runtime registration is not possible.

```json
{
  "mcp": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${WORKSPACE_DIR}"]
    },
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" }
    }
  }
}
```

## Sub-Agent Delegation

Any `a2a-codex` agent can delegate to other A2A agents. Declare them under `subAgents` — the wrapper bootstraps [`a2a-mcp-skillmap`](https://www.npmjs.com/package/a2a-mcp-skillmap) as a stdio MCP server and makes each remote skill available as a Codex tool.

```json
{
  "subAgents": {
    "agents": [
      {
        "name": "security",
        "agentCardUrl": "http://localhost:3010/.well-known/agent-card.json"
      },
      {
        "name": "test-engineer",
        "agentCardUrl": "http://localhost:3011/.well-known/agent-card.json"
      }
    ],
    "options": {
      "responseMode": "artifact",
      "probeTimeoutMs": 5000,
      "syncBudgetMs": 30000
    }
  }
}
```

The Codex LLM sees `security__<skillId>` and `test-engineer__<skillId>` tools. MCP calls targeting the `a2a-subagents` server are enriched with `delegation: true` in sideband events for observability.

See `agents/multi-agent/config.json` for a bundled lead-engineer example.

## Sideband Event Mapping

A2A sideband events are emitted through `AgentEventEmitter` for every Codex `ThreadEvent`. Use them for observability, tracing, and orchestration.

| Codex event / item | A2A sideband event | Notes |
|---|---|---|
| `reasoning` item | `thinking` | Text summary only — raw reasoning never exposed |
| `command_execution` item | `tool_call_start` + `tool_call_end` | Output truncated at 10,000 chars; controlled by `emitCommandEvents` |
| `file_change` item | `decision` | Path and operation kind only — file contents never emitted; controlled by `emitFileChangeEvents` |
| `mcp_tool_call` → `a2a-subagents` | `tool_call_start` + `tool_call_end` | Enriched with `toolKind: "a2a_subagent"`, `delegation: true` |
| `mcp_tool_call` → other servers | `tool_call_start` + `tool_call_end` | Standard MCP tool call |
| `todo_list` item | `decision` | Codex's internal planning list |
| `web_search` item | `tool_call_start` | Web search metadata |
| `turn.completed` | Status `completed` | Includes token usage |
| `turn.failed` | Status `failed` | Sanitized error message |
| `error` | `agent_error` | Sanitized error message |

## Buffered vs Streaming Artifacts

By default, `a2a-codex` buffers the full response and publishes a single artifact at completion. This is compatible with the A2A Inspector and most orchestrators.

Set `features.streamArtifactChunks: true` (or `STREAM_ARTIFACTS=true`) to stream delta chunks as the model generates them. Use this only if your client handles `append: true` artifact updates correctly.

## Conversations and restarts

Messages that carry the same `contextId` continue the same Codex **thread**. The thread id (from the `thread.started` event, before any output) is bound to the `contextId` by core (`run.bind`) and the next message resumes it with the SDK's `resumeThread(id, options)`, so the model remembers earlier turns. The thread options (model, sandbox, approval policy, network, web search, additional directories) are per run and are passed on resume too. Turns of one context run one after the other (core's per-context lane); a message for a context that is busy waits for it.

A thread Codex no longer has (`codex exec resume` answers `no rollout found for thread id ...`, or the rollout file is gone) is not an error: core forgets the binding and runs the same turn once more on a fresh thread. This is reported only while the thread is being opened, before the turn publishes anything.

> **Resume after a restart needs a durable `RunStore`.** The default store is in memory, so with the defaults **nothing survives a restart**: the `contextId` to thread binding is gone and the next message starts a new Codex thread (the old one stays on disk under `$CODEX_HOME/sessions`, unused). Core ships only the in-memory store today; a durable one is tracked in #69. To keep conversations across restarts supply your own `RunStore` (see core's `RunStore` interface and its contract test suite):
>
> ```typescript
> import { createA2AServer, resolveConfig } from "a2a-codex";
> const handle = await createA2AServer(resolveConfig("agent.json"), { runStore: new MyDurableRunStore() });
> ```
>
> Tasks themselves are in memory either way (an in-flight task does not survive a restart; its thread, a file on disk, does).

- `session.reuseByContext: false` (or `session.ttl <= 0`) gives every task its own thread and binds nothing.
- `session.ttl` (default 1 hour) is the **maximum age** of a context's thread, as it always was: a context resumes its thread only while the thread is younger than `ttl`, however recently it was used; after that the next message starts a new thread.
- `session.idleTtl` (unset by default) is an optional **idle** expiry, measured from the last use of the context.
- `session.cleanupInterval` (default 5 minutes) is how often the wrapper forgets the bindings of contexts idle for longer than `ttl`. The threads stay on disk.
- Start-up validation (`validateBindingsOnStart` in core) can drop bindings whose thread is gone: the wrapper answers by looking for the thread's rollout file under `$CODEX_HOME/sessions` (`~/.codex/sessions`), and says "unknown" when that directory cannot be read.

## A message for a running task: queue and interrupt

Send a second message to a task that is still running and choose what it means with the message metadata `urn:a2a-wrapper:delivery:v1`:

| Delivery | What happens in a2a-codex |
|---|---|
| `queue` (default) | The message waits (in core) and runs as the next turn of the same task, on the same thread. |
| `steer` | **Not supported by the exec SDK**: the running `codex exec` process cannot be talked to. Core says so honestly (`queued`, reason `steer-unsupported`) and runs the message as the next turn, like `queue`. |
| `interrupt` | The running turn is aborted (the CLI process is killed), then the message runs next on the same thread. |

The caller gets one `Message` carrying the result under `urn:a2a-wrapper:delivery-result:v1`. The two turns of a task publish their answers as separate `response` artifacts (`response-<taskId>-<turn>`).

## Cancellation

Call `CancelTask` (v1 JSON-RPC) or `tasks/cancel` (v0.3 JSON-RPC) to cancel an in-flight task. For HTTP+JSON, use `POST /a2a/rest/tasks/{taskId}:cancel` with v1 or `POST /a2a/rest/v1/tasks/{taskId}:cancel` with v0.3. Core publishes `canceled` at once; the wrapper aborts the signal it passed to the Codex `runStreamed` call, which kills the CLI process of the turn. The thread stays on disk and takes the next message of the context. Cancellation is idempotent — multiple calls for the same task ID are safe.

## Context API

| Endpoint | Method | Description |
|---|---|---|
| `/context` | `GET` | Read the pre-built `context.md` from the workspace |
| `/context/build` | `POST` | Trigger a read-only Codex thread to explore and describe the repository; writes `context.md` |

POST body (optional): `{ "prompt": "Describe the API layer in detail." }`

## CLI Reference

```
Usage: a2a-codex [options]

Options:
  --agent-json <path>          Path to agent JSON config file  (alias: --config)
  --config <path>              Path to agent JSON config file  (alias: --agent-json)
  --port <number>              A2A server port                 (default: 3020)
  --hostname <addr>            Bind address                    (default: 0.0.0.0)
  --advertise-host <host>      Hostname for agent card URLs    (default: localhost)
  --workspace <path>           Workspace directory (Git repo)  (alias: --working-dir)
  --working-dir <path>         Workspace directory (Git repo)  (alias: --workspace)
  --model <model>              Codex model                     (default: auto = first model your account lists;
                                                                list them with: codex debug models)
  --sandbox <mode>             Sandbox mode                    (read-only | workspace-write | danger-full-access)
  --agent-name <name>          Agent display name
  --agent-description <desc>   Agent description
  --stream-artifacts           Stream artifact chunks (spec-correct, streaming clients)
  --no-stream-artifacts        Buffer artifacts — Inspector-compatible (default)
  --log-level <level>          Log level: debug | info | warn | error  (default: info)
  --help                       Show this help message
  --version                    Show version
```

## Bundled Example Agents

| Config | Port | Description |
|---|---|---|
| `agents/example/config.json` | 3020 | Workspace engineer — read + write access |
| `agents/read-only-reviewer/config.json` | 3022 | Code reviewer — read-only, no file writes |
| `agents/multi-agent/config.json` | 3021 | Lead engineer — delegates to sub-agents on ports 3010 and 3011 |

## Security Boundaries

```
OS / Container boundary
  │
  └─ Codex workspace boundary (sandboxMode)
       │
       └─ Individual MCP server permissions
```

1. **OS / container boundary** — The Docker image runs as a non-root `node` user. For `danger-full-access` mode, use an isolated container or VM with no access to host secrets.
2. **Codex workspace boundary** — `workspace-write` confines all file operations to `workingDirectory`. `read-only` prevents any writes. Both modes prevent access to directories outside the configured paths.
3. **MCP server permissions** — Each MCP server runs as a separate process (stdio) or connects to an external endpoint (http). Scope their permissions via the `args`, `env`, and `enabledTools` / `disabledTools` settings.
   In headless mode Codex cannot prompt, so MCP tools must be pre-approved or calls fail with `MCP tool call requires approval, but approval policy is never`. Set `defaultToolsApprovalMode: "approve"` on the server (or `toolApprovalModes: { "tool": "approve" }` per tool); values: `auto`, `prompt`, `writes`, `approve`. The `subAgents` bridge is pre-approved automatically.

## Docker

Build from the **monorepo root** (the image needs local `@a2a-wrapper/core` source):

```bash
docker build -f a2a-codex/Dockerfile -t a2a-codex:latest .
```

**Option A — OpenAI API key (recommended for CI / cloud):**

```bash
docker run -p 3020:3020 \
  -e OPENAI_API_KEY=sk-... \
  -e WORKSPACE_DIR=/workspace \
  -v /host/path/to/repo:/workspace \
  a2a-codex:latest
```

**Option B — ChatGPT subscription (mount local credentials):**

```bash
docker run -p 3020:3020 \
  -e WORKSPACE_DIR=/workspace \
  -e CODEX_MODEL=gpt-5.5 \
  -v ~/.codex:/home/node/.codex \
  -v /host/path/to/repo:/workspace \
  a2a-codex:latest
```

The container runs as the `node` user (`HOME=/home/node`), so `~/.codex` maps to `/home/node/.codex`. Mount read-write (not `:ro`) because the Codex CLI writes session state alongside auth tokens.

**Shell sandboxing in Docker:** Codex isolates every shell command it runs using Linux user namespaces via `bwrap` (Bubblewrap). Standard Docker containers disable unprivileged namespaces, so shell tool calls fail unless you add `--privileged` or `--security-opt=seccomp:unconfined`. For local development with a ChatGPT subscription, using `server.sh` directly (without Docker) avoids this constraint entirely.

To inject a corporate proxy CA certificate, mount it at `/etc/ssl/certs/corporate-ca.crt` — the entrypoint script merges it with the system CA bundle automatically.

## Programmatic API

```typescript
import { createA2AServer, resolveConfig } from "a2a-codex";

const config = resolveConfig("agents/example/config.json");
const handle = await createA2AServer(config);

// Graceful shutdown
process.on("SIGTERM", () => handle.shutdown());
```

`createA2AServer(config, options?)` takes `{ runStore?, eventTransport? }` and returns `{ provider, registry, executor, server, app, shutdown }`: `provider` is the `CodexProvider` (a `ProviderExecutor` of `@a2a-wrapper/core`), `registry` core's run runtime.

```typescript
// Build a context summary of the repository
const summary = await handle.provider.buildContext();
console.log(summary);
```

### Breaking changes (major release) and migration

`CodexProvider` implements `@a2a-wrapper/core`'s `ProviderExecutor`; a2a-codex no longer depends on `@a2a-js/sdk` (only core does).

- **`CodexExecutor` and `SessionManager` are removed** (also from `a2a-codex/codex`), with no shim. Use `CodexProvider` (a `ProviderExecutor`: `run`, `abort`, `abortOrphan`, `release`, `probeSession`) behind core's run runtime. It is not an SDK `AgentExecutor`: there is no `execute(ctx, bus)` or `cancelTask`; cancel and queueing go through the A2A endpoints (or core's `RunRegistry`).
- **`createA2AServer(config, options?)`** now takes `{ runStore?, eventTransport? }` and returns a `ProviderServerHandle` (`provider`, `registry`, `executor`, `server`, `app`, `shutdown`): `executor` is core's executor (it used to be the `CodexExecutor`). Use `handle.provider.buildContext()` where you used `executor.buildContext()`. Custom event transports are passed as `{ eventTransport }` (it used to be set on `executor.customTransport`).
- **Codex threads are resumed.** Before, a context kept its thread only in memory and `resumeThread` was never called (#100); now the thread id is bound to the `contextId` and resumed (with a durable `RunStore`, also across restarts: see "Conversations and restarts").
- `session.ttl` keeps its meaning (maximum age of a context's thread); `session.idleTtl` is new and optional.
- **`x-usage` is what the task spent.** Codex reports `turn.completed.usage` as a running total of the whole thread; the old executor published that total as every task's usage (so it grew with each turn of a conversation). Core now diffs the readings per thread, and keeps the previous reading with the context binding (also across restarts with a durable store). A resumed thread whose previous reading was lost reports no tokens for that one task, then is exact.

## Live Smoke Test

```bash
# Start an agent with a test repository
export OPENAI_API_KEY=sk-...
export WORKSPACE_DIR=/tmp/test-repo
git init /tmp/test-repo
echo "console.log('hello')" > /tmp/test-repo/index.js

node dist/cli.js --config agents/read-only-reviewer/config.json &
SERVER_PID=$!

# Wait for startup
sleep 3

# Fetch agent card
curl -s http://localhost:3022/.well-known/agent-card.json | jq .name

# Send a task
curl -s -X POST http://localhost:3022/a2a/jsonrpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","messageId":"test-1","role":"user","parts":[{"kind":"text","text":"What does this repository do?"}],"contextId":"ctx-1"}}}' \
  | jq .

kill $SERVER_PID
```

Set `RUN_CODEX_INTEGRATION_TESTS=true` to include the live integration test in `npm test`.

## Known Limitations

- **SSE-only MCP not supported.** MCP servers that only expose an SSE transport cannot be used. Use `stdio` or Streamable HTTP (`type: "http"`) instead.
- **Interactive approvals not supported.** `approvalPolicy: "on-request"` is rejected at startup. Headless A2A execution cannot present approval prompts to a human. Use `"never"` (default) for automated operation.
- **Buffered mode is the safe default.** `streamArtifactChunks: false` is the default. Some A2A clients (including the A2A Inspector) work best with complete, non-appending artifacts. Enable streaming only if your client handles `append: true` artifact updates.
- **MCP config is baked at startup.** MCP servers are registered with the Codex SDK at construction time. Runtime MCP registration is not possible — all servers must be declared in `config.json` before the agent starts.
- **One thread per A2A context.** Each A2A `contextId` maps to exactly one Codex thread (resumed by id, also after a restart when the run store is durable). Turns within a context are serialized by core's lane. Concurrent turns on the same context are queued, not parallelized.
- **No steering, no approvals.** The exec SDK cannot talk to a running turn and cannot ask a person: `steer` is answered by core with an honest `queued` (`steer-unsupported`) and `interrupt` aborts the turn; there is no `interactions` section and no `input-required`. Both would need Codex's experimental app-server protocol, which this wrapper does not use.
- **`timeouts.prompt` is not applied** (it never was for Codex): a turn runs until Codex ends it or the task is canceled.
- In `streamArtifactChunks` mode the stored task holds the response text twice (the chunks, then the last-chunk marker with the full text, both appended). This is the behaviour of earlier releases and is kept.
- **Docker: shell sandboxing requires elevated privileges.** Codex wraps every shell command in `bwrap` (Bubblewrap), which creates Linux user namespaces. Standard Docker containers block unprivileged namespace creation, so shell tool calls fail inside a container unless you run with `--privileged` or `--security-opt=seccomp:unconfined`. For local development, running with `server.sh` directly (no Docker) is recommended.
- **ChatGPT subscription: OAuth tokens expire.** When using ChatGPT Plus/Pro authentication (via `codex login`), the tokens in `~/.codex/auth.json` are short-lived. When they expire the agent returns auth errors; re-run `codex login` on the host to refresh. For long-running or unattended deployments, `OPENAI_API_KEY` is more reliable.
- **ChatGPT subscription: model.** The default `auto` picks a model your account lists, so the desktop app's default in `~/.codex/config.toml` is ignored. A model you pin yourself must be in `codex debug models`; Codex rejects others with "model not supported when using Codex with a ChatGPT account".

## License

[MIT](LICENSE) © Shashi Kanth
