---
"a2a-claude": major
---

a2a-claude is now built on `@a2a-wrapper/core`'s provider contract and no longer depends on `@a2a-js/sdk` (#111, epic #81). Core owns everything A2A (task lifecycle, cancel ordering, queueing, input-required, the persisted context binding); the wrapper only drives the Claude Agent SDK. Observable A2A behaviour is unchanged (agent card, `message/send` and `message/stream` results, artifact names and chunks, `trace.*` artifacts, `x-usage`, rate-limit and background-task behaviour, multi-turn by `contextId`, MCP servers, sub-agents, config, CLI and env), proved by a golden test against the previous executor (46 recorded streams and tasks over 24 scripted Claude sessions).

## Breaking

- `ClaudeExecutor`, `SessionManager` and `promptStream` are removed from the public API (`a2a-claude` and `a2a-claude/claude`), with no shim. `ClaudeProvider` replaces them: it implements `ProviderExecutor` of `@a2a-wrapper/core` (`run`, `steer`, `abort`, `probeSession`, ...), not the SDK's `AgentExecutor`. Code that called `executor.execute(ctx, bus)` or `cancelTask` must go through the server (or core's `RunRegistry` / `CoreExecutor`).
- `createA2AServer(config)` now takes `(config, { runStore?, eventTransport? })` and returns `{ provider, registry, ... }` (a `ProviderServerHandle`) instead of a handle whose `executor` was a `ClaudeExecutor`; `handle.executor` is core's executor. `buildContext` is on `handle.provider`.
- The package no longer declares `@a2a-js/sdk` (core still lists it as a peer dependency).
- `x-usage` cost is now the cost of the turn. The SDK's `total_cost_usd` is a running total of the Claude session, and earlier releases reported it as the cost of every task (and once per round of a held-open task). The first task of a session is unchanged; later ones now report the difference.

Small, additive differences in what a client sees: the redundant `submitted` status after the initial task snapshot is gone; the completed status also carries `urn:a2a-wrapper:usage:v1` (with a per-model breakdown); a failed status carries `code` (`backend`, `timeout`, `rate_limit`) and a rate limit `retryable`; a task that had a message steered in can carry `x-usage` on a non-final `working` status (read `x-usage` from the completed status).

## New

- **Steering**: a message to a running task with delivery `steer` is pushed into the running query with the SDK's streaming-input `priority: "next"` and answered `inserted` or `queued` (honestly, from the CLI's own `command_lifecycle` frames and `user_message_uuids`); `interrupt` asks the CLI to end the turn and runs the message next on the same session; `queue` runs it as the next turn of the same task.
- **Resume across turns and restarts**: the Claude session id is bound to the `contextId` (`run.bind`, as soon as the CLI reports it, before the first output) and resumed with the SDK's `resume` option; a session the CLI no longer has starts a fresh one. **A restart keeps conversations only with a durable run store** (`createA2AServer(config, { runStore })`); the default store is in memory, so nothing survives a restart until a durable store exists (#69).
- **Permissions and questions through the A2A client**: the new `interactions` config section (`mode`, `timeoutMs`, `onTimeout`, `autoAnswer`; `--interactions`, `INTERACTIONS_MODE`). The default (`auto`, no rules) installs nothing and keeps today's behaviour (`claude.permissionMode` decides). With `ask`, permission requests and `AskUserQuestion` arrive as `input-required`, the task resumes on the reply, and `claude.permissionMode: "default"` is accepted.
- `timeouts.steerAck` and `session.idleTtl` (optional idle expiry, unset by default). `session.ttl` keeps its meaning: the maximum age of a context's session, measured from its creation and never extended by use (`0` disables it); `session.cleanupInterval` still sweeps contexts idle for longer than `ttl`.
