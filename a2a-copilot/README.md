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

> **Prerequisites:** A GitHub account with Copilot access and either the [`gh` CLI](https://cli.github.com/) authenticated (`gh auth login`) or a `GITHUB_TOKEN` environment variable set.

## Architecture

```
A2A Client (Orchestrator / Inspector / curl)
  │
  │  JSON-RPC or REST over HTTP
  ▼
Express Server  (a2a-copilot)
  │  ├─ /.well-known/agent-card.json  → Agent Card
  │  ├─ /a2a/jsonrpc                  → JSON-RPC  (tasks/send, tasks/sendSubscribe, …)
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
| `WORKSPACE_DIR` | Workspace directory | _(empty)_ |
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
```

Runs on port `3000`. No external tools. Good starting point for custom agents.

### Filesystem Assistant

```bash
./agents/filesystem-assistant/start.sh start
```

Runs on port `3000` and connects to the `@modelcontextprotocol/server-filesystem` MCP server. The agent can read, write, and search files inside its `workspace/` directory.

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

### stdio server (child process)

```json
"mcp": {
  "filesystem": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"]
  }
}
```

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
| `POST /a2a/jsonrpc` | JSON-RPC: `tasks/send`, `tasks/sendSubscribe`, `tasks/get`, `tasks/cancel` |
| `POST /a2a/rest` | REST equivalent |
| `GET /health` | Health check |
| `POST /context/build` | Trigger context discovery |
| `GET /context` | Read the built context file |

Streaming uses SSE for real-time status updates and artifact chunks. Set `--stream-artifacts` for spec-correct chunk streaming or leave it unset (default) for buffered output compatible with the [A2A Inspector](https://github.com/google-deepmind/a2a).

## External Copilot CLI

For debugging or sharing a single CLI instance across multiple agents:

```bash
# Start CLI in headless mode
copilot --headless --port 4321

# Point the wrapper at it
a2a-copilot --config agents/example/config.json --cli-url localhost:4321
```

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
