# A2A Sub-Agents Scenario

A self-contained, runnable example that shows how a parent A2A agent exposes
remote A2A agents as MCP tools using the
[`a2a-mcp-skillmap`](https://www.npmjs.com/package/a2a-mcp-skillmap) bridge.

No LLM, no API keys, no external services required. Everything runs locally.

---

## What this example demonstrates

```
┌─────────────────────────────────────────────────────────────────┐
│                        Parent Agent                             │
│                    (a2a-copilot / a2a-opencode)                 │
│                                                                 │
│  config.json                                                    │
│  └── subAgents:                                                 │
│       ├── coding   → http://127.0.0.1:4101                      │
│       └── research → http://127.0.0.1:4102                      │
│                                                                 │
│  At startup, bootstrapSubAgents():                              │
│   1. Validates the subAgents config                             │
│   2. Writes .a2a/subagents-bridge.json                          │
│   3. Probes both agents (HTTP GET to their card URLs)           │
│   4. Synthesizes an MCP entry: npx a2a-mcp-skillmap --config …  │
│   5. Merges it into the parent's mcp map                        │
│                                                                 │
│  The parent's LLM runtime (Copilot SDK / OpenCode) then sees:  │
│   • coding__review    • coding__explain                         │
│   • research__search  • research__summarize                     │
│   • task_status       • task_result  • task_cancel              │
└─────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐          ┌─────────────────────┐
│  Coding Agent   │          │   Research Agent    │
│  :4101          │          │   :4102             │
│                 │          │                     │
│  Skills:        │          │  Skills:            │
│  • review       │          │  • search           │
│  • explain      │          │  • summarize        │
└─────────────────┘          └─────────────────────┘
```

The bridge (`a2a-mcp-skillmap`) sits between the parent's LLM runtime and the
sub-agents. It fetches each agent's card, projects every skill as an MCP tool,
and handles the A2A ↔ MCP translation transparently.

---

## Prerequisites

- **Node.js ≥ 20** — required by `a2a-mcp-skillmap`
- **Internet access** — `npx` downloads `a2a-mcp-skillmap` on first run
  (subsequent runs use the npx cache)
- This example must be run from inside the **a2a-wrapper monorepo** so it can
  import `@a2a-wrapper/core` via the workspace symlink
- **`@a2a-wrapper/core` must be built first** — the example imports it from
  `packages/core/dist/`, which is git-ignored and **not** produced by
  `npm install`. Build the workspace once from the repo root with
  `npx turbo run build` (or `npm run build`) before running this example

---

## Quick start

```bash
# From the repo root — install deps and build @a2a-wrapper/core the first time
# (its dist/ output is git-ignored and is NOT produced by `npm install`):
npm install
npx turbo run build

cd examples/a2a-subagents-scenario

# Start both sub-agents, run the test, then stop the agents:
./start-all.sh
```

That's it. You should see output like:

```
Starting coding-agent on :4101...
Starting research-agent on :4102...
Both agents are ready.

A2A Sub-Agents Scenario — End-to-End Test
──────────────────────────────────────────

Step 1: Verify sub-agents are reachable
  ✓ coding agent card reachable at :4101
  ✓ research agent card reachable at :4102

Step 2: Bootstrap (validate → write bridge config → probe)
  ℹ workspace: /tmp/a2a-scenario-XXXXXX
  ✓ descriptor.command is 'npx'
  ✓ descriptor uses pinned skillmap version (a2a-mcp-skillmap@0.2.1)
  ✓ bridge config written to absolute path
  ✓ bridge config contains 2 agents
  ✓ bridge config transport is 'stdio'
  ✓ bridge config syncBudgetMs is 30000
  ✓ probe: coding reachable (12ms, HTTP 200)
  ✓ probe: research reachable (5ms, HTTP 200)

Step 3: Spawn a2a-mcp-skillmap bridge via npx
  ℹ command: npx -y a2a-mcp-skillmap@0.2.1 --config /tmp/…/subagents-bridge.json
  ℹ waiting 6s for bridge to start (npx download on first run)...
  ✓ bridge process is still running after startup

Step 4: MCP initialize handshake
  ✓ initialize returned no error
  ✓ server identified as a2a-mcp-skillmap

Step 5: tools/list — verify sub-agent skills are exposed
  ✓ tool "coding__review" is present
  ✓ tool "coding__review" has a description
  ✓ tool "coding__explain" is present
  ✓ tool "coding__explain" has a description
  ✓ tool "research__search" is present
  ✓ tool "research__search" has a description
  ✓ tool "research__summarize" is present
  ✓ tool "research__summarize" has a description

  ℹ All tools exposed by the bridge:
       coding__review
       coding__explain
       research__search
       research__summarize
       task_status
       task_result
       task_cancel

Step 6: Call a tool on each sub-agent
  ℹ calling coding__review...
  ✓ coding__review returned no error
  ✓ coding__review response contains text content
       Response preview: "[coding-agent / review] Reviewed: "function add(a, b) { return a + b; }"..."
  ℹ calling research__search...
  ✓ research__search returned no error
  ✓ research__search response contains text content
       Response preview: "[research-agent / search] Results for: "A2A protocol multi-agent systems"..."

──────────────────────────────────────────
PASS — 26/26 assertions passed
```

---

## Running steps individually

```bash
# Terminal 1 — start the coding sub-agent
node agents/coding-agent.mjs

# Terminal 2 — start the research sub-agent
node agents/research-agent.mjs

# Terminal 3 — run the test (agents must be running first)
node test/run-scenario.mjs
```

Or use the helper script:

```bash
./start-all.sh agents   # start agents only, leave them running
./start-all.sh test     # run test (agents must already be running)
./start-all.sh stop     # stop agents started by this script
```

---

## File structure

```
examples/a2a-subagents-scenario/
│
├── README.md                   ← you are here
├── package.json                ← npm scripts (start:coding, start:research, test)
├── start-all.sh                ← convenience script
│
├── agents/
│   ├── coding-agent.mjs        ← A2A sub-agent: code review + explanation
│   └── research-agent.mjs      ← A2A sub-agent: web search + summarization
│
├── parent/
│   └── config.json             ← parent agent config with subAgents section
│
└── test/
    └── run-scenario.mjs        ← end-to-end test (bootstrap → bridge → MCP)
```

---

## How the sub-agents work

Each agent is a plain Node.js HTTP server with three endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/.well-known/agent-card.json` | GET | A2A agent card — `a2a-mcp-skillmap` fetches this to discover skills |
| `/health` | GET | Health check — used by the startup probe |
| `/a2a/jsonrpc` | POST | A2A JSON-RPC — handles `message/send` calls from the bridge |

The responses are deterministic stubs (no LLM). In a real deployment you'd
replace the `handleSkill()` function with an actual LLM call.

---

## How the parent config works

`parent/config.json` shows the `subAgents` section that wires everything
together:

```json
{
  "subAgents": {
    "agents": [
      {
        "name": "coding",
        "agentCardUrl": "http://127.0.0.1:4101/.well-known/agent-card.json"
      },
      {
        "name": "research",
        "agentCardUrl": "http://127.0.0.1:4102/.well-known/agent-card.json"
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

Key fields:

| Field | What it does |
|---|---|
| `name` | Prefix for MCP tool names: `coding__review`, `coding__explain` |
| `agentCardUrl` | Where the bridge fetches the agent's skill card |
| `responseMode` | How the bridge shapes A2A responses into MCP content blocks. `"artifact"` (default) unwraps each A2A artifact part into a native MCP content block |
| `probeTimeoutMs` | How long the parent waits for each agent's card URL to respond at startup |
| `syncBudgetMs` | How long the bridge waits for an A2A response before returning a task handle for async polling. `30000` = 30 s |

---

## What the MCP tools look like

After bootstrap, the parent's LLM runtime sees these tools:

| Tool | Source | Description |
|---|---|---|
| `coding__review` | coding-agent | Review a code snippet for issues |
| `coding__explain` | coding-agent | Explain what code does in plain English |
| `research__search` | research-agent | Search for information on a topic |
| `research__summarize` | research-agent | Summarize a document into key points |
| `task_status` | bridge | Poll the state of a long-running task |
| `task_result` | bridge | Retrieve the result of a completed task |
| `task_cancel` | bridge | Cancel a running task |

The `task_*` tools are provided by `a2a-mcp-skillmap` automatically. They
handle the async case: if an A2A agent takes longer than `syncBudgetMs` to
respond, the bridge returns a `taskId` immediately and the LLM can poll via
`task_result` / `task_status` rather than blocking.

---

## Adding your own sub-agent

1. Copy one of the agent files and change the `AGENT_CARD` and `handleSkill()`
   function to match your agent's capabilities.
2. Add an entry to `parent/config.json` under `subAgents.agents`.
3. Run `./start-all.sh` — the new agent's skills will appear automatically.

For a real agent (with an LLM), replace the stub `handleSkill()` with a call
to your LLM provider. The A2A JSON-RPC contract stays the same.

**Important:** A2A artifact parts use `kind` (not `type`) to identify the
content type. The `a2a-mcp-skillmap` bridge reads `part.kind` when projecting
artifacts into MCP content blocks:

```js
// ✓ Correct — A2A spec uses `kind`
{ kind: "text", text: "Hello from the agent" }

// ✗ Wrong — `type` is the MCP field name, not A2A
{ type: "text", text: "Hello from the agent" }
```

---

## Troubleshooting

**`npx` takes a long time on first run**
The test waits 6 seconds for the bridge to start. On a slow connection or
cold npx cache this may not be enough. Increase the wait in
`test/run-scenario.mjs` (search for `setTimeout(r, 6000)`).

**`ERR_MODULE_NOT_FOUND` for `@a2a-wrapper/core/dist/index.js`**
`@a2a-wrapper/core` hasn't been compiled yet — its `dist/` output is
git-ignored and is **not** produced by `npm install`. Build the workspace
from the repo root, then re-run:
```bash
npx turbo run build      # or: npm run build
./start-all.sh
```

**`bootstrapSubAgents is not a function`**
Make sure you're running from inside the monorepo where `@a2a-wrapper/core`
is available via the workspace symlink. Run `npm install` at the repo root
if needed (and `npx turbo run build` to compile it).

**Probe fails with `ECONNREFUSED`**
One of the sub-agents isn't running. Start it first:
```bash
node agents/coding-agent.mjs    # terminal 1
node agents/research-agent.mjs  # terminal 2
```

**Bridge exits immediately with code 0**
This was a bug in `a2a-mcp-skillmap@0.1.0` on macOS (the `/tmp → /private/tmp`
symlink caused the CLI entry-point guard to fail). It's fixed in `0.2.0+`.
The version pinned in this repo (`SKILLMAP_PACKAGE_VERSION` in
`packages/core/src/sub-agents/version.ts`) is always a known-good release.

---

## Related

- [`packages/core/src/sub-agents/`](../../packages/core/src/sub-agents/) — the bootstrap pipeline implementation
- [`a2a-copilot/agents/multi-agent/`](../../a2a-copilot/agents/multi-agent/) — multi-agent config for a real Copilot parent
- [`a2a-opencode/agents/multi-agent/`](../../a2a-opencode/agents/multi-agent/) — multi-agent config for a real OpenCode parent
- [`a2a-mcp-skillmap` on npm](https://www.npmjs.com/package/a2a-mcp-skillmap) — the bridge package
- [`a2a-mcp-skillmap` on GitHub](https://github.com/shashikanth-gs/a2a-mcp-skillmap) — source, full docs, config schema reference, response modes, session continuity, sync budget, OpenTelemetry
- [A2A protocol spec](https://github.com/google-deepmind/a2a) — the underlying agent-to-agent protocol
