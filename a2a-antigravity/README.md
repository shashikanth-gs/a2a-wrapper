# a2a-antigravity

[![npm version](https://img.shields.io/npm/v/a2a-antigravity.svg)](https://www.npmjs.com/package/a2a-antigravity)
[![CI](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Google Antigravity is an agent runtime for Gemini-backed local and remote
software engineering workflows. It exposes repository tools, policy controls,
hooks, MCP integration, and multi-turn agent sessions through the
`google-antigravity` Python SDK.

**a2a-antigravity** exposes Antigravity as a standalone, interoperable agent via
the [A2A protocol](https://github.com/google-deepmind/a2a). Drop a JSON config
file in, get a spec-compliant A2A server out. Any orchestrator that speaks A2A
can discover and call it without embedding Antigravity-specific integration
code.

> **What is different here:** the public wrapper is Node/TypeScript, but the
> Antigravity SDK is Python. This package runs the A2A HTTP server in Node and
> starts a private Python subprocess for `google-antigravity`. The subprocess is
> managed over a small JSONL bridge; it is not a public API surface.

> **The pattern:** MCP is the vertical rail — how agents access tools. A2A is
> the horizontal rail — how agents talk to each other. This library adds the
> horizontal rail to Google Antigravity.

**Features:**
- Full [A2A v0.3.0](https://github.com/google-deepmind/a2a) protocol — Agent Card, JSON-RPC, REST, and SSE-compatible behavior through `@a2a-js/sdk`
- Powered by the Google Antigravity Python SDK through a private Python bridge
- Explicit `a2a-antigravity setup` command for managed Python virtualenv creation
- Gemini API key and Vertex/ADC auth modes exposed through JSON/env/CLI config
- Tested with `gemini-3.1-flash-lite`
- Antigravity policy support, including `run_command` enablement for trusted workspaces
- MCP server config passthrough for Antigravity-supported stdio and Streamable HTTP transports
- Multi-turn context continuity — each A2A `contextId` maps to a persistent Antigravity session
- Sideband trace artifacts for lifecycle, tool-call start, usage, errors, and structured output
- JSON config file with layered overrides (JSON → env vars → CLI flags)
- TypeScript source with full type declarations

## Why a Node wrapper around a Python subprocess?

The rest of this monorepo exposes A2A servers from Node packages. Antigravity's
public SDK surface is Python. Keeping the public server in Node gives
orchestrators the same A2A HTTP surface, packaging model, config layering, and
sideband event conventions as `a2a-codex`, `a2a-copilot`, and `a2a-opencode`,
while letting the Python subprocess own SDK-specific session and tool behavior.

This split is intentionally narrow:

- Node owns the A2A server, config loading, agent card, task lifecycle, and
  event mapping.
- Python owns `google-antigravity` imports, `LocalAgentConfig`, sessions, chats,
  built-in tools, policies, and SDK-native chunks.
- The bridge protocol is JSONL over stdio and treated as an internal boundary.

## Works with agent frameworks

This library complements — not replaces — frameworks like LangGraph, Google ADK,
Microsoft Agent Framework, and CrewAI. Use those frameworks for orchestration,
state, and memory control. Use `a2a-antigravity` as the execution node they call.

```
LangGraph / ADK / Microsoft Agent Framework
        (state, memory, flow control)
                    ↓
              A2A Protocol
                    ↓
            a2a-antigravity
       (Node A2A server + Python SDK bridge)
                    ↓
          Google Antigravity SDK / Gemini
```

## Quick Start

```bash
# Install globally
npm install -g a2a-antigravity

# Create the managed Python environment once
a2a-antigravity setup

# Run the bundled example agent
export GEMINI_API_KEY=...
export WORKSPACE_DIR=/path/to/your/repo
a2a-antigravity --config agents/example/config.json
```

Or run without installing globally:

```bash
npx a2a-antigravity setup
GEMINI_API_KEY=... WORKSPACE_DIR=/path/to/repo npx a2a-antigravity --config agents/example/config.json
```

The agent card is available at
`http://localhost:3040/.well-known/agent-card.json`.

## Tested With

| Component | Version |
|---|---|
| Google Antigravity Python SDK | **0.1.5** |
| Gemini model | **gemini-3.1-flash-lite** |
| `@a2a-js/sdk` | **0.3.13** |
| A2A protocol | **0.3.0** |
| Node.js | **>=18** |
| Python | **>=3.10** |

Other versions may work, but the above combination is what has been tested
end-to-end.

## Architecture

```
A2A Client (Orchestrator / Inspector / curl)
  │
  │  JSON-RPC or REST over HTTP
  ▼
Express Server  (a2a-antigravity, Node/TypeScript)
  │  ├─ /.well-known/agent-card.json  → Agent Card
  │  ├─ /a2a/jsonrpc                  → JSON-RPC  (message/send, message/sendSubscribe, …)
  │  ├─ /a2a/rest                     → REST handler
  │  └─ /health                       → Health check
  │
  │  @a2a-js/sdk  DefaultRequestHandler
  ▼
AntigravityExecutor  (AgentExecutor)
  │  ├─ SessionManager  — contextId → Antigravity session id
  │  ├─ EventMapper     — SDK bridge events → A2A trace artifacts
  │  └─ BridgeClient    — JSONL over stdio
  ▼
Private Python subprocess
  │  ├─ src/antigravity/python/bridge.py
  │  ├─ google-antigravity LocalAgentConfig
  │  ├─ Agent.chat(...)
  │  └─ SDK chunks: text, thoughts, tool calls, usage, structured output
  ▼
Google Antigravity SDK
  │  ├─ Gemini / Vertex model access
  │  ├─ Built-in tools such as run_command, view_file, edit_file
  │  └─ MCP servers configured through LocalAgentConfig
```

## Installation

```bash
# npm
npm install a2a-antigravity

# yarn
yarn add a2a-antigravity

# pnpm
pnpm add a2a-antigravity
```

## Python Runtime Setup

`a2a-antigravity` is published as an npm package, but the Antigravity runtime is
the Google Antigravity Python SDK. The npm install does not create a Python
environment or run `pip` automatically. Run the explicit setup command once:

```bash
npx a2a-antigravity setup
```

`setup` creates a managed Python virtual environment in the user's cache
directory and installs the bundled `requirements.txt`
(`google-antigravity==0.1.5`). Later server starts automatically use this
managed environment when `ANTIGRAVITY_PYTHON`, `--python`, and
`antigravity.pythonPath` are not set.

Useful setup options:

```bash
npx a2a-antigravity setup --python /path/to/python3
npx a2a-antigravity setup --venv-dir /path/to/venv
npx a2a-antigravity setup --force
```

If you prefer to manage Python yourself, install the SDK in the Python
environment used by `antigravity.pythonPath` or `ANTIGRAVITY_PYTHON`:

```bash
python3 -m pip install google-antigravity
```

Then run with:

```bash
ANTIGRAVITY_PYTHON=/path/to/venv/bin/python a2a-antigravity --config agents/example/config.json
```

## Python Subprocess Lifecycle

The Python bridge is a private child process owned by the Node server. The
wrapper handles the normal production failure paths:

- Startup validates that the selected Python can import `google.antigravity`;
  otherwise the server fails fast with a setup-focused error.
- Bridge spawn errors and unexpected bridge exits are logged and reject any
  pending or active agent requests instead of hanging callers.
- Shutdown sends a bridge `shutdown` command, closes stdin so the Python read
  loop can exit naturally, waits for process close, then escalates to `SIGTERM`
  and `SIGKILL` if needed.
- CLI `SIGINT`, `SIGTERM`, and `SIGHUP` handlers close the HTTP server before
  shutting down the executor and bridge.

Live smoke tests covered both parent and child failure paths:

- Sending `SIGTERM` to the Node server closed the HTTP server and removed the
  Python child process.
- Killing the Python bridge with `SIGKILL` logged the bridge exit, kept the Node
  server alive, and `/health` continued to respond.

Operational limits still apply. If the Node process is terminated with
`SIGKILL`, the runtime cannot run cleanup handlers. If Antigravity or a tool
starts detached grandchildren, killing the direct Python bridge may not clean up
that unrelated process tree. For heavily sandboxed command execution, combine
Antigravity policy controls with your platform's process supervision, job
objects, containers, or cgroups.

## Usage

### CLI

```bash
a2a-antigravity --config agents/example/config.json
```

Full flag reference:

```
a2a-antigravity [options]
       a2a-antigravity setup [options]

  --config, --agent-json <path>  JSON agent config file
  --port <number>                A2A server port                 (default: 3040)
  --hostname <addr>              Bind address                    (default: 0.0.0.0)
  --advertise-host <host>        Hostname for agent card URLs    (default: localhost)
  --workspace <path>             Primary Antigravity workspace
  --model <model>                Antigravity/Gemini model
  --auth-mode <mode>             sdkDefault | apiKey | adc
  --api-key <key>                Gemini API key                  (prefer GEMINI_API_KEY)
  --project <id>                 Vertex/ADC project
  --location <region>            Vertex/ADC location
  --python <path>                Python executable for the bridge
  --stream-artifacts             Stream artifact chunks
  --no-stream-artifacts          Buffer artifacts (default)
  --log-level <level>            debug | info | warn | error
  --help                         Show this help
  --version                      Show version

Setup options:
  setup --python <path>          Python 3.10+ executable used to create the managed venv
  setup --venv-dir <path>        Override managed venv directory
  setup --force                  Recreate the managed venv before installing requirements
```

### Programmatic API

```typescript
import { createA2AServer, resolveConfig } from "a2a-antigravity";

const config = resolveConfig("agents/example/config.json");
const handle = await createA2AServer(config);

console.log("Antigravity A2A server running");
await handle.shutdown();
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes for `apiKey` auth | Gemini Developer API / AI Studio key |
| `WORKSPACE_DIR` | Yes* | Workspace directory Antigravity can operate in |
| `ANTIGRAVITY_MODEL` / `GEMINI_MODEL` | No | Override model, e.g. `gemini-3.1-flash-lite` |
| `ANTIGRAVITY_AUTH_MODE` | No | `sdkDefault`, `apiKey`, or `adc` |
| `ANTIGRAVITY_PYTHON` | No | Explicit Python executable for the bridge |
| `A2A_ANTIGRAVITY_HOME` | No | Base directory for managed Python environment |
| `A2A_ANTIGRAVITY_VENV` | No | Exact managed Python virtualenv directory |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_PROJECT` | Required for `adc` | Vertex project |
| `GOOGLE_CLOUD_LOCATION` / `GOOGLE_LOCATION` | Required for `adc` | Vertex location |
| `PORT` | No | A2A server port |
| `HOSTNAME` | No | Bind address |
| `ADVERTISE_HOST` | No | Hostname embedded in agent card URLs |
| `STREAM_ARTIFACTS` | No | Set `"true"` to stream artifact chunks |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` |

*Can also be set via `antigravity.workingDirectory` in config or `--workspace`.

## Model Access

The wrapper supports the auth surfaces exposed by the current Python SDK:

- `sdkDefault`: omit provider auth fields and let the SDK read environment/defaults.
- `apiKey`: Gemini Developer API / AI Studio key via `GEMINI_API_KEY` or `provider.apiKey`.
- `adc`: Vertex / Gemini Enterprise Agent Platform with Application Default Credentials.

Google AI Pro/Ultra product-login OAuth is not exposed by `google-antigravity`
0.1.5 as a public Python SDK config surface, so this wrapper does not implement
an unofficial subscription-login path.

## Local Development

```bash
GEMINI_API_KEY=... WORKSPACE_DIR=/path/to/repo npm run dev -w a2a-antigravity -- --config agents/example/config.json
```

Vertex/ADC:

```bash
gcloud auth application-default login
npm run dev -w a2a-antigravity -- \
  --workspace /path/to/repo \
  --auth-mode adc \
  --project my-gcp-project \
  --location us-central1
```

## Example Configs

The default example uses Gemini API key auth, reads the key from
`GEMINI_API_KEY`, and pins the tested Flash-Lite model:

```json
{
  "antigravity": {
    "workingDirectory": "${WORKSPACE_DIR}",
    "model": "gemini-3.1-flash-lite",
    "provider": {
      "authMode": "apiKey",
      "apiKey": "${GEMINI_API_KEY}"
    }
  }
}
```

Run it from the monorepo:

```bash
GEMINI_API_KEY=... WORKSPACE_DIR="$PWD" npm run dev -w a2a-antigravity -- --config agents/example/config.json
```

The repository also includes
`agents/example/config.run-command.json`, which keeps the same model and auth
but enables Antigravity shell command execution with:

```json
{
  "policies": {
    "mode": "allowAll"
  }
}
```

Use that config only in trusted workspaces. It lets the agent execute local
commands through Antigravity's built-in `run_command` tool.

```bash
GEMINI_API_KEY=... WORKSPACE_DIR="$PWD" npm run dev -w a2a-antigravity -- --config agents/example/config.run-command.json
```

Or, from the example directory:

```bash
cd a2a-antigravity/agents/example
GEMINI_API_KEY=... CONFIG_FILE="$PWD/config.run-command.json" ./start.sh
```

## Model Notes

Live tests confirmed the wrapper works with `gemini-3.1-flash-lite` through the
Google Antigravity SDK and Gemini API key auth. The request completed through
the A2A JSON-RPC endpoint and usage telemetry reported
`model: "gemini-3.1-flash-lite"`.

`gemini-3.5-flash` is listed by Google as a Flash model, but
`gemini-3.5-flash-lite` was not available from the Gemini model list at the
time of testing. A real request using `gemini-3.5-flash-lite` reached Gemini and
returned `404 NOT_FOUND`. Use Google's Gemini model documentation to confirm
current model IDs before changing the example:

- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite

## Command Policy and `run_command`

The Antigravity SDK default policy denies `run_command` unless command execution
is explicitly allowed. With the default example config, the model can attempt a
shell command, and the wrapper emits a sideband tool-start event, but the SDK
denies execution.

For example, asking the agent to check system date/time and free disk space made
it attempt:

```text
date && df -h .
```

With the default config, the final response reported that `run_command` was
blocked by policy, so the agent could not read the date or disk details.

With `agents/example/config.run-command.json`, the same request succeeded. A
live test observed:

```text
Thu Jul 9 15:26:50 IST 2026
/dev/disk3s5   926Gi   292Gi   613Gi    33% ... /System/Volumes/Data
```

The wrapper supports these policy modes under `antigravity.policies`:

- `sdkDefault`: omit SDK policy config and use Antigravity defaults.
- `allowAll`: pass `policy.allow_all()`; this allows `run_command`.
- `denyAll`: pass `policy.deny_all()`.
- `custom`: pass explicit allow/deny rules.

For a deny-by-default config that allows only shell commands:

```json
{
  "antigravity": {
    "policies": {
      "mode": "custom",
      "rules": [
        { "decision": "allow", "tool": "run_command" },
        { "decision": "deny", "tool": "*" }
      ]
    }
  }
}
```

Refer to Google's Antigravity SDK documentation for the authoritative policy
semantics, priority rules, and safety guidance:

- https://antigravity.google/docs/sdk/overview
- https://github.com/google-antigravity/antigravity-sdk-python/blob/main/google/antigravity/hooks/README.md
- https://github.com/google-antigravity/antigravity-sdk-python/blob/main/google/antigravity/tools/README.md
- https://raw.githubusercontent.com/google-antigravity/antigravity-sdk-python/main/google/antigravity/hooks/policy.py

## Sideband Events

When `events.transport` is `"a2a"`, sideband events are returned as A2A
`trace.*` artifacts. In live tests, the Antigravity wrapper emitted:

- `trace.lifecycle`: agent start and finish.
- `trace.mcp.start`: built-in tool call start, including `tool:
  "run_command"` and arguments such as `command_line` and `working_dir`.
- `trace.usage`: token usage and model name.

Current limitation found in testing: command output did not appear as a separate
tool-result sideband artifact. When `run_command` was allowed, the command
output appeared in the final `response` artifact. No `trace.thinking` artifact
was observed with `gemini-3.1-flash-lite` for the command test.

Example JSON-RPC request for checking the command path:

```bash
curl -s -X POST http://localhost:3040/a2a/jsonrpc \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": "sideband-1",
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "msg-sideband-1",
        "role": "user",
        "parts": [
          {
            "kind": "text",
            "text": "Use local tools to check the current system date/time and free disk space for the current workspace filesystem. Run commands equivalent to date and df -h . Then report what succeeded and any permission failures."
          }
        ],
        "contextId": "ctx-sideband-1"
      }
    }
  }'
```

## Config Shape

Common wrapper concerns stay top-level: `agentCard`, `server`, `session`,
`features`, `timeouts`, `logging`, `events`, `memory`, `mcp`, and `subAgents`.

Antigravity-specific runtime settings live under `antigravity`. Provider/model
auth and routing stay under `antigravity.provider`.

Unset SDK-owned fields are omitted from the Python bridge config so SDK defaults
remain authoritative.

## Related Packages

This package is part of the [a2a-wrapper](https://github.com/shashikanth-gs/a2a-wrapper) monorepo:

| Package | Description |
|---|---|
| [`@a2a-wrapper/core`](https://www.npmjs.com/package/@a2a-wrapper/core) | Shared infrastructure (logging, config, server, events, session, CLI) |
| [`a2a-copilot`](https://www.npmjs.com/package/a2a-copilot) | A2A wrapper for GitHub Copilot |
| [`a2a-opencode`](https://www.npmjs.com/package/a2a-opencode) | A2A wrapper for OpenCode |
| [`a2a-claude`](https://www.npmjs.com/package/a2a-claude) | A2A wrapper for Claude Code |
| [`a2a-codex`](https://www.npmjs.com/package/a2a-codex) | A2A wrapper for OpenAI Codex |

## Contributor Notes

This package intentionally has two runtimes:

- Node/TypeScript is the public package surface. Keep A2A protocol handling,
  config loading, server behavior, and npm-facing CLI UX here.
- Python is the private SDK adapter. Keep it small and focused on translating
  JSONL bridge commands into `google-antigravity` SDK calls.

When adding Antigravity SDK features, prefer extending the typed JSON config and
bridge protocol narrowly instead of exposing Python internals directly. If the
SDK changes policy names, model behavior, hook semantics, or built-in tool
payloads, update this README and the example configs with the tested behavior.
