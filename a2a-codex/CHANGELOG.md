# a2a-codex

## 1.6.1

### Patch Changes

- Updated dependencies
  - @a2a-wrapper/core@1.7.0

## 1.6.0

### Minor Changes

Initial release of `a2a-codex` — an A2A protocol wrapper for the OpenAI Codex SDK.

**Features:**

- **A2A-compliant server** — JSON-RPC and REST transports via `@a2a-js/sdk`, Agent Card at `/.well-known/agent-card.json`, health endpoint at `/health`
- **OpenAI Codex SDK integration** — backs every A2A task with a Codex thread (`@openai/codex-sdk`); supports `workspace-write`, `read-only`, and `danger-full-access` sandbox modes
- **Multi-turn context continuity** — each A2A `contextId` maps to a persistent Codex thread; turns are serialized per-context via a promise queue
- **AbortController cancellation** — `cancelTask` aborts the in-flight `runStreamed` call and publishes a `canceled` status
- **MCP tool support** — stdio and http transports; config baked at SDK construction time; `${ENV_VAR}` substitution in args/env/headers
- **Multi-agent delegation** — A2A sub-agents auto-bootstrapped via `bootstrapSubAgents` from `@a2a-wrapper/core`; synthesized as an MCP server entry before client construction
- **Sideband events** — reasoning summaries, command events, file-change events, and trace artifacts emitted through `AgentEventEmitter`
- **Streaming artifacts** — opt-in delta streaming via `features.streamArtifactChunks`; buffered artifact mode (Inspector-compatible) by default
- **Memory materialization** — memory files written to workspace before each session
- **JSON config** — `config.json` driven with `${ENV_VAR}` token substitution; precedence: defaults ← file ← env ← CLI
- **CLI** — `a2a-codex --config agents/example/config.json`; individual flags: `--port`, `--workspace`, `--model`, `--sandbox`, `--log-level`, etc.
- **Context API** — `GET /context` to read a context file; `POST /context/build` to generate one via a read-only Codex thread
- **Bundled example agents** — `agents/example/` (workspace engineer), `agents/read-only-reviewer/` (code review), `agents/multi-agent/` (lead engineer with sub-agent delegation)
