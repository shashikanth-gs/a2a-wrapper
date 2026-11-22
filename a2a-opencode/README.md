# a2a-opencode

[![npm version](https://img.shields.io/npm/v/a2a-opencode.svg)](https://www.npmjs.com/package/a2a-opencode)
[![CI](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

[OpenCode](https://opencode.ai) is a production-grade agent runtime that supports Anthropic, OpenAI, GitHub Copilot, and more. It already handles multi-step planning, MCP tool execution, and streaming across any provider you configure.

**a2a-opencode** exposes it as a standalone, interoperable agent via the [A2A protocol](https://github.com/google-deepmind/a2a). Drop a JSON config file in, get a fully spec-compliant A2A server out. Any orchestrator that speaks A2A can discover and call it — swap the LLM provider in one config line without changing orchestration code.

> **The pattern:** MCP is the vertical rail — how agents access tools. A2A is the horizontal rail — how agents talk to each other. This library adds the horizontal rail to OpenCode, making it vendor-neutral by default.

**Features:**
- Native [A2A v1.0](https://a2a-protocol.org) protocol, backward compatible with v0.3.x clients — Agent Card, JSON-RPC, REST, SSE streaming
- Powered by OpenCode with support for any LLM provider (Anthropic, OpenAI, GitHub Copilot, and more)
- MCP tool server support — HTTP, SSE, stdio, and OAuth transports
- Multi-turn conversations via persistent OpenCode sessions
- SSE event streaming with automatic reconnect and polling fallback
- Auto-approval of tool permissions with configurable overrides
- Lifecycle and usage events (`agent_started` / `agent_finished` with token and cost summary) over the A2A sideband or an HTTP collector
- JSON config file with layered overrides (JSON → env vars → CLI flags)
- Docker-ready with corporate proxy CA support
- TypeScript source with full type declarations
- Postman collection included for API exploration

<details>
<summary><strong>Table of Contents</strong></summary>

- [Why not just integrate the LLM provider API directly?](#why-not-just-integrate-the-llm-provider-api-directly)
- [Works with agent frameworks](#works-with-agent-frameworks)
- [Quick Start](#quick-start)
- [Tested With](#tested-with)
- [Architecture](#architecture)
- [Installation](#installation)
- [Usage](#usage)
  - [CLI](#cli)
  - [Programmatic API](#programmatic-api)
- [Configuration](#configuration)
  - [JSON Config File](#json-config-file)
  - [Environment Variables](#environment-variables)
- [Bundled Agent Examples](#bundled-agent-examples)
  - [Example Agent (minimal)](#example-agent-minimal)
  - [Creating Your Own Agent](#creating-your-own-agent)
- [MCP Tool Servers](#mcp-tool-servers)
  - [Local server (stdio child process)](#local-server-stdio-child-process)
  - [Remote server (HTTP / SSE)](#remote-server-http--sse)
  - [Authenticated remote servers (custom headers)](#authenticated-remote-servers-custom-headers)
  - [Remote server with OAuth](#remote-server-with-oauth)
- [Memory Persistence](#memory-persistence)
  - [Config](#config)
  - [Instructions](#instructions)
  - [Skills](#skills)
  - [Where files are written](#where-files-are-written)
  - [`agentCard.skills` vs `memory.skills`](#agentcardskills-vs-memoryskills)
- [Calling Other A2A Agents](#calling-other-a2a-agents)
- [Event Transport (Observability)](#event-transport-observability)
  - [Events OpenCode emits](#events-opencode-emits)
  - [Default (A2A sideband)](#default-a2a-sideband)
  - [HTTP collector](#http-collector)
  - [Custom transport (programmatic)](#custom-transport-programmatic)
- [Docker](#docker)
  - [Corporate Proxy (Netskope / Zscaler)](#corporate-proxy-netskope--zscaler)
- [A2A Protocol](#a2a-protocol)
  - [Protocol Versions](#protocol-versions)
- [API Reference (Postman)](#api-reference-postman)
- [Context Building](#context-building)
- [Related Packages](#related-packages)
- [Contributing](#contributing)
- [License](#license)

</details>

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

> **Prerequisites:** [OpenCode](https://opencode.ai) 1.x or 2.x installed and running (`opencode serve`). The wrapper connects to it on `http://localhost:4096` by default. OpenCode 2.x also needs its server password — see [OpenCode 1.x and 2.x](#opencode-1x-and-2x).

## Tested With

| Component | Version |
|---|---|
| OpenCode server | **1.19.6** (1.x API) and **2.3.2** (2.x API) |
| `@opencode-ai/sdk` (1.x client) | **^1.19.6** |
| `@opencode/client` (2.x client) | **2.3.2** |
| A2A protocol | **v1.0 (native) + v0.3.x (backward compatible)** |
| Node.js | **>=20** |

> Other versions may work, but the above combination is what has been tested end-to-end.

### OpenCode 1.x and 2.x

OpenCode 2 replaced the server's wire protocol: every route moved under `/api/*`, the server requires HTTP Basic auth, and prompts are admitted to a durable inbox instead of returning a result. The wrapper supports **both** generations and picks one automatically:

| `opencode.apiVersion` | Behaviour |
|---|---|
| `"auto"` (default) | Probes `GET /api/info`. A JSON answer (200, or 401 when a password is required) means 2.x; anything else means 1.x. If the server is unreachable at startup, 1.x is assumed. |
| `"1"` | Force the 1.x protocol. Fails at startup with a clear error if the server turns out to be 2.x. |
| `"2"` | Force the 2.x protocol. |

**OpenCode 2.x requires a server password.** `opencode serve` prints a random one at startup. To use a known password, start the server with it and give the wrapper the same one:

macOS / Linux (bash, zsh):

```bash
export OPENCODE_SERVER_PASSWORD=change-me
opencode serve --port 4096
npx a2a-opencode --config agents/example/config.json   # in a second terminal with the same variable set
```

Windows PowerShell:

```powershell
$env:OPENCODE_SERVER_PASSWORD = "change-me"
opencode serve --port 4096
npx a2a-opencode --config agents/example/config.json   # in a second terminal with the same variable set
```

Windows cmd: `set OPENCODE_SERVER_PASSWORD=change-me` (no quotes) instead of the PowerShell line.

Prefer the environment variable to `opencode.password` in a config file. The OpenCode 2.x server always expects the username `opencode` (`OPENCODE_SERVER_USERNAME` is not honoured by the server); `opencode.username` exists only for reverse proxies that use different credentials. Without a password, or with a wrong one, the wrapper exits at startup with an authentication error.

Behaviour differences on 2.x worth knowing:

- `opencode.projectDirectory` is sent as an absolute path **on the OpenCode server's machine**. Absolute paths in either style (`/srv/proj`, `C:/proj`) are passed through untouched, so a wrapper in a Linux container can drive an OpenCode server on Windows (or the reverse). Relative paths are resolved against the wrapper's working directory.
- Model and agent are applied when the session is created (1.x applies them on every prompt).
- MCP servers are registered through OpenCode 2's experimental MCP routes, and the agent calls MCP tools through 2.x's code-mode `execute` tool, so progress messages read "Executing execute..." rather than the MCP tool's name.
- OpenCode's shell tool is called `bash` on 1.x and `shell` on 2.x; the built-in auto-approve ruleset covers both.
- `subtask` prompt parts have no 2.x equivalent and are sent as plain text.

## Architecture

```
A2A Client (Orchestrator / Inspector / curl)
  │
  │  JSON-RPC or REST over HTTP
  ▼
Express Server  (@a2a-wrapper/core: createProviderServer)
  │  ├─ /.well-known/agent-card.json  → Agent Card
  │  ├─ /a2a/jsonrpc                  → JSON-RPC  (message/send, message/stream, …)
  │  ├─ /a2a/rest                     → REST handler
  │  ├─ /context, /context/build      → Read / build context.md
  │  ├─ /mcp/status                   → MCP server status
  │  └─ /health                       → Health check
  │
  │  core's run runtime (A2A tasks, cancel, queue and steering, interactions, contextId → session bindings)
  ▼
OpenCodeProvider  (a ProviderExecutor of @a2a-wrapper/core)
  │  ├─ OpenCodeTurn        — one prompt: server events → status, artifacts, usage, questions
  │  ├─ EventStreamManager  — SSE + automatic reconnect (+ polling fallback)
  │  ├─ OpenCodeBackend     — 1.x client or 2.x client (durable inbox, interrupt)
  │  └─ MCP manager         — registers the configured MCP servers with OpenCode
  │
  │  @opencode-ai/sdk (1.x) or @opencode/client (2.x)  (HTTP + SSE)
  ▼
OpenCode Server  (opencode serve)
  │  ├─ LLM inference  (Anthropic, OpenAI, GitHub Copilot, …)
  │  └─ MCP tool execution
  │
  │  MCP Protocol  (HTTP / SSE / stdio / OAuth)
  ▼
MCP Servers  (filesystem, custom tools, …)
```

Only `@a2a-wrapper/core` knows A2A (and `@a2a-js/sdk`); this package only knows OpenCode.

## Installation

```bash
# npm
npm install a2a-opencode

# yarn
yarn add a2a-opencode

# pnpm
pnpm add a2a-opencode
```

## Release Channels

| Channel | Install | Cadence |
|---|---|---|
| Stable | `npm install a2a-opencode` | Manually reviewed and approved — see [Release Process](https://github.com/shashikanth-gs/a2a-wrapper/blob/main/CONTRIBUTING.md#release-process) |
| Canary | `npm install a2a-opencode@canary` | Every merge to `main` that passes CI |

Canary builds publish automatically after each merge, tagged like `a2a-opencode@1.7.1-canary-20260812081117`. They're unreviewed and have no changelog entry — useful for trying a fix ahead of a stable release, not for production. `npm install a2a-opencode` always resolves to the latest stable release regardless of how many canaries have shipped since.

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
  --api-version <v>               OpenCode server API: auto | 1 | 2   (default: auto)
  --model <provider/model>        LLM model                        (default: provider default)
                                  e.g. anthropic/claude-sonnet-4-20250514
  --agent <name>                  OpenCode agent preset
  --directory <path>              Project directory for OpenCode
  --agent-name <name>             Agent display name
  --agent-description <desc>      Agent description
  --interactions <mode>           auto | ask   (default: auto = nobody is asked)
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

const handle = await createA2AServer(resolveConfig('agents/example/config.json'), { runStore, eventTransport });
// handle.provider: the OpenCodeProvider (a `ProviderExecutor` of @a2a-wrapper/core)
// handle.registry: core's run runtime (cancel, steering, interactions, bindings)
await handle.shutdown();
```

See [Programmatic use and migration](#programmatic-use-and-migration-breaking-release) for what changed in this release.

## Configuration

Config is resolved in priority order: **defaults ← JSON file ← env vars ← CLI flags**

### JSON Config File

Create a `config.json` (see `agents/example/config.json` for the fully annotated template):

> `agentCard.protocolVersion` below is optional and kept only for backward
> compatibility with older config files — the server negotiates A2A v1.0 vs.
> v0.3.x automatically per request and no longer reads this field. See
> [Protocol Versions](../packages/core/README.md#protocol-versions) for how
> negotiation works.

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
    "apiVersion": "auto",
    "model": "anthropic/claude-sonnet-4-20250514",
    "systemPrompt": "You are a specialist agent that...",
    "contextFile": "context.md"
  },
  "features": {
    "autoApprovePermissions": true,
    "autoAnswerQuestions": true
  },
  "mcp": {
    "my-tools": {
      "type": "remote",
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
| `PORT` | Server port | `3000` |
| `HOSTNAME` | Bind address | `0.0.0.0` |
| `ADVERTISE_HOST` | Hostname in agent card URLs | `localhost` |
| `OPENCODE_URL` | OpenCode server URL | `http://localhost:4096` |
| `OPENCODE_API_VERSION` | `auto`, `1` or `2` (OpenCode server API generation) | `auto` |
| `OPENCODE_SERVER_PASSWORD` | OpenCode 2.x server password (HTTP Basic auth) | _(none)_ |
| `MODEL` | LLM model (`provider/model`). `OPENCODE_MODEL` is an accepted alias | _(OpenCode default)_ |
| `OPENCODE_AGENT` | OpenCode agent preset | _(from config)_ |
| `DIRECTORY` | Project directory for OpenCode. (`WORKSPACE_DIR` is a separate variable read only by `server.sh` / `start.sh` to choose where `opencode serve` runs — set `DIRECTORY` to the same path if you want both to agree.) | _(empty)_ |
| `AUTO_APPROVE` | Auto-approve tool permissions | `true` |
| `AUTO_ANSWER` | Auto-answer questions | `true` |
| `INTERACTIONS_MODE` | `auto` (nobody is asked) or `ask` (permissions and questions go to the A2A client) | `auto` |
| `STREAM_ARTIFACTS` | Stream chunks in real time | `false` |
| `LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error` | `info` |
| `AGENT_NAME` | Override agent card name | _(from config)_ |
| `AGENT_DESCRIPTION` | Override agent card description | _(from config)_ |

See [`.env.example`](.env.example) for the full reference.

## Conversations and restarts

Messages that carry the same `contextId` continue the same OpenCode session. The server session id is bound to the `contextId` by
core (`run.bind`, as soon as the session exists, before the first output) and resumed on the next task, so the model remembers
earlier turns. A session the server no longer has (it was deleted) is not an error: core forgets the binding and runs the same turn
on a fresh session.

> **Resume after a restart needs a durable `RunStore`.** The default store is in memory, so with the defaults **nothing survives
> a restart**: the `contextId` to session binding is gone and the next message starts a new OpenCode session (the old one stays on
> the OpenCode server, unused). Core ships only the in-memory store today; a durable one is tracked in #69. To keep conversations
> across restarts supply your own `RunStore` (see core's `RunStore` interface and its contract test suite):
>
> ```typescript
> import { createA2AServer, resolveConfig } from 'a2a-opencode';
> const handle = await createA2AServer(resolveConfig('agent.json'), { runStore: new MyDurableRunStore() });
> ```
>
> Tasks themselves are in memory either way (an in-flight task does not survive a restart; its OpenCode session does).

With a durable store a restart is also handled on the server side: **a task that was running when the wrapper died is still being
worked on by the OpenCode server**, so at start-up core calls the provider's `abortOrphan` for it, which stops the session by id
(`POST /session/:id/abort`, 2.x `interrupt`) and reports the abort confirmed only when the server says the session is idle (a
cancel also cancels the inbox items core says that run held, and only those, on 2.x). A binding whose session the server no longer has is dropped when its context is
next used (or at start-up with core's `validateBindingsOnStart`, which asks the server with `GET` on the session).

The system prompt (`opencode.systemPrompt`) goes into the first message of a session; the binding remembers that it was sent, so a
resumed session does not get it again.

### Session lifetime

`session.ttl` (default 1 hour) is an **idle** expiry, as it always was: a context that is not used for that many milliseconds starts a
new OpenCode session on its next message; every message renews it. `0` or less disables the expiry. `session.maxAge` (unset by
default) is an optional **hard** maximum age, measured from when the session was created and never extended by use. The expiry
only ends the context's binding; the OpenCode session itself stays on the server (this wrapper has never deleted sessions).
`session.cleanupInterval` (default 5 minutes) is a background sweep that forgets the bindings of contexts idle for longer than
`ttl`, without waiting for them to be used again; 0 disables it. `session.reuseByContext: false` gives every task its own session
and binds nothing.

## Steering a running task

Send a second message to a task that is still running and choose what it means with the message metadata
`urn:a2a-wrapper:delivery:v1`:

| Delivery | What happens |
|---|---|
| `queue` (default) | The message waits and runs as the next turn of the same task, on the same session. |
| `steer` | OpenCode **2.x**: sent with the server's native `delivery: "steer"` and folded into the running turn at its next step boundary. The answer is `inserted` when the server says it delivered the message (`session.inbox.delivered`) within `timeouts.steerAck` (default 5 s), otherwise `queued` with the server's inbox id as the handle; the stream then settles it: delivered while the turn runs means it was folded in (no new turn), an execution of its own means a new turn of the same task, a message that is never delivered is taken out of the inbox and handed back to core, which runs it as the next turn. OpenCode **1.x** has no such thing, so the provider has no `steer` handler there: core holds the message and runs it as the next turn and says so. |
| `interrupt` | Stops the session's running work (`abort` / 2.x `interrupt` without resuming parked messages) and runs the message next, on the same session. |

The caller gets one `Message` carrying the result under `urn:a2a-wrapper:delivery-result:v1`. A cancel (`tasks/cancel`) stops the
session's work at once and takes steered messages the server still held out of its inbox; the session itself stays valid for the
next message of the context. `abort` reports `confirmed` only when the server says the session is idle (stream event, else its
status), and `unconfirmed` otherwise.

Known limitations:

- A steered message is only folded in at a step boundary: a long tool call or a long answer delays it (the first answer to the
  task includes the answer to the steer when the model produced it in the same execution).
- An `interrupt` removes steered messages that were still parked in the server's inbox and hands them to core: they run as their
  own turns right after the message that interrupted (the server could only run them inside the next turn's execution, where their
  output could not be told apart). Only text can be steered.
- A task with a held (queued) message publishes the first turn's result as a non-final `working` status, so `x-usage` can appear on
  a `working` status. Clients that read usage only from terminal metadata should read the completed status.
- In `streamArtifactChunks` mode the stored task holds the response text twice (the chunks, then the last-chunk marker with the
  full text, both appended). This is the behaviour of earlier releases and is kept.
- Every extra turn of a task (a queued message) publishes its own response artifact.

## Permissions and questions (`interactions`)

By default the wrapper is headless: nobody is asked. New sessions are created with every tool allowed up front
(`features.autoApprovePermissions`, default on), a permission request that still arrives is answered `always` (a saved project
rule, as it always was; `false` rejects), and a question is answered with the first option of each question
(`features.autoAnswerQuestions`, default on; `false` rejects it). Set `interactions.mode` to `ask` to route permission requests and
OpenCode's `question` tool through the A2A client instead:

```json
{
  "interactions": {
    "mode": "ask",
    "timeoutMs": 600000,
    "onTimeout": "fail",
    "autoAnswer": [
      { "match": { "risk": "low" }, "answer": { "kind": "allow_once" } },
      { "match": { "tool": "bash" }, "answer": { "decline": true } }
    ]
  }
}
```

- **`mode: "ask"`**: sessions the wrapper creates then allow reads and **ask** for edits, shell commands, MCP tools, fetches and
  sub-agents. A permission request parks the task as `input-required`; the status message names it ("Allow shell?", the command,
  the risk) and lists the options (`1. Allow once`, `2. Always allow`, `3. Deny`) with a short reply code. Reply with a new message
  on the same task: `1 K7M2` (the code is required to approve), `no`, or a structured reply `{ "interactionId": "...", "optionId":
  "once" | "always" | "reject", "feedback": "..." }`. Only an explicit allow approves; a timeout, a cancel or any unusable reply
  rejects, and the model is told (the `feedback` is what it sees). **"Always allow" saves the proposed patterns as project rules in
  OpenCode** and is offered with the patterns it would save; a **deny rejects every other pending request of that session too**
  (OpenCode's own behaviour: the other asks are withdrawn). Sessions that already exist keep the rules they were created with.
- **Questions** (the `question` tool, 2.x forms) arrive as a `question` interaction (header, options with descriptions, `multi`,
  free text accepted). Reply `{ "interactionId": "...", "answers": { "q0": { "optionIds": ["1"] } } }` (or free text); a declined
  question is rejected on the server.
- **`autoAnswer`**: rules answered without a person, first match wins, in both modes (with `mode: "auto"`, what no rule answers
  keeps the wrapper's own answer above). `match` fields are `kind`, `risk` (`low` for reads, `medium` for fetches and MCP tools,
  `high` for shell and edits), `tool` (OpenCode's permission name, for example `bash`, `shell`, `edit`, `webfetch`, `mcp`) and
  `action` (`execute`, `edit`, `read`, `fetch`, `mcp`).
- `timeoutMs` (default 10 minutes) and `onTimeout`: `fail` (default) ends the task, `deny` lets the run go on with the request
  rejected. The prompt timeout (`timeouts.prompt`) does not run while a person decides, and starts again afterwards.
- Also `--interactions ask` and `INTERACTIONS_MODE=ask`.
- **Sub-agents are covered.** OpenCode's built-in `task` tool creates a sub-session whose permission requests and questions carry
  the CHILD session id. The turn follows the session's `parentID` chain (at most 5 lookups, cached per turn, a cycle ends the walk)
  and, when it leads to the task's session, routes the request exactly like the task's own: through `interactions`, tagged
  ("Allow bash? (sub-agent: Explore ...)", `subject.detail.subSession`), and answered on the child's request id. A chain that cannot be
  resolved (the lookup fails, or it is deeper than 5) is **denied** in `ask` mode and gets the wrapper's own answer in `auto` mode
  (as before); requests of unrelated sessions are ignored. Usage of sub-sessions is not counted (see Usage and cost).
- After a wrapper restart a task waiting for an answer fails with "server restarted" and its session is stopped by `abortOrphan`.

## Usage and cost

OpenCode reports one assistant message per LLM call with its own tokens and cost (`0` for free models), never a running total, so
every call is a delta and nothing needs to be carried between turns. The completed status carries the task's summary as
`x-usage` (calls, tokens, cost, per-call log) and core's `urn:a2a-wrapper:usage:v1` metadata, and the `agent_finished` lifecycle
event carries the same summary (`null` when no call was observed, for example when polling was used). Usage covers the calls made
in the task's own session; calls made by sub-sessions OpenCode spawns itself are not included.

## Programmatic use and migration (breaking release)

`a2a-opencode` is built on `@a2a-wrapper/core`'s provider contract and no longer depends on `@a2a-js/sdk` (only core does).

**Breaking changes and migration**

- `OpenCodeExecutor`, `SessionManager` and `PermissionHandler` are removed from the public API (`a2a-opencode` and
  `a2a-opencode/opencode`), with no shim, and so are the `publishStatus`, `publishFinalArtifact`, `publishStreamingChunk` and
  `publishLastChunkMarker` re-exports (they publish on an SDK event bus; core owns that). Use `OpenCodeProvider` (a
  `ProviderExecutor`: `run`, `steer`, `abort`, `abortOrphan`, `release`, `probeSession`) behind core's run runtime. It is not an SDK
  `AgentExecutor`: there is no `execute(ctx, bus)` or `cancelTask`; cancel, steering and replies go through the A2A endpoints (or
  core's `RunRegistry`).
- `createA2AServer(config, options?)` takes `{ runStore?, eventTransport? }` and returns `{ provider, registry, executor, server,
  app, shutdown }`: `provider` is the `OpenCodeProvider`, `registry` core's run runtime, `executor` core's executor (it used to be
  the `OpenCodeExecutor`). Use `handle.provider.buildContext()` where you used `executor.buildContext()`. The old return value was
  `{ server, url }`-shaped in the README but `{ executor, ... }` in the code; the code's shape is what changed.
- Custom event transports: pass `{ eventTransport }` (it used to be set on `executor.customTransport`).
- `OpenCodeBackend.sessionPromptAsync` now returns the 2.x inbox item the prompt was admitted as (`{ inboxId, delivery }`, or
  nothing on 1.x) and accepts `delivery`; the backend gained the optional `inboxList` / `inboxCancel` (2.x), and the 2.x client
  passes more events on (`session.execution.started`, the inbox events, `permission.replied`, and `execution` / `reason` on the
  idle event). `usageRecordFromMessage` moved to `opencode/usage`.
- `session.ttl` keeps its meaning (an idle expiry); the new `session.maxAge` is the hard maximum age.
- What a client sees is unchanged except: the redundant `submitted` status after the initial task snapshot is gone; the completed
  status also carries `x-usage` and `urn:a2a-wrapper:usage:v1` (it carried no usage metadata before); a failed status carries `code`
  (`backend`, `unavailable`, `auth`); the `agent_started` lifecycle event follows the opening of the session (it used to precede
  it); a canceled or interrupted task closes its lifecycle with one `agent_error` ("Task canceled" / "Turn interrupted"); the context now survives a wrapper restart when a durable store is supplied; and a pending permission request or
  question of an UNRELATED session is no longer answered by this task (the old start-up poll answered every pending request of the
  server).
- A canceled or interrupted task now closes its lifecycle with one `agent_error` (`"Task canceled"` / `"Turn interrupted"`), and the
  `agent_started` lifecycle event now follows the opening of the session (it used to precede it).

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

### Authenticated remote servers (custom headers)

Many hosted MCP servers (Linear, Notion, remote GitHub MCP, etc.) require auth headers. Add a `headers` map to any `remote` server. Header values support `${ENV_VAR}` substitution so **secrets never live in `config.json`** — reference an environment variable and supply the value at runtime:

```json
"mcp": {
  "linear": {
    "type": "remote",
    "url": "https://mcp.linear.app/sse",
    "headers": {
      "Authorization": "Bearer ${LINEAR_API_KEY}"
    }
  }
}
```

```bash
LINEAR_API_KEY=lin_xxx ./agents/my-agent/start.sh start
```

Unresolved tokens (no matching env var) are left as-is so misconfigurations stay visible. The same `${VAR}` / `$VAR` substitution applies to a local server's `command` array and `environment` map — keep tokens out of committed config and inject them via the environment.

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

For static auth where you control the token, prefer `headers` with `${ENV_VAR}` substitution. Use `oauth` when the server requires an OAuth2 authorization flow.

## Memory Persistence

Give your agent persistent instructions and skills that survive across sessions. Declare them in config.json and they're materialized into the workspace at startup — the LLM reads them automatically as part of its context.

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

A markdown file with project-level instructions, coding conventions, safety rules, or behavioral guidelines.

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
  - read
  - bash
---

# Code Review Skill

Detailed instructions for the LLM...
```

The `name` field must be kebab-case (lowercase + hyphens, max 64 chars). It determines the output directory name.

### Where files are written

The target path depends on the configured model:

| Model contains | Instructions path | Skills base dir |
|---|---|---|
| `claude` | `CLAUDE.md` | `.claude/skills/` |
| `codex` | `.codex/instructions.md` | `.agents/skills/` |
| _(anything else)_ | `.opencode/instructions.md` | `.opencode/skills/` |

### `agentCard.skills` vs `memory.skills`

These serve different purposes:

- **`agentCard.skills`** — External metadata for orchestrators. Advertised in the agent card for discovery and routing.
- **`memory.skills`** — Internal instructions for the LLM. Never exposed externally. Teaches the LLM *how* to perform tasks.

Both should be maintained — the agent card tells callers what the agent can do, while memory skills tell the LLM how to do it. Descriptions may differ: agent card skills are high-level and marketing-friendly, memory skills are technical and detailed.

## Calling Other A2A Agents

Expose remote A2A agents as MCP tools by declaring them under `subAgents` in your config. The wrapper spawns [`a2a-mcp-skillmap`](https://www.npmjs.com/package/a2a-mcp-skillmap) ([GitHub](https://github.com/shashikanth-gs/a2a-mcp-skillmap)) as a stdio MCP server and registers it under the reserved `a2a-subagents` key in the resolved `mcp` map. Each remote skill becomes a callable tool the OpenCode LLM can dispatch like any other MCP tool.

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

The OpenCode LLM sees `coding__<skillId>` and `research__<skillId>` tools (one per skill advertised in each sub-agent's card). Tokens may reference environment variables via `${VAR}` syntax — missing variables produce a startup warning and the auth block is omitted (the bridge calls without credentials).

When `subAgents` is absent or `agents` is empty, the wrapper skips every sub-agent code path with no side effects.

See [`agents/multi-agent/`](agents/multi-agent/) for a working example.

## Event Transport (Observability)

Agents emit structured trace events for tool calls and task lifecycle (including a usage summary). By default, these flow as sideband artifacts through the A2A protocol itself — orchestrators discover them via the `urn:x-a2a:trace:v1` extension on the agent card.

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

### Events OpenCode emits

Every event goes through the configured transport (A2A sideband by default, or your HTTP collector / custom transport). Each carries a unique `eventId` (UUID v4), `agentName`, `traceId` and an ISO 8601 `timestamp`.

| Event | When | `data` | A2A sideband artifact |
|---|---|---|---|
| `agent_started` | Once per task, right after the `working` status | `{ "backend": "opencode" }` | `trace.lifecycle` (`state: "started"`) |
| `tool_call_start` / `tool_call_end` | Around each tool call | tool name, sanitized arguments / result, duration | `trace.mcp.start` / `trace.mcp` |
| `agent_finished` | Once, on success, **before** the `completed` status | `{ "backend": "opencode", "usage": <UsageTelemetryData \| null> }` | `trace.lifecycle` (`state: "finished"`) |
| `agent_error` | Once, on failure, before the `failed` status | `{ "backend": "opencode", "message": "…", "usage": <UsageTelemetryData \| null> }` | `trace.lifecycle` (`state: "error"`) |

Exactly one of `agent_finished` / `agent_error` closes each `agent_started`. This is identical on OpenCode 1.x and 2.x.

`usage` has the shared `UsageTelemetryData` shape (the same one `a2a-copilot` reports): totals plus a per-call `calls` log, with one entry per LLM call. An `agent_finished` event as it arrives at an HTTP collector:

```json
{
  "eventId": "6b0e3b0e-4c0a-4d7e-9c1a-2f6d5b1d3a77",
  "eventType": "agent_finished",
  "agentId": "…",
  "agentName": "My OpenCode Agent",
  "traceId": "…",
  "parentAgentId": null,
  "timestamp": "2026-11-19T10:00:00.000Z",
  "data": {
    "backend": "opencode",
    "usage": {
      "llmCalls": 2,
      "model": "opencode/big-pickle",
      "inputTokens": 10344,
      "outputTokens": 20,
      "cacheReadTokens": 10240,
      "cacheWriteTokens": 0,
      "reasoningTokens": 30,
      "durationMs": 6100,
      "cost": 0,
      "calls": [{ "model": "opencode/big-pickle", "inputTokens": 10280, "...": "..." }]
    }
  }
}
```

Usage notes:

- `model` is `provider/model` as OpenCode reports it for the last call.
- `cost` is **OpenCode's own figure** for each call (`0` for free models), summed. It is `null` only when OpenCode reports none; the wrapper never estimates a cost.
- `usage` is `null` when no LLM call was observed, for example when the event stream was unavailable and the polling fallback was used. In `agent_error`, `usage` holds whatever was spent before the failure.
- Usage covers the LLM calls made in the task's own OpenCode session. Calls made by sub-sessions that OpenCode spawns itself (its built-in `task` tool) are not included.
- The terminal event is awaited so it reaches the collector before the task is reported finished, but for at most 2 seconds, so a slow or unreachable collector cannot stall tasks. HTTP delivery is best-effort: a failed POST is logged and not retried.
- A task that is canceled or interrupted closes its lifecycle with one `agent_error` (`"Task canceled"` / `"Turn interrupted"`, with the usage so far). `agent_started` is emitted once the OpenCode session is open.
- With `events.enabled: false` nothing is emitted on any transport.

### Custom transport (programmatic)

For Kafka, Redis, or database sinks, use the programmatic API. See the [`@a2a-wrapper/core` README](https://www.npmjs.com/package/@a2a-wrapper/core) for full details.

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

### Protocol Versions

Speaks **A2A v1.0 natively** and is **fully backward compatible with v0.3.x clients** — no configuration needed. Send `A2A-Version: 1.0` to discover the native v1.0 Agent Card. Send `A2A-Version: 0.3` or `0.3.0`—or omit the header for older clients—to receive the legacy card. JSON-RPC/REST handlers additionally auto-detect native and legacy method shapes. Both versions use the same endpoints below; see [Protocol Versions](../packages/core/README.md#protocol-versions) for the complete negotiation rules and optional Signed Agent Card support.

| Endpoint | Description |
|---|---|
| `GET /.well-known/agent-card.json` | Agent identity and capabilities |
| `POST /a2a/jsonrpc` | JSON-RPC: `message/send`, `message/stream` (v0.3) / `SendMessage`, `SendStreamingMessage` (v1.0) |
| `POST /a2a/rest/message:send` | v1 HTTP+JSON message send |
| `POST /a2a/rest/v1/message:send` | v0.3 HTTP+JSON message send |
| `GET /health` | Health check |
| `POST /context/build` | Trigger context discovery |
| `GET /context` | Read the built context file |

Example JSON-RPC request (`message/send`, v0.3-shaped — still accepted and automatically translated):

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
| [`a2a-claude`](https://www.npmjs.com/package/a2a-claude) | A2A wrapper for Claude |
| [`a2a-codex`](https://www.npmjs.com/package/a2a-codex) | A2A wrapper for OpenAI Codex |
| [`a2a-antigravity`](https://www.npmjs.com/package/a2a-antigravity) | A2A wrapper for Google Antigravity |

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE) © Shashi Kanth
