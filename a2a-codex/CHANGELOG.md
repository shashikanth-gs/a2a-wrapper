# a2a-codex

## 1.8.0

### Minor Changes

- f6efa31: feat(otel): opt-in Langfuse and Phoenix attribute sets (`otel.compat`)

  - New `otel.compat: ["langfuse", "openinference"]` (env `A2A_OTEL_COMPAT`, default none). Adds `langfuse.observation.type` and the OpenInference `openinference.span.kind`, `agent.name`, `graph.node.*` (parent edge only when a parent agent is known) to the request span, and the tool equivalents to mirrored tool spans, so Langfuse and Phoenix draw their agent views.
  - Standard attributes are never changed; with no compat selected the attribute set is identical to before.
  - Content (`input.value`/`output.value`) and `llm.token_count.*` are intentionally not added.
  - The JSON Schema of every wrapper gains `otel.compat`.

- dda8404: feat(events): event attribution, `events.transport: "both"`, and `${VAR}` in event settings

  - New `events.transport: "both"` sends each event to the A2A sideband and the HTTP collector with the same `eventId`; a failing collector never blocks the A2A copy.
  - `events.httpUrl` and `events.httpHeaders` values support `${VAR}` substitution (unset variable: left as written, warned once, value never logged). New env overrides `A2A_EVENTS_TRANSPORT` and `A2A_EVENTS_HTTP_URL`.
  - Every event now carries the orchestrator's `propagatedMetadata` (bounded to 64 keys / 8 KB, key charset `[A-Za-z0-9_.-]`, secret-looking keys redacted).
  - A2A trace artifacts gain `eventId`, `parentAgentId`, `otelTraceId`, `otelSpanId` in metadata and `event_id`, `parent_agent_id`, `propagated_metadata` in data.
  - The JSON Schema of every wrapper accepts `events.transport: "both"`.

- 079ce38: feat(otel): join the caller's distributed trace (design: `docs/design/distributed-tracing.md`)

  - `a2a.task.execute` now continues the W3C `traceparent` / `tracestate` sent by the caller (HTTP header for JSON-RPC and REST, message metadata as fallback), with strict validation.
  - Behaviour change: the request span is now `SpanKind.SERVER`. When `@opentelemetry/instrumentation-http` is active the span nests under the HTTP SERVER span as `INTERNAL` instead (`otel.span.server: "auto"`), so there are no duplicate SERVER spans.
  - New config: `otel.propagation.{inbound,trustedPeers,untrusted,carriers}`, `otel.span.{server,enrichServerSpan}`, `otel.exporter.headers`, `server.trustProxy`; env overrides `A2A_OTEL_INBOUND`, `A2A_OTEL_TRUSTED_PEERS`, `A2A_OTEL_UNTRUSTED`, `A2A_OTEL_CARRIERS`, `A2A_OTEL_SERVER_SPAN`, `A2A_OTEL_ENRICH_SERVER_SPAN`.
  - Trust: `trustedPeers` limits who may supply trace context; the caller address is set by the server from the socket (a client `x-a2a-peer` header is overwritten). Untrusted callers get `restart` (new trace plus span link) or `ignore`.
  - Request spans record `a2a.propagation.policy` and `a2a.propagation.source`.
  - Event-transport events and A2A artifact data carry `otelTraceId` / `otelSpanId`.
  - The JSON Schema of every wrapper gains the new `otel` and `server` fields.

- a2bfdd2: feat(otel): Phase 3 backend passthrough (Hook F)

  - Core helpers: Copilot telemetry/onGetTraceContext, Claude OTel env + TRACEPARENT, Codex otel overrides
  - `withSpan` activates real OTel context so parent-link works
  - Shared `otel.exporter` endpoint inheritance
  - Wire Copilot / Claude / Codex; OpenCode/Antigravity documented

- a2bfdd2: feat(otel): Phase 5 attribute ownership + gateway ID mapping

  - docs/otel-attribute-ownership.md aligned with draft GenAI A2A #254
  - Span attrs: gen_ai.operation.name, a2a.method.name, session.id, a2a.gateway.\*
  - extractA2ATraceContext reads conversation/session/passkey/spectrum/ticket metadata
  - Claude + Codex applyUsageSummaryToActiveSpan + x-usage on completed turns

- a2bfdd2: feat(otel): Phoenix demo, package identity attrs, usage flags

  - Replace Jaeger compose requirement with Arize Phoenix (`phoenix serve`, optional Docker)
  - CLI bootstrap defaults to `http/protobuf` via `@opentelemetry/exporter-trace-otlp-proto` (Phoenix rejects JSON)
  - Stamp `a2a.wrapper.core.version`, `a2a.wrapper.sdk`, `a2a.wrapper.sdk.version` on task spans
  - Wire all wrapper servers with package name/version
  - `otel.taskUsageRollup` (default true) + `otel.annotateUsageCalls` (default false; Claude/Codex per-call events)
  - Smoke scripts: `examples/otel-stack/smoke-export.mjs` + `smoke-providers.mjs` (copilot/claude executor → Phoenix)

- 55b2f9d: feat(otel): opt-in OpenTelemetry GenAI span names (`otel.spanNaming`)

  - New `otel.spanNaming: "legacy" | "semconv"` (env `A2A_OTEL_SPAN_NAMING`, default `legacy`). `semconv` names the request span `invoke_agent {agent}` and mirrored tool spans `execute_tool {tool}`; the default is unchanged.
  - Only names change, attributes are identical in both modes, and `a2a.task.cancel` is never renamed.
  - The JSON Schema of every wrapper gains `otel.spanNaming`.

### Patch Changes

