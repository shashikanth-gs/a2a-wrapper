---
"a2a-copilot": major
---

a2a-copilot is now built on `@a2a-wrapper/core`'s provider contract and no longer depends on `@a2a-js/sdk` (#111, epic #81). Core owns everything A2A (task lifecycle, cancel ordering, queueing, input-required, the persisted context binding); the wrapper only drives the Copilot SDK. Observable A2A behaviour is unchanged (agent card, `message/send` and `message/stream` results, artifact names and chunks, `trace.*` artifacts, `x-usage`, usage telemetry, multi-turn by `contextId`, MCP servers, custom agents, sub-agents, config, CLI and env), proved by a golden test against the previous executor.

## Breaking

- `CopilotExecutor` and `SessionManager` are removed from the public API (`a2a-copilot` and `a2a-copilot/copilot`), with no shim. `CopilotProvider` replaces them: it implements `ProviderExecutor` of `@a2a-wrapper/core` (`run`, `steer`, `abort`, `release`, `probeSession`, ...), not the SDK's `AgentExecutor`. Code that called `executor.execute(ctx, bus)` or `cancelTask` must go through the server (or core's `RunRegistry` / `CoreExecutor`).
- `createA2AServer(config)` now takes `(config, { runStore?, eventTransport? })` and returns `{ provider, registry, ... }` (a `ProviderServerHandle`) instead of a handle whose `executor` was a `CopilotExecutor`; `handle.executor` is core's executor.
- The package no longer declares `@a2a-js/sdk` (core still lists it as a peer dependency).

Small, additive differences in what a client sees: the redundant `submitted` status after the initial task snapshot is gone; the completed status also carries `urn:a2a-wrapper:usage:v1`; a failed status carries `code`; `agent_started` is published after the Copilot session opens; a task that had a message steered in can carry `x-usage` on a non-final `working` status (read `x-usage` from the completed status).

## New

- **Steering**: a message to a running task with delivery `steer` is sent with Copilot's native `mode: "immediate"` and answered `inserted` or `queued`; `interrupt` aborts the turn (keeping Copilot's queue) and runs the message next; `cancel` flushes the queue.
- **Resume across turns and restarts**: the Copilot session id is bound to the `contextId` (`run.bind`) and resumed with `resumeSession`; a session Copilot no longer has starts a fresh one. **A restart keeps conversations only with a durable run store** (`createA2AServer(config, { runStore })`); the default store is in memory, so nothing survives a restart until a durable store exists (#69).
- **Permissions and questions through the A2A client**: the new `interactions` config section (`mode`, `timeoutMs`, `onTimeout`, `autoAnswer`; `--interactions`, `INTERACTIONS_MODE`). The default (`auto`) keeps today's behaviour: nobody is asked and every permission is approved. With `ask`, permission requests (and `ask_user` questions) arrive as `input-required` and the task resumes on the reply.
- `timeouts.steerAck` and `session.idleTtl` (optional idle expiry, unset by default). `session.ttl` keeps its meaning: the maximum age of a context's session (a context is resumed only while its session is younger than `ttl`, however recently it was used).
