# a2a-copilot

[![npm version](https://img.shields.io/npm/v/a2a-copilot.svg)](https://www.npmjs.com/package/a2a-copilot)
[![CI](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

GitHub Copilot is a production-grade agent. It already handles multi-step planning, MCP tool execution, context management, and streaming — everything you'd spend months rebuilding from scratch.

**a2a-copilot** exposes it as a standalone, interoperable agent via the [A2A protocol](https://github.com/google-deepmind/a2a). Drop a JSON config file in, get a fully spec-compliant A2A server out. Any orchestrator that speaks A2A can discover and call it — no Copilot-specific integration code required.

> **The pattern:** MCP is the vertical rail — how agents access tools. A2A is the horizontal rail — how agents talk to each other. This library adds the horizontal rail to GitHub Copilot.

**Features:**
- Full [A2A v0.3.0](https://github.com/google-deepmind/a2a) protocol — Agent Card, JSON-RPC, REST, SSE streaming
- Powered by GitHub Copilot (GPT-4.1, Claude Sonnet 4.5, and more)
- **Bring Your Own Model (BYOK)** — point at Ollama, OpenAI, Anthropic, Azure, vLLM, or any OpenAI-compatible endpoint. See [Bring Your Own Model (BYOK)](#bring-your-own-model-byok).
- MCP tool server support — HTTP and stdio transports
- Multi-turn conversations via persistent Copilot sessions
- JSON config file with layered overrides (JSON → env vars → CLI flags)
- Docker-ready with corporate proxy CA support
- TypeScript source with full type declarations

## Why not just embed the Copilot SDK directly?

Direct SDK embedding works — but it tightly couples your application to Copilot's session model and integration pattern. Swapping the AI backend means rewriting integration code. Adding a second agent means writing a second bespoke integration.

With the A2A protocol surface:
- Your orchestrator speaks one interface regardless of what's behind it
- Copilot becomes **swappable** — replace it without changing orchestration logic
- Copilot becomes **composable** — route tasks to it alongside other A2A agents
- Copilot becomes **discoverable** — any A2A-compatible system can find it via Agent Card

## Works with agent frameworks

This library complements — not replaces — frameworks like LangGraph, Google ADK, Microsoft Agent Framework, and CrewAI. Use those frameworks for orchestration, state, and memory control. Use a2a-copilot as the execution node they call.

```
LangGraph / ADK / Microsoft Agent Framework
        (state, memory, flow control)
                    ↓
              A2A Protocol
                    ↓
              a2a-copilot
           (GitHub Copilot execution)
```

## Quick Start

```bash
# Install globally
npm install -g a2a-copilot

# Run the bundled example agent
a2a-copilot --config agents/example/config.json
```

Or run without installing:

```bash
npx a2a-copilot --config agents/example/config.json
```

> **⚠️ Authentication required:** You must set a `GITHUB_TOKEN` environment variable **or** run `gh auth login` before starting the server. Without valid GitHub credentials the server will fail with an auth error. You also need a GitHub account with Copilot access.
>
> **Using your own model?** If you configure a custom provider (BYOK) — e.g. a local Ollama instance — GitHub credentials are not required for that provider. See [Bring Your Own Model (BYOK)](#bring-your-own-model-byok).

## Architecture

```
A2A Client (Orchestrator / Inspector / curl)
  │
  │  JSON-RPC or REST over HTTP
  ▼
Express Server  (a2a-copilot)
  │  ├─ /.well-known/agent-card.json  → Agent Card
  │  ├─ /a2a/jsonrpc                  → JSON-RPC  (message/send, message/sendSubscribe, …)
  │  ├─ /a2a/rest                     → REST handler
  │  ├─ /context                      → Read context.md
  │  ├─ /context/build                → Trigger context discovery
  │  └─ /health                       → Health check
  │
  │  @a2a-js/sdk  DefaultRequestHandler
  ▼
CopilotExecutor  (AgentExecutor)
  │  ├─ SessionManager  — contextId → Copilot session
  │  ├─ Streaming       — delta events → A2A artifact chunks
  │  └─ EventPublisher  — Copilot events → A2A events
  │
  │  @github/copilot-sdk
  ▼
GitHub Copilot
  │  ├─ LLM inference  (GPT-4.1, Claude Sonnet 4.5, …)
  │  └─ MCP tool execution
  │
  │  MCP Protocol  (HTTP / stdio)
  ▼
MCP Servers  (filesystem, custom tools, …)
```

## Installation

```bash
# npm
npm install a2a-copilot

# yarn
yarn add a2a-copilot

# pnpm
pnpm add a2a-copilot
```

## Usage

### CLI

```bash
a2a-copilot --config agents/example/config.json
```

Full flag reference:

```
a2a-copilot [options]

  --config <path>               JSON agent config file
  --port <number>               Server port                      (default: 3000)
  --hostname <addr>             Bind address                     (default: 0.0.0.0)
  --advertise-host <host>       Hostname for agent card URLs     (default: localhost)
  --cli-url <url>               External Copilot CLI URL         (default: auto)
  --model <model>               LLM model                        (default: gpt-4.1)
  --workspace <path>            Workspace directory
  --agent-name <name>           Agent display name
  --agent-description <desc>    Agent description
  --stream-artifacts            Stream chunks in real time (A2A spec mode)
  --no-stream-artifacts         Buffer artifacts — Inspector-compatible (default)
  --log-level <level>           debug | info | warn | error      (default: info)
  --help                        Show this help
  --version                     Show version
```

### Programmatic API

```typescript
import { createA2AServer, resolveConfig } from 'a2a-copilot';

const config = await resolveConfig({ configPath: 'agents/example/config.json' });
const { server, url } = await createA2AServer(config);

console.log(`Agent running at ${url}`);
```

## Configuration

Config is resolved in priority order: **defaults ← JSON file ← env vars ← CLI flags**

### JSON Config File

Create a `config.json` (see `agents/example/config.json` for the fully annotated template):

```json
{
  "agentCard": {
    "name": "My Agent",
    "description": "What my agent does",
    "version": "1.0.0",
    "protocolVersion": "0.3.0",
    "streaming": true,
    "skills": [
      {
        "id": "my-skill",
        "name": "My Skill",
        "description": "Describe the skill",
        "tags": ["example"]
      }
    ]
  },
  "server": {
    "port": 3000,
    "hostname": "0.0.0.0",
    "advertiseHost": "localhost"
  },
  "copilot": {
    "model": "gpt-4.1",
    "streaming": true,
    "systemPrompt": "You are a specialist agent that...",
    "contextFile": "context.md"
  },
  "mcp": {
    "my-tools": {
      "type": "http",
      "url": "http://localhost:8002/mcp"
    }
  },
  "events": {
    "enabled": true,
    "transport": "a2a"
  }
}
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `GITHUB_TOKEN` | GitHub PAT for headless auth | uses `gh` CLI |
| `PORT` | Server port | `3000` |
| `HOSTNAME` | Bind address | `0.0.0.0` |
| `ADVERTISE_HOST` | Hostname in agent card URLs | `localhost` |
| `COPILOT_MODEL` | LLM model | `gpt-4.1` |
| `COPILOT_CLI_URL` | External Copilot CLI URL | auto |
| `COPILOT_PROVIDER_BASE_URL` | BYOK provider endpoint (e.g. `http://localhost:11434/v1`) | _(unset → GitHub Copilot)_ |
| `COPILOT_PROVIDER_TYPE` | BYOK provider type: `openai`\|`azure`\|`anthropic` | `openai` |
| `COPILOT_PROVIDER_API_KEY` | BYOK API key (omit for local Ollama) | _(unset)_ |
| `COPILOT_PROVIDER_WIRE_API` | BYOK wire API: `completions`\|`responses` | `completions` |
| `WORKSPACE_DIR` | Workspace directory | _(empty)_ |
| `STREAM_ARTIFACTS` | Stream chunks in real time | `false` |
| `LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error` | `info` |
| `AGENT_NAME` | Override agent card name | _(from config)_ |
| `AGENT_DESCRIPTION` | Override agent card description | _(from config)_ |

See [`.env.example`](.env.example) for the full reference.

## Bring Your Own Model (BYOK)

By default the wrapper uses GitHub Copilot's hosted models. You can instead point it at **any OpenAI-compatible endpoint** — Ollama, OpenAI, Anthropic, Azure OpenAI, Azure AI Foundry, vLLM, LiteLLM, or Microsoft Foundry Local — using the `copilot.provider` config block. This is GitHub Copilot's BYOK ("Bring Your Own Key") capability, surfaced through the wrapper.

When `provider` is omitted, nothing changes: the wrapper uses GitHub Copilot exactly as before. When `provider` is set, sessions bypass GitHub Copilot and call your endpoint directly.

### Configuration

```json
{
  "copilot": {
    "model": "qwen3.6",
    "provider": {
      "type": "openai",
      "baseUrl": "http://localhost:11434/v1",
      "wireApi": "completions"
    }
  }
}
```

> **The `model` field is required when `provider` is set.** The runtime cannot auto-detect models from custom providers.

### Provider fields

| Field | Values | Notes |
|---|---|---|
| `type` | `openai` \| `azure` \| `anthropic` | Defaults to `openai`. Use `openai` for Ollama, vLLM, LiteLLM, Foundry. |
| `baseUrl` | string (required) | API endpoint. For Ollama: `http://localhost:11434/v1`. |
| `apiKey` | string | Optional. Not needed for local Ollama. |
| `bearerToken` | string | Sets the `Authorization` header directly. Takes precedence over `apiKey`. |
| `wireApi` | `completions` \| `responses` | Defaults to `completions`. See note below. |
| `azure.apiVersion` | string | Azure only. Defaults to `2024-10-21`. |

### Provider quick reference

| Provider | `type` | `baseUrl` | `wireApi` |
|---|---|---|---|
| Ollama (local) | `openai` | `http://localhost:11434/v1` | `completions` |
| OpenAI | `openai` | `https://api.openai.com/v1` | `responses` |
| Anthropic | `anthropic` | `https://api.anthropic.com` | _(n/a)_ |
| Azure OpenAI | `azure` | `https://<resource>.openai.azure.com` | `completions` |
| Azure AI Foundry | `openai` | `https://<resource>.openai.azure.com/openai/v1/` | `responses` |
| vLLM / LiteLLM | `openai` | `http://<host>:<port>/v1` | `completions` |

You can also configure everything with environment variables (the same vars the `gh copilot` CLI uses): `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_WIRE_API`, and `COPILOT_MODEL`.

### ⚠️ Model requirements (read this before using local models)

The wrapper drives an **agentic loop** through the Copilot runtime. That loop depends on the model supporting **native tool calling (function calling)** and **streaming**. Not every local model does, and a model that chats fine in isolation can still fail here.

Symptoms of an incompatible model:

- **Raw tool-call JSON as the response.** You ask "Who are you?" and get back `{"name":"view","arguments":{...}}` instead of an answer. This happens when the model emits tool calls as plain text instead of using the structured tool-call protocol — the runtime can't execute them, so the text leaks through as the final artifact. The wrapper detects this shape and replaces it with an actionable message, but the underlying cause is the model.
- **`400 ... does not support thinking`.** Seen with `wireApi: "responses"` against models that don't implement the reasoning parameter. Use `wireApi: "completions"` for local models.

Guidance:

- **Use a model with robust native tool-calling support.** Verified working locally: **`qwen3.6`**. Other strong options: `llama3.3`, `mistral-nemo`. Avoid small/older coder models like `qwen2.5-coder:7b` for agentic use — they tend to emit tool calls as text.
- **Prefer `wireApi: "completions"`** for Ollama and most local engines. Reserve `"responses"` for OpenAI GPT-4+ and Azure AI Foundry GPT-5-series.
- The model must support **streaming** (all the recommended models do).

See the [`agents/ollama/`](agents/ollama/) example for a working local setup.

## Bundled Agent Examples

### Example Agent (minimal)

```bash
./agents/example/start.sh start
./agents/example/start.sh status
./agents/example/start.sh logs
./agents/example/start.sh stop
```

Runs on port `3000`. No external tools. Good starting point for custom agents.

### Filesystem Assistant

```bash
./agents/filesystem-assistant/start.sh start
```

Runs on port `3000` and connects to the `@modelcontextprotocol/server-filesystem` MCP server. The agent can read, write, and search files inside its `workspace/` directory.

### Ollama Agent (local / BYOK)

```bash
# Pull a tool-capable model and start Ollama first
ollama pull qwen3.6
ollama serve

./agents/ollama/start.sh start
```

Runs on port `3002` entirely against a local Ollama instance — no GitHub Copilot account required. See the [Bring Your Own Model (BYOK)](#bring-your-own-model-byok) section for model requirements (the model must support native tool calling).

### Creating Your Own Agent

```bash
# Copy the example agent
cp -r agents/example agents/my-agent

# Edit the config
$EDITOR agents/my-agent/config.json

# Start it
./agents/my-agent/start.sh start
```

## MCP Tool Servers

### HTTP / SSE server

```json
"mcp": {
  "my-tools": {
    "type": "http",
    "url": "http://localhost:8002/mcp"
  }
}
```

### Authenticated remote servers (custom headers)

Many hosted MCP servers (Linear, Notion, remote GitHub MCP, etc.) require auth headers. Add a `headers` map to any `http` or `sse` server. Header values support `${ENV_VAR}` substitution so **secrets never live in `config.json`** — reference an environment variable and supply the value at runtime:

```json
"mcp": {
  "linear": {
    "type": "http",
    "url": "https://mcp.linear.app/mcp",
    "headers": {
      "Authorization": "Bearer ${LINEAR_API_KEY}"
    }
  },
  "notion": {
    "type": "sse",
    "url": "https://mcp.notion.com/sse",
    "headers": {
      "X-Api-Key": "${NOTION_TOKEN}"
    }
  }
}
```

Run with the secrets in the environment:

```bash
LINEAR_API_KEY=lin_xxx NOTION_TOKEN=ntn_yyy ./agents/my-agent/start.sh start
```

Unresolved tokens (no matching env var) are left as-is so misconfigurations stay visible rather than silently sending an empty header.

### stdio server (child process)

```json
"mcp": {
  "filesystem": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "$WORKSPACE_DIR"],
    "env": {
      "SOME_API_KEY": "${SOME_API_KEY}"
    }
  }
}
```

Both `args` and `env` values support env-var substitution — use `${VAR}` (recommended, works mid-string) or bare `$VAR`. This keeps tokens out of committed config while letting the spawned server receive them.

## Memory Persistence

Give your agent persistent instructions and skills that survive across sessions. Declare them in config.json and they're materialized into the workspace at startup — the Copilot LLM reads them automatically.

### Config

```json
{
  "memory": {
    "instructions": "./memory/instructions.md",
    "skills": ["./memory/skills/code-review"]
  }
}
```

Paths are relative to the directory containing config.json.

### Instructions

A markdown file with project-level instructions, coding conventions, safety rules, or behavioral guidelines. Written to `.github/copilot-instructions.md` in the workspace.

### Skills

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter and optional resource directories:

```
memory/skills/code-review/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Optional: helper scripts
├── references/           # Optional: reference docs
└── assets/               # Optional: static files
```

**SKILL.md format:**

```markdown
---
name: code-review
description: Provides code review guidelines and checklists
license: MIT
allowed-tools:
  - read_file
  - search_files
---

# Code Review Skill

Detailed instructions for the LLM...
```

The `name` field must be kebab-case (lowercase + hyphens, max 64 chars). It determines the output directory name under `.github/skills/`.

### Where files are written

| Source | Target in workspace |
|---|---|
| `memory.instructions` | `.github/copilot-instructions.md` |
| `memory.skills[]/SKILL.md` | `.github/skills/<name>/SKILL.md` |
| `memory.skills[]/scripts/` | `.github/skills/<name>/scripts/` |

### `agentCard.skills` vs `memory.skills`

These serve different purposes:

- **`agentCard.skills`** — External metadata for orchestrators. Advertised in the agent card for discovery and routing.
- **`memory.skills`** — Internal instructions for the LLM. Never exposed externally. Teaches the LLM *how* to perform tasks.

Both should be maintained — the agent card tells callers what the agent can do, while memory skills tell the LLM how to do it. Descriptions may differ: agent card skills are high-level and marketing-friendly, memory skills are technical and detailed.

### Example

See [`agents/filesystem-assistant/`](agents/filesystem-assistant/) for a working example with instructions, a skill, and a helper script.

## Calling Other A2A Agents

Expose remote A2A agents as MCP tools by declaring them under `subAgents` in your config. The wrapper spawns [`a2a-mcp-skillmap`](https://www.npmjs.com/package/a2a-mcp-skillmap) ([GitHub](https://github.com/shashikanth-gs/a2a-mcp-skillmap)) as a stdio MCP server and registers it under the reserved `a2a-subagents` key in the resolved `mcp` map. Each remote skill becomes a callable tool the Copilot LLM can dispatch like any other MCP tool.

```json
{
  "subAgents": {
    "agents": [
      {
        "name": "coding",
        "agentCardUrl": "https://coding.example.com/.well-known/agent-card.json",
        "auth": { "mode": "bearer", "token": "${CODING_AGENT_TOKEN}" }
      },
      {
        "name": "research",
        "agentCardUrl": "https://research.example.com/",
        "endpointUrlOverride": "https://research.internal.local/.well-known/agent-card.json"
      }
    ]
  }
}
```

The Copilot LLM sees `coding__<skillId>` and `research__<skillId>` tools (one per skill advertised in each sub-agent's card). Tokens may reference environment variables via `${VAR}` syntax — missing variables produce a startup warning and the auth block is omitted (the bridge calls without credentials).

When `subAgents` is absent or `agents` is empty, the wrapper skips every sub-agent code path with no side effects.

See [`agents/multi-agent/`](agents/multi-agent/) for a working example.

## Event Transport (Observability)

Agents emit structured trace events for MCP tool calls, reasoning, and lifecycle. By default, these flow as sideband artifacts through the A2A protocol itself — orchestrators discover them via the `urn:x-a2a:trace:v1` extension on the agent card.

### Default (A2A sideband)

No config needed. Trace artifacts appear alongside response artifacts and can be filtered by the `urn:x-a2a:trace:v1` extension URI.

### HTTP collector

Route events to an external telemetry endpoint:

```json
{
  "events": {
    "enabled": true,
    "transport": "http",
    "httpUrl": "https://telemetry.example.com/events",
    "httpHeaders": {
      "Authorization": "Bearer ${TELEMETRY_TOKEN}"
    }
  }
}
```

### Custom transport (programmatic)

For Kafka, Redis, or database sinks, use the programmatic API. See the [`@a2a-wrapper/core` README](https://www.npmjs.com/package/@a2a-wrapper/core) for full details.

## LLM Usage and Cost Telemetry

Every task execution tracks token counts, latency, model, and cost. Telemetry is delivered in three tiers:

| Tier | Always-on? | What you get |
|---|---|---|
| **Tier 1** | ✅ Always | `metadata["x-usage"]` on the final `completed` status event |
| **Tier 2** | `trackUsage: true` | One `trace.usage` sideband artifact per LLM API call |
| **Tier 3** | `trackUsage: true` | `contextWindow` fill snapshot inside `x-usage` |

### Enabling

Add `trackUsage: true` to your `features` block:

```json
{
  "features": {
    "trackUsage": true
  }
}
```

### Tier 1 — Session summary (always-on)

Every successfully completed task includes a `UsageTelemetryData` object under `metadata["x-usage"]` on the final status event — regardless of `trackUsage`. This gives you per-task totals with zero config.

```json
{
  "kind": "status-update",
  "final": true,
  "status": { "state": "completed", "timestamp": "..." },
  "metadata": {
    "x-usage": {
      "llmCalls": 1,
      "model": "gpt-5.4-mini",
      "inputTokens": 6226,
      "outputTokens": 34,
      "cacheReadTokens": 5632,
      "cacheWriteTokens": 0,
      "reasoningTokens": 27,
      "durationMs": 3140,
      "cost": 0.33,
      "calls": [{ "model": "gpt-5.4-mini", "inputTokens": 6226, ... }],
      "contextWindow": {
        "currentTokens": 6957,
        "tokenLimit": 272000,
        "conversationTokens": 85,
        "systemTokens": 194,
        "toolDefinitionsTokens": 6678,
        "messagesLength": 2
      }
    }
  }
}
```

`cost` is always present — `null` when no cost was reported by the provider, a finite number ≥ 0 otherwise (`0` is a valid Copilot-native quota value).

`contextWindow` is present when at least one `session.usage_info` event was received from the SDK. Absent (not `null`) otherwise.

### Tier 2 — Per-call trace artifacts (`trackUsage: true`)

When `trackUsage` is `true`, one `trace.usage` artifact is emitted per LLM API call, carrying the full `UsageCallRecord`:

```json
{
  "kind": "artifact-update",
  "artifact": {
    "name": "trace.usage",
    "parts": [{
      "kind": "data",
      "data": {
        "model": "gpt-5.4-mini",
        "inputTokens": 6226,
        "outputTokens": 34,
        "cacheReadTokens": 5632,
        "cacheWriteTokens": 0,
        "reasoningTokens": 27,
        "durationMs": 3140,
        "timeToFirstTokenMs": 2887,
        "cost": 0.33,
        "apiEndpoint": "/responses",
        "initiator": "user"
      }
    }]
  }
}
```

For tool-heavy tasks that make multiple LLM calls, you'll see one `trace.usage` artifact per call, giving you a complete per-call breakdown.

### Tier 3 — Context-window snapshots (`trackUsage: true`)

When `trackUsage` is `true`, the `contextWindow` field in `x-usage` reflects the most recent context-window snapshot from the SDK. This shows token fill by category (conversation, system prompt, tool definitions) and the model's total context limit.

### Field reference — `UsageTelemetryData`

| Field | Type | Description |
|---|---|---|
| `llmCalls` | `number` | Total number of LLM API calls in this task |
| `model` | `string \| null` | Model name from the last call; `null` if no calls |
| `inputTokens` | `number` | Sum of prompt tokens across all calls |
| `outputTokens` | `number` | Sum of completion tokens across all calls |
| `cacheReadTokens` | `number` | Sum of cache-hit tokens (prompt cache read) |
| `cacheWriteTokens` | `number` | Sum of cache-miss tokens (new cache entry) |
| `reasoningTokens` | `number` | Sum of internal reasoning tokens (o-series) |
| `durationMs` | `number` | Sum of call durations in milliseconds |
| `cost` | `number \| null` | Sum of provider-reported costs; `null` if none reported |
| `calls` | `UsageCallRecord[]` | Full per-call log in recording order |
| `contextWindow?` | `ContextWindowSnapshot` | Most recent context-window snapshot (optional) |

Field names align with [OpenTelemetry Generative AI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) for downstream observability interoperability.

## Docker

```bash
# Build
docker build -t a2a-copilot:latest .

# Run with a config file
docker run -p 3000:3000 \
  -e GITHUB_TOKEN=<your-token> \
  a2a-copilot:latest --config agents/example/config.json

# Mount a custom agent config
docker run -p 3000:3000 \
  -v /host/path/my-agent:/app/agents/my-agent \
  -e GITHUB_TOKEN=<your-token> \
  a2a-copilot:latest --config agents/my-agent/config.json
```

### Corporate Proxy (Netskope / Zscaler)

Mount your CA certificate into the container and the entrypoint injects it automatically:

```bash
docker run -p 3000:3000 \
  -v /path/to/corporate-ca.crt:/etc/ssl/certs/corporate-ca.crt:ro \
  -e GITHUB_TOKEN=<your-token> \
  a2a-copilot:latest --config agents/example/config.json
```

## A2A Protocol

Implements **A2A v0.3.0**:

| Endpoint | Description |
|---|---|
| `GET /.well-known/agent-card.json` | Agent identity and capabilities |
| `POST /a2a/jsonrpc` | JSON-RPC: `message/send`, `message/sendSubscribe` |
| `POST /a2a/rest` | REST equivalent |
| `GET /health` | Health check |
| `POST /context/build` | Trigger context discovery |
| `GET /context` | Read the built context file |

Example JSON-RPC request (`message/send`):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "Hello, agent!" }]
    }
  }
}
```

Streaming uses SSE for real-time status updates and artifact chunks. Set `--stream-artifacts` for spec-correct chunk streaming or leave it unset (default) for buffered output compatible with the [A2A Inspector](https://github.com/google-deepmind/a2a).

## External Copilot CLI

For debugging or sharing a single CLI instance across multiple agents:

```bash
# Start CLI in headless mode
copilot --headless --port 4321

# Point the wrapper at it
a2a-copilot --config agents/example/config.json --cli-url localhost:4321
```

## Known Issues

### Node 22 ESM compatibility

The `vscode-jsonrpc` package (a transitive dependency of `@github/copilot-sdk`) lacks an `exports` map in its `package.json`. Node 22's stricter ESM resolver rejects the `vscode-jsonrpc/node` subpath import, causing a startup crash.

A `postinstall` script is included that automatically patches `vscode-jsonrpc/package.json` to add the missing `exports` field. The patch runs on every `npm install` and is idempotent — it is a no-op on Node 18/20 or when the field already exists.

If you see `ERR_MODULE_NOT_FOUND` referencing `vscode-jsonrpc/node`, run `npm install` again to re-apply the patch.

## Related Packages

This package is part of the [a2a-wrapper](https://github.com/shashikanth-gs/a2a-wrapper) monorepo:

| Package | Description |
|---|---|
| [`@a2a-wrapper/core`](https://www.npmjs.com/package/@a2a-wrapper/core) | Shared infrastructure (logging, config, server, events, session, CLI) |
| [`a2a-opencode`](https://www.npmjs.com/package/a2a-opencode) | A2A wrapper for OpenCode |

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE) © Shashi Kanth
