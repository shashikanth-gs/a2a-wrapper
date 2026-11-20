# Distributed tracing across agents: design and plan

| | |
|---|---|
| **Status** | Proposal (for review) |
| **Date** | 2026-11-19 |
| **Issues** | [#49](https://github.com/shashikanth-gs/a2a-wrapper/issues/49) (caller correlation context), [#40](https://github.com/shashikanth-gs/a2a-wrapper/issues/40) (OpenTelemetry) |
| **Builds on** | #52 (OTel phases 1–5), [`observability.md`](../observability.md), [`otel-attribute-ownership.md`](../otel-attribute-ownership.md) |
| **Code state described** | `main` at `838c207` |

Evidence labels used throughout: **[code]** read in this repository, **[docs]** read directly from the cited page, **[summary]** read through a fetch-tool summary (verify before coding against it), **[unverified]** not established. All external references are listed in [section 12](#12-references).

---

## 1. Summary

Any `a2a-*` agent can be the **caller** of another agent (through `a2a-mcp-skillmap`), or be called by an **outside** agent (LangGraph, Google ADK, a custom orchestrator such as Krama). Operators want one trace graph across those hops, visible in **Langfuse**, **Arize Phoenix** and **Grafana Tempo** (with Grafana's AI observability), and they want events attributable to the request that caused them.

Today the wrappers do not join a caller's trace: an inbound `traceparent` is never read, so every hop starts a new trace and the link between hops is only an attribute. This document decides the **bare minimum** to fix that, based on what the three backends actually need and what outside agents actually send.

### Decisions

| # | Decision | Why (short) |
|---|---|---|
| **D1** | **W3C Trace Context is the interoperability contract.** Read it from HTTP headers first, then from message metadata, then fall back to today's legacy ids. | It is the only mechanism all three backends and every OTel-instrumented caller share. The A2A spec only *recommends* it ([R18]), and the A2A semantic conventions explicitly left propagation out of scope ([R10]), so we must accept more than one carrier. |
| **D2** | **Configurable inbound policy `continue \| restart \| ignore`** (the vocabulary Elastic and Datadog use), default `continue`, plus optional **trusted peers**: callers outside a CIDR list are downgraded to `restart`. | Parenting is what produces a connected graph. Every surveyed product defaults to continuing the trace but exposes the choice, because unauthenticated endpoints let callers choose trace ids and sampling ([R27], [R28], [R29], [R30], [R31]). Analysis: 9.1.1. |
| **D3** | The request span becomes **`SERVER` kind** when we own the server side, and **nests** (INTERNAL) under an existing HTTP server span when the host has HTTP instrumentation (`otel.span.server: auto`). Span *names* stay as today by default, with an opt-in `semconv` naming mode. | Tempo's service graph needs CLIENT/SERVER pairs ([R20]). Measured: an always-extract design creates a duplicate SERVER span next to HTTP auto-instrumentation (Appendix A). Renaming spans would silently break existing dashboards, so it is opt-in. |
| **D4** | Context reaches sub-agents through **both carriers the backends actually use**: MCP `_meta.traceparent` (SEP-414; Copilot) and an HTTP `traceparent` header (Claude Code). Backends that forward nothing are served by a **wrapper-side correlation registry** keyed by the ids they do send (`claudecode/toolUseId`, `ai.opencode/sessionID`). Needs a companion change in `a2a-mcp-skillmap`. | Measured on real runs (Appendix B): per-call context appears only with the backend's tracing on, and differs by backend; OpenCode forwards none. A registry is much smaller than a second MCP server per session. |
| **D5** | Sideband events carry the **real W3C trace and span id**, plus `propagatedMetadata`; add `eventId`/`parentAgentId` to the A2A artifact; add `events.transport: "both"`; substitute `${VAR}` in event headers and exporter headers. | Today `AgentEvent.traceId` is the orchestrator's id or the `contextId`, so sideband events cannot be joined to our own spans [code]. |
| **D6** | **Platform "graph" views via opt-in compat attributes** (`langfuse.*`, `openinference.*`), not by changing the standard attributes. | Langfuse and Phoenix key their agent views on their own attributes; Phoenix says `gen_ai.*` spans "won't get the same UI treatment" ([R22]). |
| **D7** | **No wrapper-emitted metrics by default.** `otel.metrics.profile` (`none`, `genai-semconv`, `grafana-agent`) is reserved for opt-in later. | Verified in Grafana's dashboard definitions: **every** AI dashboard is Prometheus/Loki-driven (none works from traces alone) and the agent panels use OpenLIT vendor metric names ([R33], [R34]). Tempo, Langfuse and Phoenix derive what they need from spans. Analysis: 9.1.3. |
| **D8** | We do **not** implement LangSmith-style or ADK-style proprietary propagation. Outside agents are supported through W3C `traceparent` (header or metadata). | LangSmith's distributed tracing uses its own headers and does not document W3C ([R25]); ADK's code shows no A2A propagation at all ([R24]). |

---

## 2. Background and current state

### 2.1 What exists today (verified in the code) [code]

| Area | Fact | Where |
|---|---|---|
| Request span | One span per inbound request, named `a2a.task.execute` (cancel: `a2a.task.cancel`). Created with `tracer.startSpan(name, {attributes, links})`: **no span kind**, **no explicit parent** (uses whatever context is active). | `packages/core/src/telemetry/instrument.ts`, `api.ts` |
| Attributes | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name/id`, `gen_ai.conversation.id`, `session.id`, `a2a.task.id`, `a2a.context.id`, `a2a.message.id`, `a2a.method.name` (`message/send`), `a2a.parent_agent.id`, `a2a.orchestrator.trace_id`, gateway ids, wrapper identity, invocation counters. | `telemetry/attributes.ts` |
| Inbound correlation | `extractA2ATraceContext(ctx)` reads **message/request metadata only** (`trace_id`, `parent_agent_id`, `propagated_metadata`, `conversation_id`, `session_id`, gateway keys). It never reads HTTP headers and never calls `propagation.extract`. | `telemetry/context.ts` |
| Shared extractor use | `createExecutionObservability` calls it for **all five** wrappers. (Issue #49's statement that Claude/Codex/Antigravity do not read inbound context predates #52 and is stale.) | `telemetry/observability.ts` |
| Outbound helpers | `getW3cTraceContext()` / `injectW3cTraceHeaders()` exist. Used for backend passthrough (`TRACEPARENT` env for Claude, `onGetTraceContext` for Copilot). No caller exists in this repo for A2A sub-agent calls (those happen inside `a2a-mcp-skillmap`). | `telemetry/context.ts`, `backend-passthrough.ts` |
| Tool spans | `a2a.mcp.tool {name}` (`execute_tool`) only when `mirrorAgentEvents` is on and backend OTel is off. | `telemetry/emitter-bridge.ts` |
| Signals | **Traces only.** No OTel metrics or logs anywhere in core. | grep of `getMeter`, `createHistogram`, `LoggerProvider`: none |
| Exporter config | `otel.exporter` has only `endpoint` and `protocol`. **No headers.** (Langfuse and Grafana Cloud need auth headers; the OTLP exporter does read `OTEL_EXPORTER_OTLP_HEADERS` from the environment.) | `config/types.ts` |
| Event identity | `AgentEvent.traceId` = orchestrator-supplied `trace_id`, else `contextId`. It is **not** the OTel trace id. `parentAgentId` exists on `AgentEvent` but not on the A2A trace artifact; the artifact has no `eventId`; `propagatedMetadata` is stamped nowhere. | `events/transport.ts` |
| Event headers | `events.httpHeaders` is passed through unchanged (no `${VAR}` substitution), although the docs example shows `Bearer ${TELEMETRY_TOKEN}`. | `events/transport.ts`, loaders |
| Server auth | `UserBuilder.noAuthentication` for both JSON-RPC and REST: endpoints are unauthenticated by default. | `server/factory.ts` |

### 2.2 The key enabling fact [code]

The A2A SDK's default server context builder stores the raw HTTP request headers in `ServerCallContext.state` under the key `"headers"` (`STATE_HEADERS_KEY`), for JSON-RPC, REST and gRPC (metadata). The executor receives that object as `ctx.context`. So **reading an inbound `traceparent` needs no custom middleware or AsyncLocalStorage**: `ctx.context.state.get("headers")`. (Confirmed in `@a2a-js/sdk` `dist/server/express/index.js` and the type declarations; still to be confirmed at runtime for streaming requests, see P0-S1.)

### 2.3 Consequence: where the graph breaks

```
Krama / agent A                       agent B (an a2a-* wrapper)
  span X (trace T1)  ── A2A call ──▶  a2a.task.execute  (NEW trace T2)
                                      └ a2a.orchestrator.trace_id = T1   (attribute only)
```

The two spans are in different traces. Backends cannot draw "A called B", Tempo's service graph never sees a CLIENT→SERVER pair, and Langfuse/Phoenix show unrelated traces. This is what the #49 runtime follow-up observed ("worker events had a different trace id, no parent-agent id").

---

## 3. Goals and non-goals

**Goals**

1. A caller's trace continues through our agent when the caller supplies W3C trace context, regardless of whether the caller is one of ours, LangGraph, ADK or a custom orchestrator.
2. Our agents hand W3C context to sub-agents they call.
3. Every event we emit (both transports) is attributable to the originating request and joinable to our spans.
4. The three target backends render something useful with **no vendor-specific setup**, and their agent/graph views can be turned on with one opt-in setting.
5. Additive and backward compatible. Safe by default.

**Non-goals**

- Implementing an OpenTelemetry SDK in core (it stays an optional peer; hosts own the SDK).
- Defining an A2A trace-context extension (the A2A project has open proposals, [R19]; we follow, we do not fork).
- Vendor-proprietary propagation (LangSmith `langsmith-trace`, etc.).
- Capturing prompt or tool content by default (unchanged privacy posture).
- Anything on the receiving platform.

---

## 4. What the three consumers need

Everything in this section is about **ingestion and rendering**, because that is what decides the minimum we must emit.

### 4.1 Langfuse

| Topic | Finding | Evidence |
|---|---|---|
| Ingestion | OTLP over HTTP (JSON or protobuf). **gRPC not supported.** Endpoint `/api/public/otel` (self-hosted needs Langfuse ≥ 3.22). Basic auth with the public/secret key pair. Header `x-langfuse-ingestion-version: 4` recommended (otherwise data can take up to ~10 minutes to appear). | [R21a] [docs] |
| Attribute precedence | `langfuse.*` attributes always win; `gen_ai.*`, OpenInference (`input.value`, `llm.*`) and MLflow keys are mapped as fallbacks; no full precedence order is documented. | [docs] |
| Observation type | `langfuse.observation.type` ∈ `span, generation, event, embedding, agent, tool, chain, retriever, guardrail, evaluator`. An unrecognised value falls back to "other mapped conventions (for example `gen_ai.operation.name`)", then to `generation` if a model attribute exists, then `span`. **The mapping of `gen_ai.operation.name` values (`invoke_agent`, `execute_tool`, `chat`) to types is not documented.** | [docs]; ingestion source not reachable ([unverified]) |
| `gen_ai.*` understood | `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.request.*`, `gen_ai.usage.*`, `gen_ai.usage.cost`, `gen_ai.prompt`/`completion`, `gen_ai.tool.call.arguments`/`result`. **Not mentioned:** `gen_ai.conversation.id`, `gen_ai.agent.*`, `gen_ai.provider.name`. | [docs] |
| Sessions | Trace-level `langfuse.session.id` or **`session.id`**; `user.id`. Trace-level attributes should be present on every span (baggage or a span processor is the recommended way). | [docs] |
| Agent Graph | Appears when the trace has **any observation whose type is not `span`, `event` or `generation`**, or via the LangGraph integration. Built from observation **timing and nesting**; no special metadata keys required. Two modes: aggregated (one node per step name) and expanded. | [docs] |
| Root span | "Langfuse also requires that a root span is sent." How a span whose parent lives in another (unexported) system is handled is **not documented**. | [docs] / [unverified] |

**Implication:** for the graph to appear we must emit at least one observation typed `agent` (or `tool`, etc.), either explicitly (`langfuse.observation.type`) or via a `gen_ai.operation.name` mapping we cannot confirm. Session grouping already works through `session.id`, which we set.

### 4.2 Arize Phoenix

| Topic | Finding | Evidence |
|---|---|---|
| Ingestion | OTLP; `/v1/traces` accepts **protobuf only** (already noted in `observability.md`). | repo docs [code]; [R22] |
| Convention | OpenInference is "first-class. Phoenix reads these directly." Spans with `gen_ai.*` "still arrive at Phoenix, but won't get the same UI treatment." OpenInference is recommended for new instrumentation. | [R22] [docs] |
| Span kind | `openinference.span.kind` (ALL CAPS): `LLM, CHAIN, AGENT, TOOL, RETRIEVER, EMBEDDING, RERANKER, GUARDRAIL, EVALUATOR, DECISION, PROMPT, UNKNOWN`. "A span without that attribute renders with a blank icon." | [docs] |
| Agent / graph | `AGENT` spans carry `agent.name`, `graph.node.id`, `graph.node.name`, `graph.node.parent_id`; these let Phoenix render handoffs as a graph. (The graph-view statement comes from a model-generated summary of the cookbook, not verbatim text.) | [docs]/[summary] |
| Common keys | `session.id`, `user.id`, `metadata`, `tag.tags`, `input.value`/`output.value` (the **root span's** values feed the trace list columns). | [docs] |
| Tokens | `llm.token_count.prompt/completion/total` (+ detail keys) on LLM spans. | [docs] |

**Implication:** with only our current attributes, Phoenix shows our spans with blank icons and no graph. An opt-in `openinference.span.kind=AGENT` (+ `graph.node.*` when a parent agent is known) fixes that at nearly zero cost.

### 4.3 Grafana Tempo, and Grafana's AI observability

| Topic | Finding | Evidence |
|---|---|---|
| Tempo is generic | Ingestion (OTLP gRPC 4317 / HTTP 4318), TraceQL, service graphs and span metrics need **no GenAI attributes**. Any trace renders. | [R20] [docs] |
| Service graph | Built by pairing spans: "the outgoing and the incoming span must have span.kind, client, and server, respectively" (or producer/consumer for messaging). **All spans of a trace must reach the same processor** or pairing fails. An uninstrumented caller becomes a virtual node named from `peer.service`-style attributes, else `user`. | [docs] |
| Span metrics | `traces_spanmetrics_{latency,calls_total,size_total}` with labels `service, span_name, span_kind, status_code`. Attributes become labels **only if listed in `dimensions`** (so `gen_ai.agent.name` would need to be configured). | [docs] |
| Grafana AI Observability | The product page is "OpenLIT Observability": dashboards (GenAI, evaluations, vector DB, MCP, GPU) fed by the **OpenLIT SDK** over OTLP. Docs state **traces and metrics** are sent and call metrics "essential for creating dashboards". **No page names the `gen_ai.*` attributes or metrics the dashboards query**, and there is **no agent graph** (only agent-name filtering and log↔trace correlation). | [R21] [docs] |

**Implication:** for Tempo what matters is **span kind** and a **connected trace**. For Grafana's AI dashboards the minimum for a non-OpenLIT producer is **undocumented**; it likely needs OpenLIT-style metrics. We therefore do not chase those dashboards in the baseline (D7) and instead schedule a spike (P0-S5) to read the dashboard definitions.

### 4.4 Side by side

| Need | Langfuse | Phoenix | Tempo / Grafana |
|---|---|---|---|
| OTLP transport | HTTP only (no gRPC) | HTTP protobuf | gRPC and HTTP |
| Needs one connected trace for a graph | Yes (nesting + timing) | Yes (parent/child) | Yes (client/server pairs) |
| Needs span kind | No | No (uses `openinference.span.kind`) | **Yes** (CLIENT/SERVER) |
| Needs vendor attributes for agent view | `langfuse.observation.type` (or unconfirmed `gen_ai.operation.name` mapping) | `openinference.span.kind` + `graph.node.*` | None for traces; metrics for AI dashboards |
| Understands `gen_ai.*` | Partly (model, usage) | Not for UI treatment | Agnostic |
| Session grouping | `session.id` | `session.id` | n/a (query by attribute) |
| Needs headers for auth | Basic + ingestion-version | Optional API key (cloud) | Basic (Grafana Cloud) |

**The intersection, which is our bare minimum:** (1) a **connected trace** (W3C parenting), (2) **span kinds** set correctly, (3) **session id** present, (4) **auth headers configurable** on the exporter. Everything platform-specific beyond that is opt-in compat.

---

## 5. Standards status

All GenAI/A2A/MCP conventions are **Development** (not stable) and moved to the `semantic-conventions-genai` repository; the old `opentelemetry.io/docs/specs/semconv/gen-ai/*` pages are relocation stubs ([R1]).

| Topic | Status / content | Evidence |
|---|---|---|
| Agent spans | `invoke_agent {gen_ai.agent.name}` (CLIENT variant for remote agents; INTERNAL variant for in-process), `create_agent`, `execute_tool {tool}` (INTERNAL), `chat {model}` (CLIENT). Content (messages, tool args/results, system instructions) is **opt-in**, gated by `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT`-style settings. | [R1] [docs]/[summary] |
| Sub-agent as tool | PR #447 (merged 2026-10-26): agent-as-tool delegation stays `execute_tool` with `gen_ai.agent.interaction.type=delegation`; the target's own `invoke_agent` is parented to the caller's tool span, one trace. | [R9] [summary] |
| A2A conventions | Core spans merged (PR #195, 2026-10-27): CLIENT and SERVER spans named `{a2a.method.name}` (e.g. `SendMessage`), `a2a.task.id`, `a2a.message.id`, `a2a.task.state`, `gen_ai.conversation.id` = `contextId`. For HTTP the server span SHOULD be the existing HTTP server span, renamed. **Context propagation: explicitly out of scope.** Span links for async tasks: no guidance. Metrics: deferred. | [R10] [summary] |
| MCP conventions | `{mcp.method.name} {target}` spans, CLIENT/SERVER; instrumentations SHOULD inject context into `params._meta` (`traceparent`, `tracestate`, `baggage`, unprefixed). SEP-414 is **Final**. | [R14] [R15] [summary]/[docs] |
| A2A protocol | Non-normative recommendation: clients and servers "should" propagate W3C Trace Context over HTTP headers. Open proposals: #2103 (traceparent/tracestate in message metadata + HTTP headers), #2026, #2470 (guide), #2257 (SDK telemetry). No traceability spec could be read. | [R18] [R19] [docs]/[summary] |
| A2A SDKs | `a2a-python`: optional OTel decorators, **no inject/extract**. `a2a-js`: no built-in telemetry. Neither propagates trace context. | [R19] [summary] |
| W3C Trace Context | Strict validation (version `ff` forbidden, all-zero ids invalid → ignore header). The sampled flag is a *recommendation*. Public APIs that naively continue sampled traces can be overwhelmed. "Restart" the trace at a trust boundary is allowed. Never put PII in `traceparent`/`tracestate`. | [R27] [docs] |
| W3C Baggage | ≤ 64 members / 8192 bytes; no restart rule; "ensure that baggage isn't present in requests that cross trust-boundaries". | [R28] [docs] |
| OTel SDK | Default propagators `tracecontext,baggage`; default sampler `parentbased_always_on` (remote parent not sampled → dropped). **No built-in "ignore remote parent" option**: either do not extract, start a root span, or use a parent-based sampler. Span links are the recommended tool when "service policy requires the generation of a new Trace rather than trusting the incoming Trace context". | [R29] [docs] |

---

## 6. How other agents behave (the "outside" cases)

| Agent / runtime | Telemetry it emits | Does it send `traceparent` when it calls an A2A agent? | Evidence |
|---|---|---|---|
| **Google ADK** | Default "schema 2" aligned with GenAI semconv: `invoke_agent`, `generate_content {model}`, `execute_tool`; `gen_ai.conversation.id` = session id; many `gcp.vertex.agent.*` extras; no `gen_ai.agent.id`. Exports via OTLP env vars or Cloud Trace. | **Not in the ADK code read.** `RemoteA2aAgent` has no trace code; the only hooks are user-supplied `a2a_request_meta_provider` / interceptors, or generic HTTP auto-instrumentation (httpx) the user installs. ADK's own docs claim automatic cross-process propagation, which we could not locate for A2A. | [R24] [docs]/[summary] |
| **LangGraph / LangSmith** | OTel export via `LANGSMITH_OTEL_ENABLED`; maps `gen_ai.*`, `openinference.*`, `traceloop.*`, `langsmith.*` attributes. LangGraph A2A endpoint `/a2a/{assistant_id}`; `contextId` becomes the LangGraph `thread_id`. | Distributed tracing uses **LangSmith's own headers** (`langsmith-trace`, `baggage`); W3C `traceparent` is **not documented**. No trace propagation over A2A is documented. LangSmith **drops child spans whose parent was never exported to it**. | [R25] [docs]/[summary] |
| **A2A SDKs** (`a2a-python`, `a2a-js`) | Optional decorators / none | No automatic injection; JS offers `CallInterceptor` for users to add headers | [R19] [summary] |
| **Our backends** (beneath a wrapper) | Claude Code: traces (beta) `claude_code.interaction > llm_request/tool`, hybrid naming; reads inbound `TRACEPARENT` env; sends `traceparent` on HTTP MCP requests. Copilot SDK: `execute_tool` spans; tool handlers receive `traceparent`. Codex: own `codex.*` signals; traceparent handling not found. OpenCode: **no OTel option found in its docs** (our docs claim a server flag: verify). Antigravity: none. | n/a (they are the callee side of the wrapper) | [R26] [docs]/[summary] |

**What this means for "everything is possible":**

- We cannot rely on outside callers sending `traceparent` by themselves; many will not unless their HTTP client is auto-instrumented or the operator adds an interceptor. Our job is to **accept every reasonable carrier** and to **document** exactly how a caller can provide it.
- We cannot assume an outside system exports to the same backend as us (Krama may have no backend). A remote parent that is never exported leaves our span with a missing parent in some backends (LangSmith drops it; Langfuse is undocumented). That is the reason for the `restart` policy and the spike P0-S4.

---

## 7. Scenarios: how we consume and how we send

```
S1  our agent  ─▶ our agent      (sub-agent via skillmap)
S2  outside orchestrator (traceparent header) ─▶ our agent
S3  outside orchestrator (ids in message metadata only, e.g. Krama) ─▶ our agent
S4  outside orchestrator (LangSmith headers / nothing) ─▶ our agent
S5  our agent ─▶ outside agent (ADK / LangGraph / other A2A server)
S6  our agent ─▶ observability backend (Langfuse / Phoenix / Tempo / Grafana Cloud)
S7  our agent ─▶ event collector (HTTP sideband, e.g. Krama)
```

| # | We **consume** | We **send** | Bare minimum | Notes |
|---|---|---|---|---|
| **S1** | Same as S2 (the callee is one of ours). | The caller's tool span → skillmap's A2A **CLIENT** span → callee's **SERVER** span, one trace. Requires skillmap to receive context (`_meta.traceparent`) and inject `traceparent` into its A2A HTTP request. | Callee reads `traceparent` (P1). Caller side needs the companion skillmap change and a backend that forwards context (P4). | Without P4, S1 degrades to today's behaviour (separate traces, linked by attributes). |
| **S2** | `traceparent`/`tracestate` from HTTP headers; remote parent for `a2a.task.execute`. | n/a | P1. | Default policy `continue`. |
| **S3** | Metadata `traceparent`/`tracestate` if present; else legacy `trace_id`/`parent_agent_id`/`propagated_metadata` as **attributes and event stamps**, **no parent** (cannot form a valid parent from an arbitrary id). | n/a | Legacy path stays; add event stamping (P2). | This is today's Krama case; it still works and now also stamps `propagatedMetadata` on events. |
| **S4** | LangSmith headers are **not parsed**. A `baggage` header is ignored unless allow-listed. | n/a | Document the supported carriers; callers can add `traceparent` (LangSmith users can pair it with an OTel propagator). | Keeps scope bounded (D8). |
| **S5** | n/a | `traceparent` injected on our **outgoing A2A HTTP** requests (inside skillmap) so an ADK/LangGraph server that *does* extract context can join. | Companion skillmap change (P4). | Whether the outside server extracts is its choice; ADK's server code read has no extraction. |
| **S6** | n/a | OTLP/HTTP protobuf to the backend. Auth headers from config. Optional compat attributes. | Exporter headers (P2) + connected trace (P1) + kind (P1). Compat is opt-in (P3). | Recipes in [8.8](#88-exporter-recipes). |
| **S7** | n/a | Events (HTTP) stamped with real `otelTraceId`/`otelSpanId`, `parentAgentId`, `propagatedMetadata`; optional `transport: "both"`. | P2. | Lets Krama join sideband events to spans. |

---

## 8. Design

### 8.1 Principles

1. **Standard first.** W3C context and the OTel GenAI/A2A shapes are the contract; vendor attributes are an opt-in layer.
2. **One server span per request.** No "span factory". Extra spans only where a standard demands a boundary (the A2A CLIENT span lives in skillmap).
3. **Additive and reversible.** New behaviour is configurable; defaults preserve existing dashboards except where a change is clearly a fix (span kind, inbound parenting).
4. **Safe at a trust boundary.** Validate strictly, cap sizes, make `restart`/`ignore` available, never copy arbitrary baggage into attributes.
5. **Do not duplicate backend spans.** Existing ownership rules (wrapper vs backend) are unchanged.
6. **Do not guess.** Where a backend's behaviour is undocumented, ship a spike before shipping behaviour.

### 8.2 Inbound context resolution

```
resolveInbound(ctx):
  headers = ctx.context.state.get("headers")         # raw HTTP headers (A2A SDK default context builder);
                                                     # verified for JSON-RPC blocking AND streaming (Appendix A)
  meta    = merged request/message/task metadata    # as today (collectMetadata)

  candidate = first valid of:
     1. headers["traceparent"] (+ headers["tracestate"])
     2. meta["traceparent"]    (+ meta["tracestate"])        # carrier for clients that cannot set headers
  valid  := W3C format: version != "ff", 32-hex trace-id != 0, 16-hex parent-id != 0,
            v00 length == 55; tracestate: <= 32 members and <= 512 chars, else dropped
  if headers and meta both valid and different: header wins (log at debug)

  policy = effectivePolicy(request)            # section 8.3: otel.propagation.inbound, downgraded for untrusted peers
  server = otel.span.server                    # section 8.4: auto | own | nest decides whether we extract at all

  continue -> remote parent (IsRemote=true); sampling follows the host SDK's parent-based sampler
  restart  -> NEW trace; Link(candidate) added; sampling decided locally (root decision of the host sampler)
  ignore   -> NEW trace; candidate discarded; no link

  legacy ids (trace_id, parent_agent_id, propagated_metadata, conversation_id, session_id, gateway.*):
     always read as today -> attributes + event stamps. They never become a parent.
```

Notes:

- **`restart` and `ignore` have the same meaning as in Datadog (`DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT=restart|ignore`) and Elastic (`trace_continuation_strategy=restart`)**: `restart` starts a new trace and keeps a span link to the caller; `ignore` drops the caller's context entirely ([R30], [R31]).
- **Sampling is not ours to decide.** With `continue`, the host SDK's sampler applies (`parentbased_always_on` by default: an inbound `sampled=0` drops our spans, which keeps a caller's sampling decision consistent across hops; the flip side is that a caller can also switch our tracing off for its requests).
- If OTel is disabled or `@opentelemetry/api` is absent, this is a no-op, as today.
- When the parent is used, `tracestate` is propagated unmodified (W3C: it MUST NOT be modified if `traceparent` is unchanged).

### 8.3 Inbound trust policy (configurable)

Every other tracing product that was checked exposes this as an operator setting, with `continue` as the default. Nobody enforces a trust boundary for you ([R30], [R31], [R32]).

| Product | Setting | Values | Default | Notes |
|---|---|---|---|---|
| Elastic APM (Java) | `trace_continuation_strategy` | `continue`, `restart`, `restart_external` | `continue` | `restart` = new trace id, local sampling, span link to the caller. `restart_external` treats a caller as internal only if its `tracestate` carries Elastic's `es` key (the docs do not say whether a caller can forge it). Rationale given: a public service "does not want tracing data (trace-ids, sampling decisions) to possibly be spoofed by user requests". |
| Datadog (Java) | `DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT` | `continue`, `restart`, `ignore` | `continue` | `restart` = new trace, caller context kept as a span link on service-entry spans. `ignore` = new trace, headers dropped. No internal/external classifier. |
| AWS X-Ray | none | n/a | n/a | Docs tell the operator to strip `X-Amzn-Trace-Id` at the edge. |
| Envoy | none for `traceparent` | n/a | n/a | Its header-sanitizing list does **not** include `traceparent`/`tracestate`; classifying callers as internal or external uses the connection address (`xff_trusted_cidrs`, `use_remote_address`). |
| OTel SDK (Java, JS) | none | n/a | n/a | No "ignore remote parent" option; the spec's answer is to not extract, or to start a root span and add a link. |

**What each option gives you**

| Option | You get | You risk | Suits |
|---|---|---|---|
| **`continue`** (default) | One connected trace and graph across hops: Tempo service graph pairs, Langfuse/Phoenix nesting, cross-agent attribution. Same default as Elastic and Datadog. | The caller chooses your trace id and sampling flag. On an **unauthenticated** endpoint (ours is, by default) that allows trace-id spoofing, injecting spans into someone else's trace, and flooding or silencing your tracing. | Agents inside one trust domain: a private network, a service mesh, an orchestrator you operate (Krama), local development. |
| **`restart`** | A new trace per request with a **span link** back to the caller. Safe: sampling is decided locally, trace ids are yours. Links show in Tempo/Jaeger; sampling and storage cost stay under your control. | No parent/child edge, so Tempo's service graph and Langfuse/Phoenix agent graphs do **not** connect across hops (links are not rendered as graph edges in the docs read; Langfuse and Phoenix link handling is unverified). | Agents reachable from partly trusted callers, or callers whose traces never reach your backend (avoids orphaned parents in backends that drop them, e.g. LangSmith). |
| **`ignore`** | Strongest isolation: caller context is discarded, no link. Behaviour identical to today's. | You lose caller correlation except for the legacy attributes (`a2a.orchestrator.trace_id`, `parent_agent_id`). | Public, unauthenticated endpoints; strict compliance environments; "keep today's behaviour". |

**Trusted peers (optional refinement).** To get the connected graph from known callers and safety from everyone else:

- `otel.propagation.trustedPeers`: list of CIDRs (empty = every caller is trusted, i.e. the plain option above).
- `otel.propagation.untrusted`: policy applied to callers **outside** that list: `restart` (default) or `ignore`.

How a caller is classified: the SDK's context builder receives only request headers, **not** the socket address (verified in the SDK's `ServerCallContextBuilderOptions`). Core therefore adds a small Express middleware, ahead of the A2A handlers, that **overwrites** an internal header (for example `x-a2a-peer`) with `req.ip` before the context is built. A client-supplied value is always overwritten, so it cannot be spoofed. `req.ip` honours Express's `trust proxy` setting, so behind a gateway the operator must configure that (documented), otherwise every caller appears to be the gateway.

We deliberately do **not** copy Elastic's `restart_external` (classification by a `tracestate` key): it is client-controlled, and most outside callers (LangGraph, ADK, custom orchestrators) set no vendor key, so they would all be restarted.

**Presets**

| Deployment | Settings |
|---|---|
| Local development, a single trust domain, Krama-style internal orchestrator | defaults (`inbound: "continue"`) |
| Behind an API gateway you control | `inbound: "continue"`, `trustedPeers: ["<gateway CIDR>"]`, `untrusted: "restart"`; set Express `trust proxy` |
| Public endpoint, callers not trusted | `inbound: "restart"` (keeps a link) or `"ignore"` |
| Exact legacy behaviour | `inbound: "ignore"` |

### 8.4 Span model

| Property | Today | Proposed |
|---|---|---|
| Parent | active context | per 8.2 / 8.3 / the `serverSpan` mode below |
| Kind | unset (INTERNAL) | **SERVER** when we own the server-side span; INTERNAL when we nest under an existing server span |
| Name | `a2a.task.execute` / `a2a.task.cancel` | unchanged by default; `otel.spanNaming: "semconv"` → `invoke_agent {gen_ai.agent.name}` |
| `a2a.method.name` | `message/send` | map to A2A v1 names (`SendMessage`, `SendStreamingMessage`, `CancelTask`) per [R10]; keep the old value in `a2a.method.legacy_name` for one release |
| Status | exception → ERROR | unchanged; plus ERROR on `failed` terminal task state |
| Links | prior attempt (`a2a.task.link_reason`) | unchanged; plus the inbound link under `restart` |

#### Server-span handling: `otel.span.server` = `auto` | `own` | `nest`

Two real deployments exist, and they need different behaviour. It was measured, not assumed (Appendix A):

| Deployment | What the executor sees | Result today |
|---|---|---|
| **No HTTP instrumentation** (what the wrapper CLI bootstraps) | No ambient span. `traceparent` is in `ctx.context.state.get("headers")`. | Our `a2a.task.execute` is a **root span in a new trace**: the break described in 2.3. |
| **HTTP auto-instrumentation on the host** (e.g. `@opentelemetry/auto-instrumentations-node`) | An ambient, recording **SERVER** span (`POST`) that already extracted the caller's context. | Our span is its **child**: the graph is already connected, no work needed. |

If we always extracted and created our own SERVER span, the second deployment would get **two SERVER spans for one request**, both children of the caller's span (measured). That duplicates service-graph edges and span-metric counts. The A2A conventions tell instrumentation to "enrich the HTTP server span … instead of reporting a nested server span" when it can detect one ([R10]); the spec defines no detection mechanism, so ours is:

| Mode | Behaviour | You get | You give up | Suits |
|---|---|---|---|---|
| **`auto`** (default) | If the active span is **recording** and its **SDK kind is SERVER**, nest: our span is an INTERNAL child and we do **not** extract (the HTTP instrumentation already did). Otherwise act as `own`. | Correct in both deployments with no setting; no duplicate SERVER spans. | Detection relies on the SDK span's `kind` (the API `Span` exposes none); an unsampled ambient span cannot be inspected and is treated as "no ambient span". | Almost everyone. |
| **`own`** | Always extract (per policy) and create our own SERVER span. | Deterministic. Our span is the single server-side span if the host has no HTTP instrumentation. | Duplicate SERVER spans next to HTTP auto-instrumentation. | Hosts without HTTP instrumentation that want certainty; hosts that deliberately disable it. |
| **`nest`** | Never extract; always a child of the active context; INTERNAL kind (today's behaviour). | Host owns propagation entirely; zero behaviour change. | No cross-agent join unless the host instruments HTTP. | Hosts with their own propagation layer. |

Optional `otel.span.enrichServerSpan` (default **false**): in `auto`-nest, also add `a2a.*` attributes to the existing HTTP server span (and, only if enabled, rename it to `{a2a.method.name}` as the A2A convention suggests). It is off by default because mutating another instrumentation's span is invasive.

Why one span and not the spec-pure two (SERVER `SendMessage` → INTERNAL `invoke_agent`): it keeps the repo's "one request, one span" rule, gives Tempo its SERVER half, and gives Langfuse/Phoenix an agent-typed span. The two-span form stays a Tier 2 option (section 9).

### 8.5 Compat attributes (opt-in)

`otel.compat: ["langfuse", "openinference"]` (default: none). Each adds a small, fixed set of attributes; none changes the standard ones.

| Span | `langfuse` adds | `openinference` adds |
|---|---|---|
| Request span (`a2a.task.execute`) | `langfuse.observation.type=agent` | `openinference.span.kind=AGENT`, `agent.name`, `graph.node.id=<agentId>`, `graph.node.name=<agentName>`, `graph.node.parent_id=<parent_agent_id>` **only when a parent agent is known** |
| Mirrored tool span (`a2a.mcp.tool`) | `langfuse.observation.type=tool` | `openinference.span.kind=TOOL`, `tool.name` |
| Trace-level | (`session.id` already set) | (`session.id` already set) |

Not added in the baseline: `input.value`/`output.value`/`langfuse.observation.input|output` (they carry content; gated behind the existing content-capture stance), `llm.token_count.*` (would mislabel an AGENT span as an LLM span; usage stays on `a2a.task.usage.*` and backend LLM spans per the ownership doc).

### 8.6 Sub-agent propagation (callers)

The wrapper does not call sub-agents itself; `a2a-mcp-skillmap` does, as an MCP tool invoked by the backend CLI, and backend CLIs call MCP tools without wrapper involvement. Whether the MCP server can learn the **current request's** trace context depends on the backend. This was measured on real runs (Appendix B, spike P0-S2):

| Backend (tested version) | HTTP MCP server | stdio MCP server | Condition | Backend-provided correlation id in `_meta` |
|---|---|---|---|---|
| **GitHub Copilot** (CLI 1.0.68) | `_meta.traceparent` | `_meta.traceparent` | Only with Copilot **telemetry on**. With the SDK's `onGetTraceContext` supplying our context, the forwarded id is **our trace id**; without it Copilot forwards its own new trace. | none |
| **Claude Code** (2.1.323) | HTTP **`traceparent` header** (not `_meta`) | **nothing per call** (only the static spawn env) | Only with tracing (beta) **on**; an inbound `TRACEPARENT` env makes it forward **our trace id**. | `claudecode/toolUseId` (always) |
| **OpenCode 1.19.6** | nothing | nothing | no telemetry option exists | none |
| **OpenCode 2.3.2** | nothing | nothing | no telemetry option exists | `ai.opencode/sessionID` (always) |
| **Codex** (0.167.2) | not testable here | not testable here | every model name was rejected for the ChatGPT login on this machine | unknown |
| **Antigravity** | not tested | not tested | no backend OTel | unknown |

Two carriers exist in the wild (`_meta` and an HTTP header), and stdio gets no per-call context from Claude Code. So the receiving side must accept **both** carriers, and a fallback is needed for the backends that forward nothing. Decision (replaces the earlier two-branch tree):

1. **Carriers (Tier 1).** The sub-agent bridge accepts `params._meta.traceparent` **and** an HTTP `traceparent` header, and uses whichever is present as the parent of its A2A **CLIENT** span, then injects `traceparent` into the outgoing A2A request. This covers Copilot (stdio and HTTP) and Claude Code (HTTP only). The wrapper side is the existing Hook F (`otel.backend.copilot`, `otel.backend.claude`), which already turns the backend's telemetry on and hands it our context. It needs a companion change in `a2a-mcp-skillmap`, which today runs as a stdio server; accepting the Claude Code header means supporting an HTTP transport as well.
2. **Correlation registry (Tier 2, replaces the "per-session wrapper-hosted bridge").** Backends that forward nothing still send their **own ids** in `_meta` (`claudecode/toolUseId`, `ai.opencode/sessionID`), and the wrapper already sees the same ids in its event stream (tool-use ids in the Claude stream; sessions for OpenCode) while it holds the active span. A small wrapper-side registry that maps those ids to the active `traceparent`, which the bridge can look up, gives context to Claude stdio and OpenCode 2.x without a second MCP server per session. OpenCode 1.x provides no id at all, so it remains attribute-only (`parent_agent_id`, `propagated_metadata`).
3. **Always:** wrapper-side correlation attributes keep flowing as metadata, so S3-style attribution works for every backend regardless of 1 and 2.

```
backend CLI ── tools/call ──▶ MCP bridge (skillmap)
   _meta.traceparent | traceparent header | (id in _meta -> registry lookup)
bridge: CLIENT span "SendMessage" (parent = that context)
        └─ HTTP POST to sub-agent with traceparent header (inject)
sub-agent: SERVER span (parent = that CLIENT span)          <- P1
```

### 8.7 Sideband events

| Change | Detail |
|---|---|
| Real trace ids on events | `AgentEvent` gains optional `otelTraceId`, `otelSpanId` (hex of the active OTel span, when available). `traceId` keeps its current meaning (orchestrator id / `contextId`) for compatibility. |
| `propagatedMetadata` | Stamped on every event (both transports) and echoed in the final `x-usage` metadata. Subject to the existing redaction plus a size cap (proposed: 8 KB serialized, 64 keys, key charset `[A-Za-z0-9_.-]`). |
| A2A trace artifact | Metadata gains `eventId`, `parentAgentId`, `otelTraceId`, `otelSpanId`. |
| `events.transport: "both"` | Emits the A2A artifact and the HTTP POST with the **same `eventId`** so consumers can dedupe. |
| Header substitution | `${VAR}` resolved in `events.httpUrl`, `events.httpHeaders` (missing variable: warn once, leave unresolved, as for sub-agent auth). |

### 8.8 Exporter recipes

`otel.exporter` gains optional `headers` (values support `${VAR}`; never logged). The OTLP exporter also honours `OTEL_EXPORTER_OTLP_HEADERS`, which stays the preferred way to avoid secrets in files.

| Backend | Endpoint / protocol | Headers | Notes |
|---|---|---|---|
| Langfuse | `…/api/public/otel` (cloud or self-hosted ≥ 3.22), `http/protobuf` or `http/json`, **not gRPC** | `Authorization: Basic base64(pk:sk)`, `x-langfuse-ingestion-version: 4` | Turn on `compat: ["langfuse"]`. [R21a] |
| Phoenix | `http://host:6006/v1/traces`, `http/protobuf` **only** | optional API key (cloud) | Turn on `compat: ["openinference"]`. [R22] |
| Grafana Tempo | OTLP gRPC `:4317` / HTTP `:4318` (usually via Alloy or an OTel Collector) | none for self-hosted; Basic for Grafana Cloud's OTLP gateway | Generic traces need no compat. Add `gen_ai.agent.name` to the metrics-generator `dimensions` if you want it as a metric label. [R20] |
| Grafana Cloud AI Observability | OTLP gateway | Basic | Dashboards expect OpenLIT-style metrics; **not covered by this design** (D7, P0-S5). [R21] |

### 8.9 Configuration surface

Every behaviour that has more than one sensible answer is a setting, so the same build serves a laptop, an internal mesh, a gateway-fronted deployment and a public endpoint. Precedence follows the existing loader order: **defaults ← JSON file ← environment ← CLI flags**. Every JSON path below has an environment variable; the CLI flags mirror the ones that already exist for other settings (added where a flag is useful).

| JSON path | Environment variable | Values | Default | Decision |
|---|---|---|---|---|
| `otel.propagation.inbound` | `A2A_OTEL_INBOUND` | `continue`, `restart`, `ignore` | `continue` | 8.3 |
| `otel.propagation.trustedPeers` | `A2A_OTEL_TRUSTED_PEERS` (comma-separated CIDRs) | list | `[]` (everyone trusted) | 8.3 |
| `otel.propagation.untrusted` | `A2A_OTEL_UNTRUSTED` | `restart`, `ignore` | `restart` | 8.3 |
| `otel.propagation.carriers` | `A2A_OTEL_CARRIERS` | `header`, `metadata` (comma-separated, order = precedence) | `header,metadata` | 8.2 |
| `otel.propagation.baggageAttributes` | `A2A_OTEL_BAGGAGE_ATTRIBUTES` | allow-list of baggage keys to copy to attributes | `[]` | 8.11 |
| `otel.span.server` | `A2A_OTEL_SERVER_SPAN` | `auto`, `own`, `nest` | `auto` | 8.4 |
| `otel.span.enrichServerSpan` | `A2A_OTEL_ENRICH_SERVER_SPAN` | boolean | `false` | 8.4 |
| `otel.spanNaming` | `A2A_OTEL_SPAN_NAMING` | `legacy`, `semconv` | `legacy` | 8.4 |
| `otel.compat` | `A2A_OTEL_COMPAT` | `langfuse`, `openinference` (comma-separated) | none | 8.5 |
| `otel.metrics.profile` | `A2A_OTEL_METRICS_PROFILE` | `none`, `genai-semconv`, `grafana-agent` | `none` | 9.1.3 |
| `otel.exporter.headers` | `OTEL_EXPORTER_OTLP_HEADERS` (standard; also accepted in JSON with `${VAR}`) | map | none | 8.8 |
| `otel.attributes.sessionId` | `A2A_OTEL_SESSION_ID` | `context` (use A2A `contextId`), `explicit` (only metadata `session_id`) | `context` | 9.1.4 |
| `otel.attributes.providerName` | `A2A_OTEL_PROVIDER_NAME` | string, e.g. `anthropic` | unset | 9.1.4 |
| `events.transport` | `A2A_EVENTS_TRANSPORT` | `a2a`, `http`, `both` | `a2a` | 8.7 |
| `events.httpUrl` / `events.httpHeaders` | `A2A_EVENTS_HTTP_URL` / `${VAR}` in values | string / map | none | 8.7 |

```jsonc
{
  "otel": {
    "enabled": true,
    "exporter": { "endpoint": "https://…", "protocol": "http/protobuf", "headers": { "Authorization": "Basic ${LANGFUSE_AUTH}" } },
    "propagation": { "inbound": "continue", "trustedPeers": ["10.0.0.0/8"], "untrusted": "restart" },
    "span": { "server": "auto", "enrichServerSpan": false },
    "spanNaming": "legacy",
    "compat": ["langfuse", "openinference"],
    "metrics": { "profile": "none" }
  },
  "events": { "transport": "both", "httpUrl": "${COLLECTOR_URL}", "httpHeaders": { "Authorization": "Bearer ${TOKEN}" } }
}
```

#### Presets: which settings for which use case

| Use case | Settings |
|---|---|
| **Local development / demo** | defaults; `compat` as needed for the viewer |
| **Internal multi-agent mesh, orchestrator you operate (Krama)** | defaults (`continue`, `span.server: auto`); `events.transport: both` |
| **Host already runs OTel auto-instrumentation** | defaults (`auto` nests under the HTTP server span); no `own` |
| **Behind an API gateway** | `trustedPeers: [gateway CIDR]`, `untrusted: restart`; configure Express `trust proxy` |
| **Public / untrusted callers** | `inbound: restart` (or `ignore`) |
| **Outside orchestrator (LangGraph, ADK) that sends no `traceparent`** | nothing to configure; it arrives as a legacy-attribute request (S3/S4). Document how the caller can add the header |
| **Langfuse** | `compat: ["langfuse"]`, exporter headers (Basic + `x-langfuse-ingestion-version: 4`), HTTP protocol |
| **Phoenix** | `compat: ["openinference"]`, `http/protobuf` |
| **Tempo / generic Grafana** | no `compat`; optionally list `gen_ai.agent.name` in the metrics-generator `dimensions` |
| **Grafana Cloud AI dashboards (agent panels)** | `metrics.profile: grafana-agent` (9.1.3); the GenAI/VectorDB dashboards cannot be lit without impersonating OpenLIT |
| **Keep exactly today's behaviour** | `inbound: ignore`, `span.server: nest`, no `compat`, `metrics.profile: none` |

JSON schemas for all five wrappers and `@a2a-wrapper/core` are regenerated (the existing `schema-up-to-date` tests enforce this).

### 8.10 Compatibility and migration

| Change | Visible effect | Mitigation |
|---|---|---|
| Span kind INTERNAL → SERVER | Appears in service graphs / span metrics (`span_kind` label). | Document in changeset; intended. |
| Inbound parenting | Traces from instrumented callers now connect. Orphan risk in backends that drop spans with unexported parents. | `restart` / `ignore` policies, `trustedPeers`; spike P0-S4; docs. |
| `a2a.method.name` values | Dashboards filtering on `message/send` | Keep legacy value under a second key for one release. |
| New artifact fields / event fields | Additive | none |
| `semconv` naming | Opt-in only; default flip considered for a major release | none |

### 8.11 Security and privacy

- Validate `traceparent`/`tracestate` strictly (W3C §7); ignore invalid headers instead of failing the request.
- Cap sizes for tracestate and `propagatedMetadata`; apply the existing secret redaction to propagated metadata.
- Never copy inbound `baggage` into attributes by default; an allow-list setting (`otel.propagation.baggageAttributes`, default empty) can map named keys to attributes. Baggage is forwarded only by the host SDK's propagators, as today.
- Never put identifiers other than W3C-defined fields into `traceparent`/`tracestate`.
- Unauthenticated endpoints: docs state the risk and recommend `restart`/`ignore`, or `trustedPeers` with `untrusted: restart` (8.3).
- Content capture unchanged (off by default).

### 8.12 Deliberately not done

| Not done | Why |
|---|---|
| Parsing `langsmith-trace` / ADK-specific headers | Proprietary; out of scope (D8). |
| Wrapper-emitted token metrics | Conflicts with the no-double-count policy; spans suffice for Tempo/Langfuse/Phoenix (D7). |
| An A2A trace-context extension of our own | The A2A project has open proposals; we follow them. |
| Inventing `a2a.*` attributes beyond the merged conventions | Spec drift policy in `otel-attribute-ownership.md` stays. |

---

## 9. The bare-minimum decision

Each candidate is scored against the three consumers and outside-agent interop. **Tier 0** = without it the trace graph does not work; **Tier 1** = cheap and clearly valuable; **Tier 2** = only if a spike or user need justifies it.

| Candidate | Langfuse | Phoenix | Tempo/Grafana | Outside agents | Cost | Tier |
|---|---|---|---|---|---|---|
| Inbound W3C extraction → remote parent (header, then metadata) | graph needs nesting | needs parent/child | needs one trace | **the** join mechanism | M | **0** |
| Span kind `SERVER` | – | – | **service graph needs it** | – | S | **0** |
| Real `otelTraceId`/`otelSpanId` on events | – | – | – | lets collectors join events to spans | S | **0** |
| `session.id` / conversation id (exists) | session grouping | session grouping | filter | – | done | **0** |
| Exporter `headers` (with `${VAR}`) | **auth required** | cloud key | Grafana Cloud auth | – | S | **0** |
| Inbound policy `restart`/`ignore` + `trustedPeers` + strict validation | orphan handling | – | – | trust boundary | S | **1** (ships with the Tier 0 parenting) |
| `${VAR}` in event headers; `propagatedMetadata` on events; `eventId`/`parentAgentId` on artifact | – | – | – | Krama-style attribution | S | **1** |
| `events.transport: "both"` | – | – | – | dedupe by `eventId` | S | **1** |
| `compat: langfuse` (`observation.type`) | **agent graph** | – | – | – | S | **1** |
| `compat: openinference` (`span.kind`, `graph.node.*`) | – | **icons + graph** | – | – | S | **1** |
| Sub-agent forwarding via `_meta` (skillmap companion) | cross-agent graph | cross-agent graph | cross-agent service graph | S1/S5 | M (+ companion) | **1** (after spike P0-S2) |
| `spanNaming: "semconv"` and A2A v1 method names | maybe type mapping | – | – | spec alignment | S | **1** |
| Two-span model (SERVER `SendMessage` + INTERNAL `invoke_agent`) | – | – | spec-pure | – | M | 2 |
| GenAI/A2A duration metrics (`otel.metrics.profile`) | – | – | Grafana AI dashboards need Prometheus/Loki, not traces (verified) | – | M | 2 (opt-in profiles, P6) |
| Per-session wrapper-hosted MCP bridge | – | – | – | backends that drop context | L | 2 (only if P0-S2 requires) |
| A2A carriers in message metadata via an official extension | – | – | – | when A2A settles #2103 | S | 2 (we already read `meta.traceparent`) |
| Span links for `input-required` resume across requests | – | – | – | already present (prior attempt) | done | – |

---

### 9.1 Decision analysis: what you get with each option

The three decisions that were open are each made **configurable** (8.9), so the question becomes "what should the default be, and what does each setting buy". Evidence is in sections 4, 5 and 8 and Appendix A.

#### 9.1.1 Inbound policy (was Q1)

See the full option table in [8.3](#83-inbound-trust-policy-configurable). In short:

| If you choose | The graph | Security posture | Cost to you |
|---|---|---|---|
| `continue` | Connected across hops | Caller controls trace id and sampling | None; matches the default of Elastic and Datadog |
| `continue` + `trustedPeers` + `untrusted: restart` | Connected for known callers, linked for others | Strong: spoofing only from trusted peers | One CIDR list; `trust proxy` behind a gateway |
| `restart` | Linked, not connected | Safe | Lose service-graph and agent-graph edges across hops |
| `ignore` | Isolated | Safest | Lose caller correlation (attributes only) |

**Recommended default: `continue`**, because the goal is the connected graph, `otel.enabled` is already an explicit opt-in, and this is what the surveyed products default to. The documentation must state plainly that an unauthenticated endpoint plus `continue` lets any caller choose your trace id and sampling flag, and point to the presets.

#### 9.1.2 Server span: nest or own (was Q3)

See [8.4](#84-span-model). Measured behaviour: without HTTP instrumentation the old span is a root in a new trace; with it, the old span already nests under the HTTP SERVER span, and an always-extract design would create a **second** SERVER span. Hence `auto` as the default: correct for both, no duplicates, and `own`/`nest` as escape hatches.

#### 9.1.3 Metrics (was Q5)

What Grafana's AI dashboards need was read from their dashboard definitions (`grafana-aio11y-app`, `mixin/genai-mixin/dashboards`) [R33] [summary for the second half of three files]:

| Dashboard | Data it queries | Works from traces alone? |
|---|---|---|
| GenAI observability | Prometheus: `gen_ai_client_operation_duration_seconds_*`, `gen_ai_client_token_usage_*`, `gen_ai_usage_cost_USD_*`, `gen_ai_server_time_to_first_token_seconds_bucket`; hard filter `telemetry_sdk_name="openlit"`; plus one Loki logs panel | **No** |
| **Agent observability** | Prometheus: `gen_ai_agent_invocations_total`, `gen_ai_agent_operation_duration_seconds_*`, `gen_ai_usage_cost_USD_sum`; labels `gen_ai_agent_name`, `gen_ai_agent_source`, `gen_ai_provider_name`; Loki "Agent Logs" (`|= "_agent"`, `otelTraceID`) | **No** |
| MCP observability | Prometheus `mcp_*` metrics; Tempo only for a supplemental trace table (`mcp.system = "mcp"`) | No |
| VectorDB | Prometheus `db_*`; Tempo trace table (filter `telemetry.sdk.name = "openlit"`) | No |
| Evaluations | Loki only | n/a |

Also: every dashboard needs `service_name` and `deployment_environment` labels. The agent metrics (`gen_ai.agent.*`) are **OpenLIT vendor extensions**, not OpenTelemetry-standard names [R34], and the OTel GenAI spec's own agent metric names are still in flux (`gen_ai.invoke_agent.duration` vs `gen_ai.client.invoke_agent.duration` on the same spec page).

| `otel.metrics.profile` | What is emitted | You get | You give up / risk |
|---|---|---|---|
| **`none`** (default) | No wrapper metrics. | Tempo derives RED metrics from spans (span-metrics generator); Langfuse and Phoenix derive from traces. No double counting with backends that already emit metrics (Claude Code has its own). | Grafana Cloud AI dashboards stay empty. |
| `genai-semconv` | The standard agent metrics as the spec currently names them (invoke-agent duration, execute-tool duration, plus the call-count histograms), low-cardinality dimensions only (agent name, operation, error type). | Portable metrics for any backend; you can build your own Grafana panels or alerts. | Spec is in Development and internally inconsistent; names may change; will **not** populate OpenLIT-shaped dashboards. |
| `grafana-agent` | OpenLIT-style agent metrics: invocations counter, agent operation-duration histogram, cost, with the labels the Agent dashboard filters on. | The **Agent** dashboard's metric panels light up. | Vendor-specific names that can change; the GenAI and VectorDB dashboards stay empty (they hard-filter `telemetry.sdk.name = "openlit"` and we will not impersonate another SDK); the "Agent Logs" panel needs logs we do not emit; extra care to avoid double counting. |

Rules for any profile: low-cardinality dimensions only (never task, message or context ids); the usage rules in `otel-attribute-ownership.md` still apply (no summing wrapper and backend token metrics). Implementation is Tier 2 (P6); the setting is reserved now so the schema is stable.

**Recommended default: `none`.** Revisit after a real Grafana Cloud check of the Prometheus names after OTLP translation (the dashboards show the translated names; we have not verified the translation rules ourselves).

#### 9.1.4 Smaller choices that became settings

| Choice | Options | Default and why |
|---|---|---|
| `session.id` source (was Q2) | `context` (A2A `contextId`) or `explicit` (only a caller-supplied `session_id`) | `context`: keeps today's behaviour; Langfuse and Phoenix group on `session.id`. `explicit` suits callers whose `contextId` is per-request. |
| `gen_ai.provider.name` (was Q4) | unset, or a configured value | unset: the GenAI spec requires it on the CLIENT `invoke_agent` variant (remote agent services) but not on the in-process variant our request span resembles. Set it if a platform you use groups by provider. |

## 10. Implementation plan

Sizes: S ≈ ≤1 day, M ≈ 2–4 days, L ≈ 1–2 weeks. Each phase is a separate PR with a changeset and docs.

### P0: Spikes (de-risk before building)

| ID | Question | Method | Decides |
|---|---|---|---|
| **P0-S1** | Does `ctx.context.state.get("headers")` carry `traceparent` for JSON-RPC, REST, **streaming** and gRPC? | **Answered:** JSON-RPC blocking and streaming (Appendix A) and REST (A.2). gRPC is not mounted by core. | 8.2 mechanism (confirmed). |
| **P0-S2** | Which backends forward trace context to MCP tool calls (`_meta.traceparent` or header)? | **Answered (Appendix B)** for Copilot, Claude Code and OpenCode 1.x/2.x on real runs; Codex not testable on this machine; Antigravity untested. | D4 settled: both carriers plus a correlation registry (8.6). |
| **P0-S3** | Do ADK and LangGraph clients send `traceparent` to our agent? | Minimal ADK `RemoteA2aAgent` and LangGraph A2A client scripts against a wrapper that logs headers; try with and without `opentelemetry-instrumentation-httpx`. | Docs for callers; S2 vs S3 expectations. |
| **P0-S4** | How do Phoenix (local, per `examples/otel-stack`) and Langfuse treat a span whose remote parent was never exported? | Send a synthetic trace with a missing parent to each. | Which of `continue` / `restart` to recommend per backend (the default stays configurable). |
| **P0-S5** | What exactly do Grafana Cloud's AI dashboards query? | **Answered (9.1.3):** Prometheus and Loki only, OpenLIT-shaped names. Remaining: confirm the translated Prometheus names against a real Grafana Cloud stack. | D7 confirmed: no default metrics. |
| **P0-S6** | Can core record the caller's address unspoofably for `trustedPeers`? | **Answered (A.2):** an Express middleware that overwrites an internal header with `req.ip` is unspoofable; `X-Forwarded-For` is honoured only when `trust proxy` allows it. | `trustedPeers` can ship in the first release; docs must cover `trust proxy` behind a gateway. |

Exit: findings appended to this document; decisions D2/D4/D7 confirmed or changed.

### P1: Join the trace (Tier 0)  *(core + all wrappers; M)*

| Work item | Files |
|---|---|
| `resolveInbound()` per 8.2: header then metadata carrier, strict validation, policies | `packages/core/src/telemetry/context.ts`, new `propagation.ts` |
| Parent the request span from the resolved context; set kind `SERVER` (or nest, per `otel.span.server`); `restart`/`ignore` policies | `telemetry/instrument.ts`, `api.ts` (`withSpan` accepts parent context and kind) |
| `otel.propagation.{inbound,trustedPeers,untrusted,carriers}` and `otel.span.{server,enrichServerSpan}` in config, schema and env vars | `config/types.ts`, loaders, wrapper schemas |
| Server-span detection for `auto` (active span recording and SDK kind SERVER) | `telemetry/instrument.ts` |
| Peer-address middleware for `trustedPeers` (only if P0-S6 passes) | `server/factory.ts` |
| `a2a.method.name` v1 names (+ legacy key) | `telemetry/attributes.ts` |
| Stamp `otelTraceId`/`otelSpanId` on `AgentEvent` | `events/transport.ts` (`AgentEventEmitter`) |
| Exporter `headers` with `${VAR}` | `telemetry/cli-bootstrap.ts`, config, loader |
| Docs + changeset (core minor, wrappers minor) | `observability.md`, ownership doc |

**Acceptance:** (1) with no HTTP instrumentation, a request carrying a valid `traceparent` produces a request span whose parent is that span id (same trace id), for JSON-RPC and REST, blocking and streaming; (2) with HTTP instrumentation present and `span.server: auto`, exactly **one** SERVER span exists per request and ours nests under it; (3) invalid headers are ignored and logged at debug, the request still succeeds; (4) `restart` produces a new trace with one link to the inbound context, `ignore` a new trace with no link; (5) with `trustedPeers` set, an untrusted peer gets the `untrusted` policy and a client-supplied peer header has no effect; (6) with no context, behaviour is unchanged; (7) events carry the active span's trace and span ids; (8) two real wrappers on this machine, A then B with a header-injecting client, show one trace in an in-memory exporter.

**Tests:** unit (validation matrix, policies) with the OTel in-memory span exporter; one contract test per wrapper with a fake backend; a cross-agent integration test (two executors); a local Phoenix check using `examples/otel-stack`.

### P2: Event attribution and plumbing (Tier 1)  *(core; M)*

`propagatedMetadata` + size/charset caps on events and `x-usage`; `eventId`/`parentAgentId`/`otelTraceId`/`otelSpanId` on the A2A artifact; `events.transport: "both"`; `${VAR}` in event URL/headers for all five loaders. **Acceptance:** every event on both transports carries the stamped fields; `both` emits two copies with equal `eventId`; missing env var warns once. Closes the core of #49 items 2, 4, 5.

### P3: Platform compat attributes (Tier 1)  *(core; S)*

`otel.compat` per 8.5; docs recipes (8.8) verified against local Phoenix and, where an account exists, Langfuse. **Acceptance:** with `compat: ["openinference"]` Phoenix shows AGENT icon; with `compat: ["langfuse"]` the observation is typed `agent`; with neither, attribute set is unchanged (snapshot test).

### P4: Forward to sub-agents (Tier 1)  *(companion repo + wrapper; M + companion)*

Shape settled by P0-S2 (Appendix B, section 8.6). Companion issue in `a2a-mcp-skillmap`: accept **both** `params._meta.traceparent` and an HTTP `traceparent` header (which implies an HTTP transport as well as stdio); create the A2A CLIENT span; inject `traceparent` into outgoing A2A requests; pass `parent_agent_id` and `propagated_metadata`. Wrapper side: keep Hook F (backend telemetry on, our context handed to the backend), and add the **correlation registry** (Tier 2) mapping `claudecode/toolUseId` / `ai.opencode/sessionID` to the active `traceparent` for backends that forward nothing. **Acceptance:** the #49 criterion "A calls B → B's events carry A's trace id, `parentAgentId = A`, propagated metadata", demonstrated with two real wrappers and at least one backend per carrier (Copilot `_meta`, Claude Code header).

### P5: Semconv naming (Tier 1, opt-in)  *(core; S)*

`otel.spanNaming: "semconv"` → `invoke_agent {name}`; docs on migrating dashboards; deprecation plan for flipping the default in the next major. **Acceptance:** both names selectable; default unchanged.

### P6: Conditional work (Tier 2)

Decide after P0-S4/P4 (P0-S5 is answered): `otel.metrics.profile` implementations (`genai-semconv`, and `grafana-agent` only if the owner confirms it is worth it), the two-span model, the per-session bridge, the A2A-extension carrier.

### Issue management

| Issue | Action |
|---|---|
| #49 | Re-scope: P1 + P2 + P4 (note the shared extractor already exists). Update the stale "other wrappers don't read context" statement. |
| #40 | Close with a checklist pointing to #52 (delivered) and this design (remaining). |
| New | `a2a-mcp-skillmap` companion (P4); "platform compat attributes" (P3); "spanNaming semconv" (P5); "OpenCode OTel option claim in docs" (verify, fix docs). |

### Release

Changesets: `@a2a-wrapper/core` minor (new config, behaviour: SERVER kind, inbound parenting); each wrapper minor for schema changes. The kind/parenting change gets an explicit "behaviour change" note.

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Conventions are Development and keep changing | High | Rename churn | Keep standard attributes thin; compat layer isolated; follow the existing spec-drift policy |
| Orphan spans in backends that drop unexported parents | Medium | Traces missing | `restart` policy; P0-S4; docs |
| Untrusted callers choose trace id/sampling | Medium (agents are unauthenticated by default) | Trace flooding | Strict validation; `restart`/`ignore`; `trustedPeers`; documented |
| Backends do not forward context to MCP tools | Medium | S1/S5 incomplete | D4 branch 2; attribute-level correlation still works |
| Duplicate SERVER spans when a host also runs HTTP auto-instrumentation | Medium | Double spans | **Mitigated:** `otel.span.server: auto` nests under a recording SERVER span (behaviour measured in Appendix A); `own` and `nest` are available. |
| Grafana AI dashboards need metrics we do not emit | High | Dashboards empty | Out of baseline by design; P0-S5; P6 |

### Decisions and open questions

The five questions raised in the first draft were analysed in [9.1](#91-decision-analysis-what-you-get-with-each-option). Each is now a **setting**, so they no longer block the work; what remains is confirming defaults.

| # | Original question | Resolution |
|---|---|---|
| Q1 | Default inbound policy given unauthenticated endpoints? | Configurable `continue \| restart \| ignore` plus `trustedPeers`/`untrusted`. Proposed default `continue`. |
| Q2 | `session.id` from `contextId` or explicit only? | Setting `otel.attributes.sessionId`; default `context`. |
| Q3 | Nest under an HTTP server span or create our own? | Setting `otel.span.server`; default `auto` (measured in Appendix A). |
| Q4 | `gen_ai.provider.name` on the request span? | Optional setting; default unset. |
| Q5 | Appetite for GenAI/A2A metrics? | Setting `otel.metrics.profile`; default `none`; implementation is Tier 2. |

**Still to confirm with the owner (defaults only):**

1. Is `continue` the right shipped default for `otel.propagation.inbound`, with the documentation warning for unauthenticated endpoints? (The alternative is `restart`, which is safer but gives up the connected graph by default.)
2. Is the `grafana-agent` metrics profile worth building at all, given it targets vendor-specific names and only the Agent dashboard? (If not, keep only `none` and `genai-semconv`.)
3. ~~Should `trustedPeers` ship in the first release?~~ Resolved by P0-S6 (A.2): the middleware is straightforward and unspoofable, so it can ship with `inbound`.

## 11. Verification strategy

| Level | What |
|---|---|
| Unit | W3C validation matrix; policy behaviour; attribute snapshots per compat mode; event stamping. In-memory OTel span exporter. |
| Contract (per wrapper) | Fake backend; `message/send` and `message/stream` with header and metadata carriers; assert span parent, kind, attributes and events on **both** transports. |
| Cross-agent | Two real executors A→B; header injection by a test client; one trace asserted. |
| Local backend | Phoenix (`pip install arize-phoenix`, already documented in `examples/otel-stack`). Langfuse and Tempo/Grafana need Docker or an account: documented manual checklist per backend; automated only where available. |
| Interop | ADK and LangGraph client scripts from P0-S3 kept as a manual matrix in the docs. |
| Real-backend | Reuse the real Copilot/OpenCode runs used for #56/#60 to confirm spans and events end to end. |

---

## 12. References

Labels: **[docs]** read directly; **[summary]** read via a fetch-tool summary (verify before coding against it); **[unverified]** not established. Snapshot dates of the OTel repositories end around 2026-10-27.

**OpenTelemetry GenAI / A2A / MCP**

- [R1] OpenTelemetry GenAI semantic conventions repository: https://github.com/open-telemetry/semantic-conventions-genai (docs under `docs/gen-ai/`; agent spans, `invoke_agent`, `execute_tool`, `chat`, metrics) **[docs]/[summary]**. The old `https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/` and `…/gen-ai-spans/` pages are relocation stubs.
- [R9] PR #447, unified model for agent-to-agent interactions (`gen_ai.agent.interaction.type`): https://github.com/open-telemetry/semantic-conventions-genai/pull/447 **[summary]**
- [R10] A2A semantic conventions: issue https://github.com/open-telemetry/semantic-conventions-genai/issues/254, merged PR https://github.com/open-telemetry/semantic-conventions-genai/pull/195, file `docs/gen-ai/a2a.md` **[summary]**. Multi-agent identity: https://github.com/open-telemetry/semantic-conventions-genai/issues/243 **[summary]**
- [R14] MCP semantic conventions, `docs/gen-ai/mcp.md` in the repo above (status Development) **[summary]**
- [R15] MCP SEP-414, OpenTelemetry trace-context propagation in `_meta`: https://modelcontextprotocol.io/seps/414-request-meta **[docs]** (status Final)

**A2A protocol and SDKs**

- [R18] A2A "Enterprise ready" topic (tracing recommendation): https://a2a-protocol.org/latest/topics/enterprise-ready/ ; specification https://a2a-protocol.org/latest/specification/ ; extensions topic https://a2a-protocol.org/latest/topics/extensions/ **[docs]/[summary]**
- [R19] SDKs and proposals: https://github.com/a2aproject/a2a-python (`src/a2a/utils/telemetry.py`), https://github.com/a2aproject/a2a-js, protocol repo issues https://github.com/a2aproject/A2A/issues/2103 , /2026 , /2470 , /2257 ; python issues https://github.com/a2aproject/a2a-python/issues/168 , /281 ; traceability sample https://github.com/a2aproject/a2a-samples/tree/main/samples/python/extensions/traceability (spec URL returned 404) **[summary]**

**Consumers**

- [R20] Grafana Tempo: https://grafana.com/docs/tempo/latest/ ; service graphs https://grafana.com/docs/tempo/latest/metrics-from-traces/service_graphs/ ; span metrics https://grafana.com/docs/tempo/latest/metrics-from-traces/span-metrics/ ; TraceQL https://grafana.com/docs/tempo/latest/traceql/ ; collector setup https://grafana.com/docs/tempo/latest/set-up-for-tracing/instrument-send/set-up-collector/ **[docs]**
- [R21] Grafana Cloud AI Observability (OpenLIT): https://grafana.com/docs/grafana-cloud/monitor-applications/ai-observability/ and sub-pages (setup, `genai/observability`, `genai/agent-observability`) **[docs]**
- [R21a] Langfuse OpenTelemetry: https://langfuse.com/integrations/native/opentelemetry ; observation types https://langfuse.com/docs/observability/features/observation-types ; agent graphs https://langfuse.com/docs/observability/features/agent-graphs **[docs]**. Ingestion source code (`OtelIngestionProcessor`) **[unverified]**: not reachable.
- [R22] Arize Phoenix / OpenInference: span kinds https://arize.com/docs/phoenix/tracing/concepts-tracing/otel-openinference/span-kinds ; semantic conventions (OpenInference vs GenAI table) on the same docs site; cookbook "OpenInference best practices" **[docs]/[summary]**. The raw spec file `Arize-ai/openinference/spec/semantic_conventions.md` returned 404 **[unverified]**.

**Outside agents and backends**

- [R24] Google ADK: https://adk.dev/observability/traces/ , https://adk.dev/a2a/intro/ , source `google/adk-python` (`telemetry/tracing.py`, `telemetry/context.py`, `a2a/agent/_remote_a2a_agent.py`, `a2a/executor/a2a_agent_executor_impl.py`) **[docs]/[summary]**
- [R25] LangGraph / LangSmith: https://docs.langchain.com/langsmith/trace-with-opentelemetry.md , https://docs.langchain.com/langsmith/distributed-tracing.md , https://docs.langchain.com/langsmith/server-a2a.md , https://docs.langchain.com/langsmith/agent-server-distributed-tracing.md **[docs]/[summary]**
- [R26] Claude Code monitoring https://code.claude.com/docs/en/monitoring-usage ; Copilot SDK OpenTelemetry https://docs.github.com/en/copilot/how-tos/copilot-sdk/observability/opentelemetry ; Codex `[otel]` config (OpenAI developer docs) ; OpenCode config https://opencode.ai/docs/config/ **[docs]/[summary]**

**Propagation and trust**

- [R27] W3C Trace Context: https://www.w3.org/TR/trace-context/ **[docs]**
- [R28] W3C Baggage: https://www.w3.org/TR/baggage/ **[docs]**
- [R29] OpenTelemetry context propagation https://opentelemetry.io/docs/concepts/context-propagation/ ; SDK environment variables https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/ ; sampling and tracing SDK https://opentelemetry.io/docs/specs/otel/trace/sdk/ ; span links https://opentelemetry.io/docs/concepts/signals/traces/ ; messaging spans (processing spans and links) https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/ **[docs]**

- [R30] Elastic APM trace continuation: https://www.elastic.co/docs/reference/apm/agents/java/config-core (`trace_continuation_strategy`: `continue` / `restart` / `restart_external`, default `continue`) **[docs]**. Other Elastic agents not checked.
- [R31] Datadog propagation behaviour: https://docs.datadoghq.com/tracing/trace_collection/library_config/java/ (`DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT`: `continue` / `restart` / `ignore`, default `continue`) **[docs]**. Sentry (`strictTraceContinuation`) and New Relic (trusted account key) could not be located **[unverified]**.
- [R32] Edge handling: AWS X-Ray concepts https://docs.aws.amazon.com/xray/latest/devguide/xray-concepts.html ; Envoy header sanitizing https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_conn_man/header_sanitizing and headers reference https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_conn_man/headers **[docs]/[summary]**
- [R33] Grafana GenAI dashboards: https://github.com/grafana/grafana-aio11y-app/tree/main/mixin/genai-mixin/dashboards (`genai-observability.json`, `genai-agent-observability.json`, `mcp-observability.json`, `genai-evaluations.json`, `vectordb-observability.json`); the second half of three files was read through a summary **[docs]/[summary]**
- [R34] OpenLIT metrics and agent identity: https://github.com/openlit/openlit (`sdk/python/src/openlit/semcov/__init__.py`, `__helpers.py`), https://docs.openlit.io/latest/openlit/observability/agents/overview.md , OTel GenAI metrics `docs/gen-ai/gen-ai-metrics.md` and `gen-ai-token-metrics.md` in [R1] **[docs]/[summary]**
- [R35] A2A and MCP server-span rules (enrich the HTTP/gRPC server span; SDK `kind` detection): `docs/gen-ai/a2a.md` and `docs/gen-ai/mcp.md` in [R1]; OTel trace API https://opentelemetry.io/docs/specs/otel/trace/api/ ; JS context https://opentelemetry.io/docs/languages/js/context/ **[docs]/[summary]**
- [R36] Experiment (Appendix A): local, 2026-11-19; `@a2a-js/sdk` server state/headers confirmed in `node_modules/@a2a-js/sdk/dist/server/express/index.js` **[code]**


**This repository** **[code]**: `packages/core/src/telemetry/{context,instrument,api,attributes,emitter-bridge,observability,cli-bootstrap}.ts`, `packages/core/src/events/transport.ts`, `packages/core/src/server/factory.ts`, `docs/observability.md`, `docs/otel-attribute-ownership.md`, `examples/otel-stack/`, and `node_modules/@a2a-js/sdk/dist/server/express/index.js` (header state).

### Not verified (carry into the spikes)

Langfuse's `gen_ai.operation.name` → observation-type mapping and its handling of a missing remote parent; Phoenix's handling of `gen_ai.*`-only spans beyond the docs statement; Codex inbound traceparent behaviour; OpenCode OTel support; REST and gRPC header population (JSON-RPC is confirmed, Appendix A); the exact A2A attribute list beyond the merged `a2a.md` summary; the Prometheus names Grafana's dashboards see after OTLP translation (the dashboards show them, we have not verified the translation); Sentry's `strictTraceContinuation` and New Relic's trusted-account behaviour (pages not located); whether Elastic's other agents offer `trace_continuation_strategy`.

---

## Appendix A: Experiment results (2026-11-19)

**Question.** What does an A2A executor actually see for inbound trace context, and what happens to our span in a host that already has HTTP instrumentation?

**Method.** A real A2A server built from the same SDK handler stack the wrappers use (`DefaultRequestHandler` + `jsonRpcHandler`, `UserBuilder.noAuthentication`, agent card from core's `buildAgentCard`), Node 24, `@opentelemetry/sdk-trace-node` 2.x with an in-memory exporter and the default W3C propagator. The executor records `trace.getActiveSpan()` (name, SDK `kind`, recording), the headers in `ctx.context.state`, then starts (a) a span exactly as the wrapper does today (`tracer.startSpan("a2a.task.execute")`, default context) and (b) a span parented explicitly from `propagation.extract(headers)` with kind SERVER. Three requests per run: `message/send` with a `traceparent`, `message/stream` with a `traceparent`, and `message/send` without one. Run twice: with and without `@opentelemetry/instrumentation-http`.

**Results**

| | Without HTTP instrumentation (wrapper CLI default) | With `instrumentation-http` (typical auto-instrumented host) |
|---|---|---|
| Headers in `ctx.context.state.get("headers")` | **Present**, with the caller's `traceparent`, for `message/send` **and** `message/stream` | Same |
| Ambient active span in `execute()` | **None** | HTTP `POST` span, kind **SERVER**, recording, for send and stream |
| Today's `a2a.task.execute` (INTERNAL) | **Root of a new trace** (`2e6f98bf…`, not the caller's `0af76519…`) | **Child of the HTTP span**, in the caller's trace (`0af76519…`) |
| Explicit extraction + SERVER span (proposal) | Joins the caller's trace, parent = caller's span id | Also joins, **but as a sibling of the HTTP SERVER span**: two SERVER spans for one request |
| Request without `traceparent` | New root trace | HTTP span is the root; ours nests under it |

**Conclusions**

1. The mechanism in 8.2 works as designed: no middleware is needed to read `traceparent` (the P0-S1 question is answered for JSON-RPC blocking and streaming; REST and gRPC are still to confirm).
2. The trace break is **real but conditional**: it exists in the wrapper's default (no HTTP instrumentation) and not in auto-instrumented hosts. Both must keep working, which is why `otel.span.server` defaults to `auto`.
3. An always-extract design would duplicate SERVER spans in auto-instrumented hosts (measured), confirming the need for the detection in 8.4.
4. The SDK span exposes `kind`, and the ambient span is recording: the `auto` detection (recording + SDK kind SERVER) is feasible in this stack. The API `Span` interface has no `kind` getter, so the check must read the SDK object defensively.

**Limits.** One SDK version, JSON-RPC transport only, a synthetic executor (not a full wrapper), no sampling variations, no REST/gRPC. The script lives outside the repository; the contract tests in P1 reproduce it.

### A.2 REST transport and peer-address middleware (spikes P0-S1 and P0-S6, 2026-11-20)

Same server stack, with `restHandler` mounted next to `jsonRpcHandler` and an Express middleware, placed before both, that **overwrites** an internal header with the caller's address: `req.headers["x-a2a-peer"] = req.ip || req.socket.remoteAddress`. Requests were labelled by a header (not by order). Run twice: Express `trust proxy` off, and `trust proxy = "loopback"`.

| Request | `trust proxy` off | `trust proxy = loopback` |
|---|---|---|
| JSON-RPC + `traceparent` | `traceparent` present in executor headers; peer `127.0.0.1` | same |
| **REST** `POST /a2a/rest/message:send` (`A2A-Version: 1.0`) + `traceparent` | **`traceparent` present**; peer `127.0.0.1` | same |
| Client sends `x-a2a-peer: 1.2.3.4` | executor sees `127.0.0.1` (**spoof overwritten**) | `127.0.0.1` (overwritten) |
| Client sends `X-Forwarded-For: 203.0.113.9` (connection from loopback) | `127.0.0.1` (header ignored) | **`203.0.113.9`** (honoured because the loopback proxy is trusted) |

Conclusions: (1) REST carries the caller's headers to the executor like JSON-RPC, so the 8.2 mechanism holds for both transports core mounts (gRPC is not mounted by core); (2) the peer-address middleware is unspoofable and behaves as documented in 8.3, including the need to configure `trust proxy` behind a gateway. Not exercised: the v0.3 REST path (a request-body mistake in the probe, not a finding), IPv6 and proxies chains beyond one hop.

---

## Appendix B: MCP trace-context forwarding by backend (spike P0-S2, 2026-11-20)

**Question.** When a backend CLI executes an MCP tool call, does the MCP server receive W3C trace context, and in which carrier?

**Method.** Two instrumented probe MCP servers, one stdio and one streamable-HTTP, each logging the raw JSON-RPC request (including `params._meta`), all HTTP headers and the process `TRACEPARENT` env var. Each backend was asked, with a tiny prompt, to call both tools (`add_numbers`, `multiply_numbers`); every run returned the correct results (5 and 20). A known inbound context (`00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`) was supplied where a backend can accept one. Copilot was driven through `@github/copilot-sdk` (real CLI 1.0.68), OpenCode through the a2a-opencode wrapper against real servers (1.19.6 and 2.3.2), Claude Code and Codex through their own CLIs with per-invocation MCP config only.

**Results (observed in the server logs)**

| Backend | Mode | `tools/call` `_meta` (stdio / HTTP) | HTTP `traceparent` header | stdio server env `TRACEPARENT` |
|---|---|---|---|---|
| Copilot | no telemetry (with or without a supplied context, or env only) | `progressToken` only / same | none | only what was passed to the CLI at spawn |
| Copilot | telemetry on, no supplied context | `traceparent` (Copilot's own new trace) / same | none | – |
| Copilot | telemetry on + `onGetTraceContext` | `traceparent` with **our trace id**, fresh span id / same | none | – |
| Claude Code | plain | `claudecode/toolUseId` + `progressToken` / same | none | none |
| Claude Code | tracing beta on | same (no traceparent) / same | **yes** (Claude's own trace) | none |
| Claude Code | tracing beta on + `TRACEPARENT` env | same / same | **yes, our trace id**, fresh span id | the static value inherited at spawn |
| OpenCode 1.19.6 | default, and with `TRACEPARENT` on the server process | `progressToken` only / same | none | the static value inherited at spawn |
| OpenCode 2.3.2 | default, and with `TRACEPARENT` on the server process | `ai.opencode/sessionID` + `progressToken` / same | none | the static value inherited at spawn |
| Codex 0.167.2 | any | **not testable**: all tried model names (default, `gpt-5-codex`, `gpt-5`, `gpt-5.1-codex`, `o4-mini`) were rejected for the ChatGPT login on this machine | – | – |

**Conclusions**

1. Per-call context reaches an MCP server **only when the backend's own tracing is on**, and the carrier differs by backend: `_meta.traceparent` (Copilot) or an HTTP header (Claude Code). Both can carry **our** trace id when we hand the backend our context (Hook F does this).
2. stdio MCP servers get no per-call context from Claude Code; the env var is fixed at spawn and cannot identify a request.
3. OpenCode (either generation) forwards no trace context; OpenCode 2.x and Claude Code do send their own session or tool-use id in `_meta`, which a wrapper-side registry can resolve (8.6).
4. The earlier plan assumed one carrier (`_meta`); there are two, so the receiving bridge must accept both.

**Limits.** One version of each tool; one prompt per mode; Claude Code's tracing is a **beta** feature and Copilot's behaviour was observed on SDK-driven runs (the a2a-copilot wrapper's Hook F uses the same options but was not re-run here); Codex untested; Antigravity untested; only unauthenticated loopback MCP servers. Probe scripts and logs are outside the repository.
