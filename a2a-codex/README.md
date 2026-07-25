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
- Powered by `@openai/codex-sdk` — `o4-mini`, `o3`, `gpt-4o`, and any Codex-compatible model
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

If you have a ChatGPT Plus or Pro subscription and have already run `codex login` locally, the Codex CLI reads credentials from `~/.codex/auth.json` automatically — no `OPENAI_API_KEY` required. Specify a model that your subscription supports:

```bash
export WORKSPACE_DIR=/path/to/your/repo
export CODEX_MODEL=gpt-5.5
a2a-codex --config agents/example/config.json
```

The agent card is available at `http://localhost:3020/.well-known/agent-card.json`.

## Architecture

```
A2A Client (Orchestrator / Inspector / curl)
  │
  │  JSON-RPC or REST over HTTP
  ▼
Express Server  (a2a-codex)
  │  ├─ /.well-known/agent-card.json  → Agent Card
  │  ├─ /a2a/jsonrpc                  → JSON-RPC  (message/send, message/sendSubscribe, …)
  │  ├─ /a2a/rest                     → REST handler
  │  ├─ /context                      → Read context.md
  │  ├─ /context/build                → Trigger context discovery
  │  └─ /health                       → Health check
  ▼
CodexExecutor
  ├─ SessionManager  (contextId → Codex Thread)
  ├─ EventMapper     (ThreadEvent → A2A sideband events)
  └─ @openai/codex-sdk
       └─ Codex Thread (sandboxed repository operations)
```

## Required Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `WORKSPACE_DIR` | Yes* | Absolute path to the Git repository Codex will operate in |
| `CODEX_MODEL` | No | Override model (e.g. `o4-mini`, `o3`, `gpt-4o`) |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` (default: `info`) |
| `PORT` | No | A2A server port (default: from config, fallback `3020`) |
| `ADVERTISE_HOST` | No | Hostname embedded in agent card URLs (default: `localhost`) |
| `STREAM_ARTIFACTS` | No | Set `"true"` to stream artifact chunks (default: buffered) |

*Can also be set via `codex.workingDirectory` in `config.json` or the `--workspace` CLI flag.

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

> **Security note:** Never use `danger-full-access` outside a fully isolated environment. The executor logs a warning on startup if this mode is set.

### Approval policy

| Policy | Behaviour |
|---|---|
| `never` | Auto-approve all tool calls (default — required for headless A2A) |
| `on-failure` | Approve only when a command fails |
| `untrusted` | Approve tools from untrusted sources |
| `on-request` | **Not supported** — interactive approvals are incompatible with headless A2A execution |

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

## Cancellation

Call `tasks/cancel` (JSON-RPC) or `DELETE /a2a/rest/tasks/{taskId}` to cancel an in-flight task. The executor calls `abortController.abort()` on the Codex `runStreamed` call. Cancellation is idempotent — multiple calls for the same task ID are safe.

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
  --model <model>              Codex model                     (e.g. o4-mini, gpt-4o)
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

Or use the executor directly:

```typescript
import { CodexExecutor, resolveConfig } from "a2a-codex";

const config = resolveConfig("agents/example/config.json");
const executor = new CodexExecutor(config);
await executor.initialize();

// Build a context summary of the repository
const summary = await executor.buildContext();
console.log(summary);
```

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
- **One thread per A2A context.** Each A2A `contextId` maps to exactly one Codex thread. Turns within a context are serialized. Concurrent turns on the same context are queued, not parallelized.
- **Docker: shell sandboxing requires elevated privileges.** Codex wraps every shell command in `bwrap` (Bubblewrap), which creates Linux user namespaces. Standard Docker containers block unprivileged namespace creation, so shell tool calls fail inside a container unless you run with `--privileged` or `--security-opt=seccomp:unconfined`. For local development, running with `server.sh` directly (no Docker) is recommended.
- **ChatGPT subscription: OAuth tokens expire.** When using ChatGPT Plus/Pro authentication (via `codex login`), the tokens in `~/.codex/auth.json` are short-lived. When they expire the agent returns auth errors; re-run `codex login` on the host to refresh. For long-running or unattended deployments, `OPENAI_API_KEY` is more reliable.
- **ChatGPT subscription: model name is required.** The default model in `~/.codex/config.toml` (set by the desktop app) may differ from models available through the API. Always set `CODEX_MODEL` explicitly (e.g. `gpt-5.5`) when using subscription auth — leaving it unset causes the agent to fall back to the local default, which may be unsupported via the API endpoint.

## License

[MIT](LICENSE) © Shashi Kanth
