---
"@a2a-wrapper/core": minor
---

Core pieces a wrapper needs to implement `ProviderExecutor` without touching the A2A SDK or an event bus (#111), all additive; wrappers still on the bus-based executor are unaffected.

- `RunObservability`: the run-scoped replacement for `createExecutionObservability` + the usage accumulator plumbing. Its sideband emitter publishes the same `trace.*` artifacts through `run.artifact` (new `RunTransport`), `recordCall` / `setContextWindow` feed the usage accumulator (and `trace.usage` / `context_window` with `trackUsage`), and `finish()` / `error()` / `canceled()` close the lifecycle with exactly one terminal event (bounded wait) and return the `x-usage` metadata and the same totals as a `CoreUsage`.
- `createResponseStream`: the `response-<uuid>` artifact (chunked or buffered) wrappers publish today, on a run.
- `CoreArtifact.extensions` (rendered as the artifact's extension URIs), `corePartsText`, `InteractionsConfig` (the `interactions` config section: mode, timeouts, auto-answer rules), `resolveTransportWith` and `agentEventToTrace` (the shared A2A trace rendering).
- `createProviderServer`: `createA2AServer` for a provider (builds the run runtime and the core executor).
- Test harness for wrappers (`createProviderTestServer`, `createTestServer`, `summarizeEvent`, `summarizeTask`): serves a provider through the real SDK request handler and returns plain-data summaries, so wrapper tests need no SDK import.
- `RunRegistryOptions.bindingMaxAgeMs`: a hard maximum age of a context binding, measured from `createdAt` and never extended by use (an over-age binding is deleted and released at resume, same path as the idle TTL, and removed by `sweepBindings`). Independent of `bindingTtlMs`.
- `run.settleSteer(handle, "inserted" | "dropped")`: records the real delivery of a provider-held steer after the fact (record `done` or `dropped`, handle no longer held, no turn started; idempotent, silent after a cancel).
- The `unavailable` outcome of `run.ask` carries a typed `code` (`policy-auto`, `interactions-disabled`, `invalid-request`, `internal`; open union, `reason` text unchanged) so a provider need not read its own configuration to decide approve or deny.
