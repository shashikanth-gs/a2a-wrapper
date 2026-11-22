# a2a-antigravity

## 0.3.0

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

- dc4be8a: chore(deps): upgrade `@a2a-js/sdk` to ^1.3.0

  - Bumps the SDK range (dependency and peer range in core) from ^1.0.0 to ^1.3.0
  - core: the SDK now routes v0.3 JSON-RPC requests by an exact `A2A-Version: 0.3` header; `createA2AServer` normalizes `0.3.x` values (e.g. `0.3.0`) to `0.3` so legacy clients keep working

- 5420063: Upgrade the pinned `google-antigravity` Python SDK from 0.1.5 to 0.1.24 (#87). The bridge now passes `capabilities.compactionThreshold` through `CompactionConfig` on the agent config, because `CapabilitiesConfig.compaction_threshold` is deprecated in the SDK. Python >=3.10 is still supported. Note the SDK's own changes: `ASK_QUESTION` is no longer in the default tool set, and the built-in `START_SUBAGENT` tool was renamed `INVOKE_SUBAGENT`.
- 8a7e7d3: Default `model` is now `auto` everywhere: no wrapper pins a model name in code (#95).

  - Core: new `AUTO_MODEL`, `isAutoModel` and `normalizeModel`. Unset, empty, `auto` and `default` (any case) all mean "let the provider choose".
  - a2a-copilot: the default changes from `claude-sonnet-4.5` to `auto`, passed as the literal `auto`, which the Copilot runtime accepts (the old default is rejected by the runtime bundled with `@github/copilot-sdk` 1.0.34). Example configs no longer pin models. A custom BYOK provider still requires an explicit model.
  - a2a-codex: `auto` (the new default) picks the first model Codex lists for the logged-in account (`codex debug models`, then the `models_cache.json` fallback, then Codex's own default), so a stale model pinned in `~/.codex/config.toml` is no longer inherited. Explicit names still win.
  - a2a-claude, a2a-opencode, a2a-antigravity: `auto`/`default`/empty resolve to unset so the backend applies its own default.

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

- Updated dependencies [dc4be8a]
- Updated dependencies [ba063f9]
- Updated dependencies [8a7e7d3]
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

## 0.2.2

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

## 0.2.1

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

## 0.1.1

### Patch Changes

Initial release of `a2a-antigravity`, an A2A protocol wrapper for Google Antigravity.

This package exposes Antigravity as a standalone HTTP A2A agent while keeping the public wrapper in Node/TypeScript. The Google Antigravity SDK remains isolated behind a private Python subprocess and JSONL bridge.

**Features:**

- **A2A-compliant server** - Agent Card, JSON-RPC, REST, and health endpoints via `@a2a-js/sdk`.
- **Google Antigravity SDK integration** - backed by `google-antigravity==0.1.5` through a private Python bridge.
- **Managed Python setup** - `a2a-antigravity setup` creates a virtual environment, installs bundled requirements, and verifies `google.antigravity` imports.
- **Gemini and Vertex auth** - supports Gemini API key auth and Vertex/ADC project/location configuration.
- **Tested Flash-Lite model** - example configs use `gemini-3.1-flash-lite`.
- **Command policy examples** - default config keeps SDK command policy defaults; `config.run-command.json` demonstrates trusted-workspace `run_command` enablement.
- **Sideband trace artifacts** - lifecycle, tool-start, usage, error, and response artifacts are mapped into A2A trace artifacts.
- **MCP passthrough** - stdio and Streamable HTTP MCP server configs are translated into Antigravity SDK config.
- **Memory materialization** - memory files are written to `AGENTS.md` and `.antigravity/skills/` before session startup.
- **A2A sub-agent delegation** - sub-agents are exposed through the shared `a2a-mcp-skillmap` bridge.
- **Subprocess lifecycle hardening** - bridge spawn errors, unexpected exits, write failures, shutdown, and signal handling are surfaced cleanly instead of hanging requests.
- **CI coverage** - GitHub Actions verifies TypeScript build/test plus managed Python setup and package contents before publish.

**Operational notes:**

- The default A2A port is `3040`, intentionally offset from `a2a-claude` on `3030`.
- The npm package does not run `pip` during install. Run `a2a-antigravity setup` once before starting the server, or provide your own Python with `ANTIGRAVITY_PYTHON`.
- `run_command` is denied by the Antigravity SDK default policy unless explicitly allowed.