- 1bdaa60: Fix `subAgents` startup failure ("MCP server key "a2a-subagents" is reserved") by validating only user-supplied MCP servers before the internal bridge entry is merged. Add `defaultToolsApprovalMode` / `toolApprovalModes` to MCP server config (mapped to Codex `default_tools_approval_mode` and `tools.<name>.approval_mode`) so MCP tools can be pre-approved in headless mode with `approvalPolicy: "never"`; the sub-agent bridge is pre-approved automatically.
- a2bfdd2: feat(otel): BYOK cookout + shared mock-ollama; wire CLI OTel bootstrap

  - examples/mock-ollama/ — reusable fake Ollama (OpenAI + Anthropic) for any cookout
  - examples/otel-stack/cookout-byok.mjs layers Phoenix/OTel on that stub
  - Hand-rolled wrapper CLIs now call bootstrapOtelSdkFromConfig / shutdownOtelSdk
  - CLI bootstrap uses SimpleSpanProcessor for reliable short-lived export

- a2bfdd2: fix(otel): per-wrapper OTel schema — common at top, backend knobs only for that package

  OpenCode no longer advertises `otel.backend.codex` (and peers). Shared flags stay
  on `otel.*`; only `otel.backend.<this-wrapper>` appears in each agent schema.

- a2bfdd2: feat(otel): Phase 2 usage mapping + shared execution observability

  - Hook E: `applyUsageSummaryToActiveSpan` with anti-dupe policy — `a2a.task.usage.*` rollup always; `gen_ai.usage.*` only when backend OTel is off
  - Hook B: `createExecutionObservability` adopted by all wrappers
  - Hook C: `annotateSessionOnTaskSpan`; W3C `injectW3cTraceHeaders` for outbound calls
  - Docs: usage double-count rules in `docs/observability.md`

- Updated dependencies [a2bfdd2]
- Updated dependencies [f6efa31]
- Updated dependencies [a2bfdd2]
- Updated dependencies [dda8404]
- Updated dependencies [079ce38]
- Updated dependencies [a2bfdd2]
- Updated dependencies [a2bfdd2]
- Updated dependencies [a2bfdd2]
- Updated dependencies [a2bfdd2]
- Updated dependencies [a2bfdd2]
- Updated dependencies [a2bfdd2]
- Updated dependencies [55b2f9d]
- Updated dependencies [98d2027]
  - @a2a-wrapper/core@2.2.0

## 1.7.2

### Patch Changes

- 4e2bd82: No code changes. A prior release run published every package's exact
  target version under the `canary` npm dist-tag instead of `latest` (the
  `canary` job's snapshot step no-ops when there are no pending changesets,
  which was the case immediately after that Version Packages PR merged —
  see the canary-job fix in a preceding commit). Since npm never allows
  republishing an already-used version string, the only way to get a
  `latest`-tagged release out is a fresh patch bump.
- Updated dependencies [4e2bd82]
  - @a2a-wrapper/core@2.1.1

## 1.7.1

### Minor Changes

- d6c2701: Add native A2A protocol v1.0 support, built on `@a2a-js/sdk@1.0.0`, while preserving full backward compatibility with A2A v0.3.x clients.

  **`@a2a-wrapper/core` (breaking):**

  - `buildAgentCard()` now produces the native v1.0 `AgentCard` shape (`supportedInterfaces[]` instead of `url`/`additionalInterfaces`/`protocolVersion`; `capabilities.extendedAgentCard` instead of `supportsAuthenticatedExtendedCard`; `stateTransitionHistory` removed). Callers reading the old v0.3 fields directly off the return value must update — the server itself still serves a fully v0.3-shaped card to legacy clients (see below).
  - `createA2AServer()`'s JSON-RPC/REST transports and the `/.well-known/agent-card.json` route now negotiate protocol version per-request via the `A2A-Version` header: `1.0`/absent-with-recent-header gets the native v1.0 card and wire shapes, while `0.3`/no-header-at-all (matching the SDK's own default) gets a fully v0.3-shaped card and JSON-RPC/REST translation via `@a2a-js/sdk`'s `compat/v0_3` layer.
  - `ServerOptions.protocolVersion` default changed from `"0.3"` to `"1.0"`.
  - New `ServerOptions.onListening` hook and `ServerOptions.agentCardSigning` option (Signed Agent Cards, RFC 7515 JWS, opt-in via `AgentCardConfig.signing` or the programmatic option).
  - New `extractUserText(message)` export centralizing inbound `Part` parsing for the v1.0 proto-oneof `Part` shape.
  - `TaskState` is now re-exported as a value (real numeric enum in v1.0, was a string-literal type in v0.3).
  - `@a2a-js/sdk` peer/dev dependency bumped to `^1.0.0`.

  **Wrapper packages (`a2a-claude`, `a2a-codex`, `a2a-copilot`, `a2a-opencode`, `a2a-antigravity`):**

  - Each wrapper's `createA2AServer()` public API is unchanged, but is now a thin delegate to `@a2a-wrapper/core`'s `createA2AServer` instead of duplicating Express/SDK server wiring — restoring the "A2A protocol code lives only in core" design.
  - `a2a-copilot` and `a2a-opencode` no longer ship their own local `event-publisher.ts`; both now use `@a2a-wrapper/core`'s (v1.0-aware) event publisher.
  - `@a2a-js/sdk` dependency bumped to `^1.0.0` (previously an inconsistent mix of `^0.3.9`/`^0.3.13`).

### Patch Changes

- Updated dependencies [f3c7062]
- Updated dependencies [41e2d82]
- Updated dependencies [d6c2701]
  - @a2a-wrapper/core@2.1.0

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
