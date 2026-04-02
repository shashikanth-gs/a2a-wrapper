# a2a-opencode

[![npm version](https://img.shields.io/npm/v/a2a-opencode.svg)](https://www.npmjs.com/package/a2a-opencode)
[![CI](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

[OpenCode](https://opencode.ai) is a production-grade agent runtime that supports Anthropic, OpenAI, GitHub Copilot, and more. It already handles multi-step planning, MCP tool execution, and streaming across any provider you configure.

**a2a-opencode** exposes it as a standalone, interoperable agent via the [A2A protocol](https://github.com/google-deepmind/a2a). Drop a JSON config file in, get a fully spec-compliant A2A server out. Any orchestrator that speaks A2A can discover and call it — swap the LLM provider in one config line without changing orchestration code.

> **The pattern:** MCP is the vertical rail — how agents access tools. A2A is the horizontal rail — how agents talk to each other. This library adds the horizontal rail to OpenCode, making it vendor-neutral by default.

**Features:**
- Full [A2A v0.3.0](https://github.com/google-deepmind/a2a) protocol — Agent Card, JSON-RPC, REST, SSE streaming
- Powered by OpenCode with support for any LLM provider (Anthropic, OpenAI, GitHub Copilot, and more)
- MCP tool server support — HTTP, SSE, stdio, and OAuth transports
- Multi-turn conversations via persistent OpenCode sessions
- SSE event streaming with automatic reconnect and polling fallback
- Auto-approval of tool permissions with configurable overrides
- JSON config file with layered overrides (JSON → env vars → CLI flags)
- Docker-ready with corporate proxy CA support
- TypeScript source with full type declarations
- Postman collection included for API exploration

## Why not just integrate the LLM provider API directly?

Direct provider integrations work — but they create vendor lock-in at the integration layer. Switching from Claude to GPT-4.1 means rewriting SDK calls. Adding a second agent type means a second bespoke integration.

With the A2A protocol surface:
- Your orchestrator speaks one interface regardless of which provider is behind it
- Switch providers by changing **one line** in `config.json` — orchestration stays the same
- Run multiple specialized agents (different providers, different system prompts) behind a single protocol interface
- Any A2A-compatible system can discover and call your agent via Agent Card

## Works with agent frameworks

This library complements — not replaces — frameworks like LangGraph, Google ADK, Microsoft Agent Framework, and CrewAI. Use those frameworks for orchestration, state, and memory control. Use a2a-opencode as the execution node they call.

```
LangGraph / ADK / Microsoft Agent Framework
        (state, memory, flow control)
                    ↓
              A2A Protocol
                    ↓
             a2a-opencode
      (OpenCode + any LLM provider)
```

## Quick Start

```bash
# Install globally
npm install -g a2a-opencode

# Start OpenCode server (required — runs on port 4096 by default)
opencode serve

# In a separate terminal, run the bundled example agent
a2a-opencode --config agents/example/config.json
```

Or run without installing:

```bash
npx a2a-opencode --config agents/example/config.json
```

> **Prerequisites:** [OpenCode](https://opencode.ai) installed and running (`opencode serve`). The wrapper connects to it on `http://localhost:4096` by default.

## Tested With

| Component | Version |
|---|---|
| OpenCode server | **v1.3.0** |
| `@opencode-ai/sdk` | **1.3.0** |
| `@a2a-js/sdk` | **0.3.13** |
| A2A protocol | **v0.3.0** |
| Node.js | **>=18** |

> Other versions may work, but the above combination is what has been tested end-to-end.

## Architecture

```
A2A Client (Orchestrator / Inspector / curl)
  │
  │  JSON-RPC or REST over HTTP
  ▼
Express Server  (a2a-opencode)
  │  ├─ /.well-known/agent-card.json  → Agent Card
  │  ├─ /a2a/jsonrpc                  → JSON-RPC  (message/send, message/sendSubscribe, …)
  │  ├─ /a2a/rest                     → REST handler
  │  ├─ /context                      → Read context.md
  │  ├─ /context/build                → Trigger context discovery
  │  └─ /health                       → Health check
  │
  │  @a2a-js/sdk  DefaultRequestHandler
  ▼
OpenCodeExecutor  (AgentExecutor)
  │  ├─ SessionManager      — contextId → OpenCode session
  │  ├─ EventStreamManager  — SSE polling + automatic reconnect
  │  ├─ PermissionHandler   — auto-approves tool calls
  │  └─ EventPublisher      — OpenCode events → A2A events
  │
  │  @opencode-ai/sdk  (HTTP + SSE)
  ▼
OpenCode Server  (opencode serve)
  │  ├─ LLM inference  (Anthropic, OpenAI, GitHub Copilot, …)
  │  └─ MCP tool execution
  │
  │  MCP Protocol  (HTTP / SSE / stdio / OAuth)
  ▼
MCP Servers  (filesystem, custom tools, …)
```

## Installation

```bash
# npm
npm install a2a-opencode

# yarn
yarn add a2a-opencode

# pnpm
pnpm add a2a-opencode
```

## Usage

### CLI

```bash
a2a-opencode --config agents/example/config.json
```

Full flag reference:

```
a2a-opencode [options]

  --config, --agent-json <path>   JSON agent config file
  --port <number>                 Server port                      (default: 3000)
  --hostname <addr>               Bind address                     (default: 0.0.0.0)
  --advertise-host <host>         Hostname for agent card URLs     (default: localhost)
  --opencode-url <url>            OpenCode server URL              (default: http://localhost:4096)
  --model <provider/model>        LLM model                        (default: provider default)
                                  e.g. anthropic/claude-sonnet-4-20250514
  --agent <name>                  OpenCode agent preset
  --directory <path>              Project directory for OpenCode
  --agent-name <name>             Agent display name
  --agent-description <desc>      Agent description
  --auto-approve                  Auto-approve all tool permissions (default: on)
  --no-auto-approve               Require manual permission approval
  --auto-answer                   Auto-answer questions            (default: on)
  --no-auto-answer                Do not auto-answer questions
  --stream-artifacts              Stream chunks in real time (A2A spec mode)
  --no-stream-artifacts           Buffer artifacts — Inspector-compatible (default)
  --log-level <level>             debug | info | warn | error      (default: info)
  --help                          Show this help
  --version                       Show version
```

### Programmatic API

```typescript
import { createA2AServer, resolveConfig } from 'a2a-opencode';

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
  "opencode": {
    "baseUrl": "http://localhost:4096",
    "model": "anthropic/claude-sonnet-4-20250514",
    "systemPrompt": "You are a specialist agent that...",
    "contextFile": "context.md",
    "autoApprove": true,
    "autoAnswer": true
  },
  "mcp": {
    "my-tools": {
      "type": "remote",
      "url": "http://localhost:8002/mcp"
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `HOSTNAME` | Bind address | `0.0.0.0` |
| `ADVERTISE_HOST` | Hostname in agent card URLs | `localhost` |
| `OPENCODE_URL` | OpenCode server URL | `http://localhost:4096` |
| `MODEL` | LLM model (`provider/model`) | _(OpenCode default)_ |
| `OPENCODE_AGENT` | OpenCode agent preset | _(from config)_ |
| `DIRECTORY` | Project directory for OpenCode | _(empty)_ |
| `AUTO_APPROVE` | Auto-approve tool permissions | `true` |
| `AUTO_ANSWER` | Auto-answer questions | `true` |
| `STREAM_ARTIFACTS` | Stream chunks in real time | `false` |
| `LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error` | `info` |
| `AGENT_NAME` | Override agent card name | _(from config)_ |
| `AGENT_DESCRIPTION` | Override agent card description | _(from config)_ |

See [`.env.example`](.env.example) for the full reference.

## Bundled Agent Examples

### Example Agent (minimal)

```bash
./agents/example/start.sh start
./agents/example/start.sh status
./agents/example/start.sh logs
./agents/example/start.sh stop
./agents/example/start.sh foreground   # useful for debugging
```

Runs on port `3000`. No external tools. Good starting point for custom agents.

> The `start.sh` script manages both the OpenCode subprocess and the A2A wrapper.

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

### Local server (stdio child process)

```json
"mcp": {
  "filesystem": {
    "type": "local",
    "command": ["npx", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"],
    "enabled": true,
    "timeout": 10000
  }
}
```

### Remote server (HTTP / SSE)

```json
"mcp": {
  "my-tools": {
    "type": "remote",
    "url": "http://localhost:8002/mcp",
    "enabled": true
  }
}
```

### Remote server with OAuth

```json
"mcp": {
  "my-oauth-tools": {
    "type": "remote",
    "url": "https://api.example.com/mcp",
    "oauth": {
      "clientId": "...",
      "clientSecret": "...",
      "scope": "read write"
    }
  }
}
```

## Docker

```bash
# Build
docker build -t a2a-opencode:latest .

# Run (OpenCode must be accessible from within the container)
docker run -p 3000:3000 \
  a2a-opencode:latest --config agents/example/config.json

# Mount a custom agent config
docker run -p 3000:3000 \
  -v /host/path/my-agent:/app/agents/my-agent \
  a2a-opencode:latest --config agents/my-agent/config.json
```

### Corporate Proxy (Netskope / Zscaler)

Mount your CA certificate into the container and the entrypoint injects it automatically:

```bash
docker run -p 3000:3000 \
  -v /path/to/corporate-ca.crt:/etc/ssl/certs/corporate-ca.crt:ro \
  a2a-opencode:latest --config agents/example/config.json
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

Streaming uses SSE for real-time status updates and artifact chunks. Set `--stream-artifacts` for spec-correct chunk streaming or leave it unset (default) for buffered output compatible with the [A2A Inspector](https://github.com/google-deepmind/a2a).

## API Reference (Postman)

A full Postman collection covering all endpoints is included at [`docs/A2A-OpenCode-Wrapper.postman_collection.json`](docs/A2A-OpenCode-Wrapper.postman_collection.json). Import it into Postman and set the `baseUrl` variable to your running agent's URL.

## Context Building

```bash
# Trigger the LLM to discover available data and write context.md
curl -X POST http://localhost:3000/context/build

# Read the built context
curl http://localhost:3000/context
```

## Related Packages

This package is part of the [a2a-wrapper](https://github.com/shashikanth-gs/a2a-wrapper) monorepo:

| Package | Description |
|---|---|
| [`@a2a-wrapper/core`](https://www.npmjs.com/package/@a2a-wrapper/core) | Shared infrastructure (logging, config, server, events, session, CLI) |
| [`a2a-copilot`](https://www.npmjs.com/package/a2a-copilot) | A2A wrapper for GitHub Copilot |

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE) © Shashi Kanth
