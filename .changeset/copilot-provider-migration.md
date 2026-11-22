---
"a2a-copilot": minor
---

a2a-copilot is now built on `@a2a-wrapper/core`'s provider contract and no longer depends on `@a2a-js/sdk` (#111, epic #81). Core owns everything A2A (task lifecycle, cancel ordering, queueing, input-required, the persisted context binding); the wrapper only drives the Copilot SDK. Observable A2A behaviour is unchanged (agent card, `message/send` and `message/stream` results, artifact names and chunks, `trace.*` artifacts, `x-usage`, usage telemetry, multi-turn by `contextId`, MCP servers, custom agents, sub-agents, config, CLI and env), proved by a golden test against the previous executor. Differences, all additive: the redundant `submitted` status after the initial task snapshot is gone; the completed status also carries `urn:a2a-wrapper:usage:v1`; a failed status carries `code`.

New:

- **Steering**: a message to a running task with delivery `steer` is sent with Copilot's native `mode: "immediate"` and answered `inserted` or `queued`; `interrupt` aborts the turn (keeping Copilot's queue) and runs the message next; `cancel` flushes the queue.
- **Resume across turns and restarts**: the Copilot session id is bound to the `contextId` (`run.bind`) and resumed with `resumeSession`; a session Copilot no longer has starts a fresh one. A restart keeps the conversation when a persistent run store is supplied (`createA2AServer(config, { runStore })`; the default store is in memory).
- **Permissions and questions through the A2A client**: the new `interactions` config section (`mode`, `timeoutMs`, `onTimeout`, `autoAnswer` rules; `--interactions`, `INTERACTIONS_MODE`). The default (`auto`) keeps today's behaviour: nobody is asked and every permission is approved. With `ask`, permission requests (and `ask_user` questions) arrive as `input-required` and the task resumes on the reply.
- `timeouts.steerAck`; `session.ttl` now measures the time since a context was last used (it used to measure the age of the session).

Breaking for programmatic users: `CopilotExecutor` and `SessionManager` are replaced by `CopilotProvider` (a `ProviderExecutor`); `createA2AServer` returns `provider` and `registry` instead of an `executor` that implements the SDK's `AgentExecutor`.
