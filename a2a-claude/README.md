# a2a-claude

[![npm version](https://img.shields.io/npm/v/a2a-claude.svg)](https://www.npmjs.com/package/a2a-claude)
[![CI](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Claude Code is Anthropic's production-grade software engineering agent. It handles repository navigation, multi-step planning, shell commands, file editing, and permission management — all the plumbing you'd spend months building from scratch.

**a2a-claude** exposes it as a standalone, interoperable agent via the [A2A protocol](https://github.com/google-deepmind/a2a), using the [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Drop a JSON config file in, get a fully spec-compliant A2A server out. Any orchestrator that speaks A2A can discover and call it — no Claude-specific integration code required.

> **The pattern:** MCP is the vertical rail — how agents access tools. A2A is the horizontal rail — how agents talk to each other. This library adds the horizontal rail to Claude Code.

**Features:**
- Full [A2A v0.3.0](https://github.com/google-deepmind/a2a) protocol — Agent Card, JSON-RPC, REST, streaming
- Powered by `@anthropic-ai/claude-agent-sdk` (pinned `0.3.202`) — `claude-sonnet-5`, `claude-opus-4-8`, and any SDK-compatible model
- Permission-mode guardrails — headless-safe modes only, with an explicit opt-in for unrestricted access
- MCP tool support — stdio and Streamable HTTP transports
- Multi-turn context continuity — each A2A `contextId` maps to a persistent Claude session (resumed via the SDK's `resume` option)
- AbortController-based cancellation
- Multi-agent delegation via A2A sub-agents
- Sideband observability events — thinking summaries, tool calls, file changes, todo lists, usage/cost
- JSON config file with layered overrides (JSON → env vars → CLI flags)
- Docker-ready
- TypeScript source with full type declarations

## Quick Start

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export WORKSPACE_DIR=/path/to/your/repo

npm install
npm run dev -w a2a-claude -- --config agents/example/config.json
```

Fetch the agent card:

```bash
curl -s http://localhost:3030/.well-known/agent-card.json | jq .
```

Once published, the CLI is also runnable directly:

```bash
npm install -g a2a-claude
export ANTHROPIC_API_KEY=sk-ant-... WORKSPACE_DIR=/path/to/your/repo
a2a-claude --config agents/example/config.json
```

## Authentication

`ANTHROPIC_API_KEY` is the primary and recommended authentication path — export it before starting the agent (or set it in `.env`, see `.env.example`).

Bedrock, Vertex, and Claude Code OAuth environment variables (e.g. `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and related credentials) pass through untouched to the Claude Agent SDK — the wrapper never reads, validates, or stores them. Set whichever auth environment your deployment needs; a2a-claude only cares that the SDK's `query()` call can authenticate when invoked.

The API key (or any other credential) is **never** placed in `config.json`. Config fields that need a secret use `${ENV_VAR}` substitution instead (see MCP servers below).

## Configuration Reference

All settings live in a single JSON config file. Priority order: **built-in defaults ← config file ← environment variables ← CLI flags**.

### `claude` block fields

Fields map 1:1 onto `@anthropic-ai/claude-agent-sdk` `Options` (source of truth: `src/config/types.ts`).

| Field | Type | Description |
|---|---|---|
| `workingDirectory` | `string` | Absolute path to the workspace Claude operates on. Required at runtime. Supports `${ENV_VAR}`. |
| `model` | `string` | Model (e.g. `claude-sonnet-5`). Supports `${CLAUDE_MODEL}`. SDK default when omitted. |
| `fallbackModel` | `string` | Fallback model when the primary is overloaded/unavailable. |
| `permissionMode` | `"acceptEdits" \| "dontAsk" \| "plan" \| "bypassPermissions"` | Permission mode. `"default"` and `"auto"` are rejected — see **Permission modes** below. Default: `"acceptEdits"`. |
| `allowedTools` | `string[]` | Tools auto-allowed without prompting. |
| `disallowedTools` | `string[]` | Tools removed from the model's context entirely. |
| `systemPromptAppend` | `string` | Appended to the `claude_code` preset system prompt. |
| `customSystemPrompt` | `string` | Full system prompt replacement. Mutually exclusive with `systemPromptAppend`. |
| `settingSources` | `Array<"user" \| "project" \| "local">` | Filesystem settings sources to load. Default `[]` = full isolation from host `~/.claude` and project settings. Include `"project"` to load workspace `CLAUDE.md`. |
| `maxTurns` | `number` | Max conversation turns per query (runaway protection). |
| `maxBudgetUsd` | `number` | Max budget in USD per query. |
| `additionalDirectories` | `string[]` | Additional directories Claude can access. Supports `${ENV_VAR}` per entry. |
| `sandbox` | `object` | Opaque SDK sandbox settings passthrough (OS-level command sandboxing). |
| `executablePathOverride` | `string` | Override the path to the Claude Code executable. |
| `dangerouslyAllowBypassPermissions` | `boolean` | Must be `true` when `permissionMode` is `"bypassPermissions"`. |
| `contextFile` | `string` | Filename for the pre-built domain context file within `workingDirectory`. Default `"context.md"`. |
| `contextPrompt` | `string` | Default prompt used when `buildContext()` is called without an explicit prompt. |

### Full config reference

```json
{
  "agentCard": {
    "name": "Claude Workspace Engineer",
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
        "description": "Inspect, modify, and validate code within the configured workspace.",
        "tags": ["code", "repository", "tests", "refactoring"]
      }
    ]
  },

  "server": {
    "port": 3030,
    "hostname": "0.0.0.0",
    "advertiseHost": "localhost",
    "advertiseProtocol": "http"
  },

  "claude": {
    "workingDirectory": "${WORKSPACE_DIR}",
    "model": "${CLAUDE_MODEL}",
    "permissionMode": "acceptEdits",
    "settingSources": [],
    "additionalDirectories": [],
    "systemPromptAppend": "Operate only within the configured workspace."
  },

  "session": {
    "reuseByContext": true,
    "ttl": 3600000,
    "cleanupInterval": 300000
  },

  "features": {
    "streamArtifactChunks": false,
    "emitThinkingEvents": true,
    "emitToolEvents": true,
    "emitFileChangeEvents": true,
    "emitTodoEvents": true
  },

  "timeouts": {
    "prompt": 600000
  },

  "logging": {
    "level": "info"
  }
}
```

### Permission modes

Claude Code's `permissionMode` controls whether tool calls are auto-approved. Headless A2A execution cannot show an interactive approval prompt to a human, so two of the SDK's four modes are rejected at startup:

| Mode | Behaviour | Headless-safe |
|---|---|---|
| `default` | Interactive approval per tool call | **Rejected** — no human in the loop |
| `auto` | Heuristic/classifier-based approval | **Rejected** — not supported for headless A2A |
| `acceptEdits` | Auto-approve file edits; other guardrails still apply | Yes (default) |
| `dontAsk` | Never prompt; broadest auto-approval short of bypass | Yes |
| `plan` | Read/analyze only — no mutating tool calls | Yes |
| `bypassPermissions` | Unrestricted tool access | Yes, **only** with `dangerouslyAllowBypassPermissions: true` |

Setting `permissionMode: "bypassPermissions"` without `dangerouslyAllowBypassPermissions: true` throws at startup. When bypass is enabled, the executor logs a loud warning on every startup as a reminder that Claude has unrestricted tool access — only use it inside an isolated container or VM.

### `settingSources` isolation

`settingSources` defaults to `[]`, meaning Claude Code loads **no** host `~/.claude` user settings and **no** project `CLAUDE.md` / `.claude/settings.json` — every session starts from a clean, isolated slate driven entirely by `config.json`. Add `"project"` to `settingSources` to let Claude read the workspace's `CLAUDE.md` and project-level settings (useful when the target repository already documents its own conventions). Add `"user"` to load the host user's `~/.claude` settings — only do this in trusted, single-tenant deployments, since it pulls in configuration outside the agent's config file.

`strictMcpConfig` is always enabled internally (not user-configurable) — Claude is only allowed to use MCP servers explicitly declared in `config.json`, never ones discovered from ambient settings.

## Example Agents

| Config | Port | Permission mode | Description |
|---|---|---|---|
| `agents/example/config.json` | `3030` | `acceptEdits` | Workspace engineer — read + write access |
| `agents/read-only-reviewer/config.json` | `3031` | `plan` (+ `Write`/`Edit`/`NotebookEdit`/`Bash` disallowed) | Code reviewer — never modifies files or runs commands |

Each agent directory bundles a `start.sh` lifecycle script and a `workspace/` placeholder directory:

```bash
# Start in the background
agents/example/start.sh start

# Check status / health
agents/example/start.sh status

# Tail logs
agents/example/start.sh logs

# Stop
agents/example/start.sh stop

# Run in the foreground (useful for debugging / Docker)
agents/example/start.sh foreground
```

Point either agent at a real repository by overriding `WORKSPACE_DIR` before calling `start.sh`:

```bash
WORKSPACE_DIR=/path/to/repo agents/read-only-reviewer/start.sh start
```

Copy a directory to create your own agent: `cp -r agents/example agents/my-agent`.

## MCP Servers

MCP configuration is baked at SDK construction time — all servers must be declared in `config.json` before the agent starts. Only `stdio` and Streamable `http` transports are supported (SSE-only servers are rejected at startup).

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

The key **`a2a-subagents`** is reserved for the sub-agent bridge described below — using it for a user-defined MCP server fails validation at startup.

## Sub-agents

Any `a2a-claude` agent can delegate to other A2A agents by declaring them under `subAgents` in `config.json`. The wrapper bootstraps [`a2a-mcp-skillmap`](https://www.npmjs.com/package/a2a-mcp-skillmap) as a stdio MCP server registered under the reserved `a2a-subagents` key, and each remote skill becomes a callable tool for Claude (`{name}__{skillId}`). MCP calls to `a2a-subagents` are enriched with `toolKind: "a2a_subagent"` and `delegation: true` in sideband events.

See the [root README's Sub-Agents section](../README.md#calling-other-a2a-agents-sub-agents) for the full `subAgents` schema, auth modes, and a runnable example.

## Sideband Events

Sideband events are published through `AgentEventEmitter` for every Claude Agent SDK message. Use them for observability, tracing, and orchestration. Secrets are redacted (API keys, tokens, passwords, etc.) and tool output is truncated at 10,000 characters; file contents are never emitted, only path + operation kind.

| Event | Emitted when | Notes |
|---|---|---|
| `agent_started` | SDK `system`/`init` message | Includes `backend: "claude"` and the resolved model |
| `thinking` | Assistant `thinking` content block | Controlled by `features.emitThinkingEvents` |
| `tool_call_start` / `tool_call_end` | Assistant `tool_use` block / matching `tool_result` | `toolKind` is `"shell"` (Bash), `"mcp"`, `"a2a_subagent"` (mcp server `a2a-subagents`), or `"builtin"`; controlled by `features.emitToolEvents` |
| `decision` (`kind: "file_change"`) | `Edit` / `Write` / `NotebookEdit` tool call | Path and change kind only — never file contents; controlled by `features.emitFileChangeEvents` |
| `decision` (`kind: "todo_list"`) | `TodoWrite` tool call | Controlled by `features.emitTodoEvents` |
| `decision` (`kind: "permission_denied"`) | SDK `system`/`permission_denied` message | Tool name + sanitized message |
| `agent_finished` | SDK `result`/`success` message | Includes sanitized `usage`, `totalCostUsd`, `numTurns` |
| `agent_error` | SDK `result` failure subtypes / `error` message | Sanitized error message; reason mapped from the SDK's failure subtype (e.g. max turns, max budget) |

## Docker

Build from the **monorepo root** (the image needs local `@a2a-wrapper/core` source):

```bash
docker build -f a2a-claude/Dockerfile -t a2a-claude:latest .
```

Run with an API key:

```bash
docker run -p 3030:3030 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e WORKSPACE_DIR=/workspace \
  -v /host/path/to/repo:/workspace \
  a2a-claude:latest
```

See the `Dockerfile` header comment for the alternative subscription-credential mount (`~/.claude:/home/node/.claude:ro`) and its OAuth-expiry caveat.

## Manual E2E Verification

The automated test suite (`npm test -w a2a-claude`) uses a fake SDK client and never calls the real Anthropic API. To validate the full stack against a real backend, run this one-shot check with a real `ANTHROPIC_API_KEY`:

```bash
export ANTHROPIC_API_KEY=sk-ant-... WORKSPACE_DIR=/path/to/scratch-repo
npm run dev -- --config agents/example/config.json &
curl -s -X POST http://localhost:3030/a2a/jsonrpc -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": "1", "method": "message/send",
  "params": { "message": { "kind": "message", "messageId": "m1", "role": "user",
    "parts": [{ "kind": "text", "text": "List the files in this repository and summarize what it does." }] } }
}'
```

This is a manual, documented step — it is **not** part of automated CI and requires a funded Anthropic API key.

## Phase 2 Roadmap

The following are explicitly out of scope for this release and tracked as future work:

- hooks configuration
- native Claude subagents (`agents` option)
- skills
- structured outputs (`outputFormat`)
- richer usage/cost telemetry
- session forking
- `canUseTool` policy engine
- file checkpointing/rewind
- plan-mode review workflows

## License

[MIT](LICENSE) © Shashi Kanth
