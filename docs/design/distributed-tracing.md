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
| **D2** | **Inbound policy `parent \| link \| ignore`**, default `parent` when OTel is enabled, with strict header validation. | Parenting is what produces a connected graph; `link` and `ignore` exist because these endpoints are unauthenticated by default and W3C/OTel warn about untrusted inbound context ([R27], [R28], [R29]). |
| **D3** | The request span becomes **`SERVER` kind**; span *names* stay as today by default, with an opt-in `semconv` naming mode. | Tempo's service graph needs CLIENT/SERVER pairs ([R20]). Renaming spans would silently break existing dashboards, so it is opt-in first. |
| **D4** | Context reaches sub-agents through **MCP `_meta.traceparent`** (SEP-414, Final) first. A per-session bridge is a fallback only if the spike shows backends do not forward context. Needs a companion change in `a2a-mcp-skillmap`. | Backends call MCP tools with no per-request context; the standard answer is `_meta` ([R14], [R15]). |
| **D5** | Sideband events carry the **real W3C trace and span id**, plus `propagatedMetadata`; add `eventId`/`parentAgentId` to the A2A artifact; add `events.transport: "both"`; substitute `${VAR}` in event headers and exporter headers. | Today `AgentEvent.traceId` is the orchestrator's id or the `contextId`, so sideband events cannot be joined to our own spans [code]. |
| **D6** | **Platform "graph" views via opt-in compat attributes** (`langfuse.*`, `openinference.*`), not by changing the standard attributes. | Langfuse and Phoenix key their agent views on their own attributes; Phoenix says `gen_ai.*` spans "won't get the same UI treatment" ([R22]). |
| **D7** | **No wrapper-emitted metrics in the baseline.** Tempo derives RED metrics from spans; Langfuse and Phoenix derive from traces. Re-decide after the Grafana dashboard spike (P0-S5). | Grafana Cloud's AI dashboards are metrics-driven, but their required names are undocumented ([R21]). |
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
- We cannot assume an outside system exports to the same backend as us (Krama may have no backend). A remote parent that is never exported leaves our span with a missing parent in some backends (LangSmith drops it; Langfuse is undocumented). That is the reason for the `link` policy and the spike P0-S4.

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
| **S2** | `traceparent`/`tracestate` from HTTP headers; remote parent for `a2a.task.execute`. | n/a | P1. | Default policy `parent`. |
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
4. **Safe at a trust boundary.** Validate strictly, cap sizes, make `link`/`ignore` available, never copy arbitrary baggage into attributes.
5. **Do not duplicate backend spans.** Existing ownership rules (wrapper vs backend) are unchanged.
6. **Do not guess.** Where a backend's behaviour is undocumented, ship a spike before shipping behaviour.

### 8.2 Inbound context resolution

```
resolveInbound(ctx):
  headers = ctx.context.state.get("headers")         # raw HTTP headers (A2A SDK default context builder)
  meta    = merged request/message/task metadata    # as today (collectMetadata)

  candidate = first valid of:
     1. headers["traceparent"] (+ headers["tracestate"])
     2. meta["traceparent"]    (+ meta["tracestate"])        # carrier for clients that cannot set headers
  valid  := W3C format: version != "ff", 32-hex trace-id != 0, 16-hex parent-id != 0,
            v00 length == 55; tracestate: <= 32 members and <= 512 chars, else dropped
  if headers and meta both valid and different: header wins (log at debug)

  policy = otel.propagation.inbound            # parent | link | ignore (default: parent)
  parent  -> context = propagation.extract(carrier)          # remote parent (IsRemote=true)
  link    -> new root span + Link(candidate)                 # trusted-boundary pattern
  ignore  -> new root span, candidate discarded

  legacy ids (trace_id, parent_agent_id, propagated_metadata, conversation_id, session_id, gateway.*):
     always read as today -> attributes + event stamps. They never become a parent.
```

Notes:

- **Sampling is not ours to decide.** The host SDK's sampler applies (`parentbased_always_on` by default: an inbound `sampled=0` drops our spans, which keeps a caller's sampling decision consistent across hops).
- If OTel is disabled or `@opentelemetry/api` is absent, this is a no-op, as today.
- Duplicate carriers: `tracestate` is propagated unmodified when the parent is used (W3C: "MUST NOT" modify tracestate if traceparent is unchanged).

### 8.3 Trust policy

| Policy | Behaviour | Use when |
|---|---|---|
| `parent` (default when `otel.enabled`) | Join the caller's trace. | Agents inside one trust domain (the normal multi-agent case). |
| `link` | Start a new trace; add the inbound context as a span **link**. | The agent is reachable from untrusted callers, or callers do not export to the same backend (avoids "missing parent" in backends that drop orphans). |
| `ignore` | Ignore inbound context entirely. | Public, unauthenticated endpoint; or to preserve today's behaviour. |

Rationale for the default: it is the only setting that produces the connected graph (the goal), OTel's default behaviour is to continue the trace, and `otel.enabled` is already an explicit opt-in. W3C §7.2 and OTel both caution about public endpoints; our docs must say plainly that **unauthenticated + `parent` lets any caller choose your trace id and sampling flag** and recommend `link` or `ignore` there. *This default is the first open question (Q1).*

### 8.4 Span model

| Property | Today | Proposed |
|---|---|---|
| Parent | active context | inbound remote parent per 8.2 |
| Kind | unset (INTERNAL) | **SERVER** |
| Name | `a2a.task.execute` / `a2a.task.cancel` | unchanged by default; `otel.spanNaming: "semconv"` → `invoke_agent {gen_ai.agent.name}` |
| `a2a.method.name` | `message/send` | map to A2A v1 names (`SendMessage`, `SendStreamingMessage`, `CancelTask`) per [R10]; keep the old value in `a2a.method.legacy_name` for one release |
| Status | exception → ERROR | unchanged; plus ERROR on `failed` terminal task state |
| Links | prior attempt (`a2a.task.link_reason`) | unchanged; plus inbound link under `link` policy |

Why one span and not the spec-pure two (SERVER `SendMessage` → INTERNAL `invoke_agent`): it keeps the repo's "one request, one span" rule, gives Tempo its SERVER half, and gives Langfuse/Phoenix an agent-typed span. The two-span form is recorded as a Tier 2 option (section 9) if backends or the spec require it.

### 8.5 Compat attributes (opt-in)

`otel.compat: ["langfuse", "openinference"]` (default: none). Each adds a small, fixed set of attributes; none changes the standard ones.

| Span | `langfuse` adds | `openinference` adds |
|---|---|---|
| Request span (`a2a.task.execute`) | `langfuse.observation.type=agent` | `openinference.span.kind=AGENT`, `agent.name`, `graph.node.id=<agentId>`, `graph.node.name=<agentName>`, `graph.node.parent_id=<parent_agent_id>` **only when a parent agent is known** |
| Mirrored tool span (`a2a.mcp.tool`) | `langfuse.observation.type=tool` | `openinference.span.kind=TOOL`, `tool.name` |
| Trace-level | (`session.id` already set) | (`session.id` already set) |

Not added in the baseline: `input.value`/`output.value`/`langfuse.observation.input|output` (they carry content; gated behind the existing content-capture stance), `llm.token_count.*` (would mislabel an AGENT span as an LLM span; usage stays on `a2a.task.usage.*` and backend LLM spans per the ownership doc).

### 8.6 Sub-agent propagation (callers)

The wrapper does not call sub-agents itself; `a2a-mcp-skillmap` does, as an MCP tool invoked by the backend CLI. Two facts shape the design: (a) backend CLIs invoke MCP tools **without per-request context**, and (b) the standard carrier for tool calls is `params._meta.traceparent` (SEP-414).

```
backend CLI ── tools/call (+ _meta.traceparent, if the CLI forwards it) ──▶ skillmap
skillmap: CLIENT span "SendMessage" (parent = _meta.traceparent)
          └─ HTTP POST to sub-agent with traceparent header (inject)
sub-agent: SERVER span a2a.task.execute (parent = that CLIENT span)   <- this design's P1
```

Decision tree (to be settled by spike P0-S2):

1. **If the backends forward context in `_meta`/headers** (Claude Code documents `traceparent` on HTTP MCP requests; Copilot SDK hands `traceparent` to tool handlers; Codex/OpenCode unknown): implement *only* the skillmap side (accept `_meta.traceparent`, create the CLIENT span, inject the header). No wrapper-side bridge.
2. **If some backends do not**: add a **per-session, wrapper-hosted MCP bridge** for those backends. Each session registers a unique bridge endpoint; the bridge knows the session's currently executing task and its active context, so it supplies the context itself. This is the "(b)" option in #49 and is Tier 2 because of its size.
3. Whatever the case, wrapper-side correlation attributes (`parent_agent_id`, `propagated_metadata`) keep flowing as metadata so S3-style attribution still works for backends that forward nothing.

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

```jsonc
{
  "otel": {
    "enabled": true,
    "exporter": { "endpoint": "…", "protocol": "http/protobuf", "headers": { "Authorization": "Basic ${LANGFUSE_AUTH}" } },
    "propagation": { "inbound": "parent" },     // parent | link | ignore
    "compat": ["langfuse", "openinference"],    // default []
    "spanNaming": "legacy"                      // legacy | semconv
  },
  "events": { "transport": "both", "httpUrl": "${COLLECTOR_URL}", "httpHeaders": { "Authorization": "Bearer ${TOKEN}" } }
}
```

JSON schemas for all five wrappers and `@a2a-wrapper/core` are regenerated (the existing `schema-up-to-date` tests enforce this).

### 8.10 Compatibility and migration

| Change | Visible effect | Mitigation |
|---|---|---|
| Span kind INTERNAL → SERVER | Appears in service graphs / span metrics (`span_kind` label). | Document in changeset; intended. |
| Inbound parenting | Traces from instrumented callers now connect. Orphan risk in backends that drop spans with unexported parents. | `link` / `ignore` policies; spike P0-S4; docs. |
| `a2a.method.name` values | Dashboards filtering on `message/send` | Keep legacy value under a second key for one release. |
| New artifact fields / event fields | Additive | none |
| `semconv` naming | Opt-in only; default flip considered for a major release | none |

### 8.11 Security and privacy

- Validate `traceparent`/`tracestate` strictly (W3C §7); ignore invalid headers instead of failing the request.
- Cap sizes for tracestate and `propagatedMetadata`; apply the existing secret redaction to propagated metadata.
- Never copy inbound `baggage` into attributes by default; an allow-list setting (`otel.propagation.baggageAttributes`, default empty) can map named keys to attributes. Baggage is forwarded only by the host SDK's propagators, as today.
- Never put identifiers other than W3C-defined fields into `traceparent`/`tracestate`.
- Unauthenticated endpoints: docs state the risk and recommend `link`/`ignore`.
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
| Inbound policy `link`/`ignore` + strict validation | orphan handling | – | – | trust boundary | S | **1** (ships with the Tier 0 parenting) |
| `${VAR}` in event headers; `propagatedMetadata` on events; `eventId`/`parentAgentId` on artifact | – | – | – | Krama-style attribution | S | **1** |
| `events.transport: "both"` | – | – | – | dedupe by `eventId` | S | **1** |
| `compat: langfuse` (`observation.type`) | **agent graph** | – | – | – | S | **1** |
| `compat: openinference` (`span.kind`, `graph.node.*`) | – | **icons + graph** | – | – | S | **1** |
| Sub-agent forwarding via `_meta` (skillmap companion) | cross-agent graph | cross-agent graph | cross-agent service graph | S1/S5 | M (+ companion) | **1** (after spike P0-S2) |
| `spanNaming: "semconv"` and A2A v1 method names | maybe type mapping | – | – | spec alignment | S | **1** |
| Two-span model (SERVER `SendMessage` + INTERNAL `invoke_agent`) | – | – | spec-pure | – | M | 2 |
| GenAI/A2A duration metrics | – | – | Grafana AI dashboards (undocumented) | – | M | 2 (after P0-S5) |
| Per-session wrapper-hosted MCP bridge | – | – | – | backends that drop context | L | 2 (only if P0-S2 requires) |
| A2A carriers in message metadata via an official extension | – | – | – | when A2A settles #2103 | S | 2 (we already read `meta.traceparent`) |
| Span links for `input-required` resume across requests | – | – | – | already present (prior attempt) | done | – |

---

## 10. Implementation plan

Sizes: S ≈ ≤1 day, M ≈ 2–4 days, L ≈ 1–2 weeks. Each phase is a separate PR with a changeset and docs.

### P0: Spikes (de-risk before building)

| ID | Question | Method | Decides |
|---|---|---|---|
| **P0-S1** | Does `ctx.context.state.get("headers")` carry `traceparent` for JSON-RPC, REST, **streaming** and gRPC? | Two-line executor probe + curl with a `traceparent` header. | 8.2 mechanism. |
| **P0-S2** | Which backends forward trace context to MCP tool calls (`_meta.traceparent` or header)? | A tiny MCP server that logs `_meta` and headers (we already have one), driven by Copilot and OpenCode on this machine; Claude/Codex per their docs and, where installed, live. | D4 branch (1 vs 2). |
| **P0-S3** | Do ADK and LangGraph clients send `traceparent` to our agent? | Minimal ADK `RemoteA2aAgent` and LangGraph A2A client scripts against a wrapper that logs headers; try with and without `opentelemetry-instrumentation-httpx`. | Docs for callers; S2 vs S3 expectations. |
| **P0-S4** | How do Phoenix (local, per `examples/otel-stack`) and Langfuse treat a span whose remote parent was never exported? | Send a synthetic trace with a missing parent to each. | Default inbound policy (Q1). |
| **P0-S5** | What exactly do Grafana Cloud's AI dashboards query? | Read the OpenLIT dashboard definitions / SDK metric names. | D7 (metrics in or out). |

Exit: findings appended to this document; decisions D2/D4/D7 confirmed or changed.

### P1: Join the trace (Tier 0)  *(core + all wrappers; M)*

| Work item | Files |
|---|---|
| `resolveInbound()` per 8.2: header then metadata carrier, strict validation, policies | `packages/core/src/telemetry/context.ts`, new `propagation.ts` |
| Parent the request span from the resolved context; set kind `SERVER`; `link` policy | `telemetry/instrument.ts`, `api.ts` (`withSpan` accepts parent context and kind) |
| `otel.propagation.inbound` in config + schema | `config/types.ts`, wrapper schemas |
| `a2a.method.name` v1 names (+ legacy key) | `telemetry/attributes.ts` |
| Stamp `otelTraceId`/`otelSpanId` on `AgentEvent` | `events/transport.ts` (`AgentEventEmitter`) |
| Exporter `headers` with `${VAR}` | `telemetry/cli-bootstrap.ts`, config, loader |
| Docs + changeset (core minor, wrappers minor) | `observability.md`, ownership doc |

**Acceptance:** (1) a request carrying a valid `traceparent` produces a request span whose parent is that span id (same trace id), for JSON-RPC, REST and streaming; (2) invalid headers are ignored and logged at debug, request still succeeds; (3) `link` produces a new trace with one link to the inbound context; `ignore` produces a new trace; (4) with no context, behaviour is unchanged; (5) span kind is SERVER; (6) events carry the active span's trace/span ids; (7) two real wrappers on this machine, A then B with a header-injecting client, show one trace in an in-memory exporter.

**Tests:** unit (validation matrix, policies) with the OTel in-memory span exporter; one contract test per wrapper with a fake backend; a cross-agent integration test (two executors); a local Phoenix check using `examples/otel-stack`.

### P2: Event attribution and plumbing (Tier 1)  *(core; M)*

`propagatedMetadata` + size/charset caps on events and `x-usage`; `eventId`/`parentAgentId`/`otelTraceId`/`otelSpanId` on the A2A artifact; `events.transport: "both"`; `${VAR}` in event URL/headers for all five loaders. **Acceptance:** every event on both transports carries the stamped fields; `both` emits two copies with equal `eventId`; missing env var warns once. Closes the core of #49 items 2, 4, 5.

### P3: Platform compat attributes (Tier 1)  *(core; S)*

`otel.compat` per 8.5; docs recipes (8.8) verified against local Phoenix and, where an account exists, Langfuse. **Acceptance:** with `compat: ["openinference"]` Phoenix shows AGENT icon; with `compat: ["langfuse"]` the observation is typed `agent`; with neither, attribute set is unchanged (snapshot test).

### P4: Forward to sub-agents (Tier 1)  *(companion repo + wrapper; M + companion)*

Shape depends on P0-S2. Always: file the companion issue in `a2a-mcp-skillmap` (accept `_meta.traceparent`; create CLIENT span; inject `traceparent` into outgoing A2A requests; pass `parent_agent_id` and `propagated_metadata`); wrapper-side: ensure the active context is available to whatever forwards it. If P0-S2 shows gaps, scope the per-session bridge as its own design. **Acceptance:** the #49 criterion "A calls B → B's events carry A's trace id, `parentAgentId = A`, propagated metadata", demonstrated with two real wrappers and at least one backend that forwards context.

### P5: Semconv naming (Tier 1, opt-in)  *(core; S)*

`otel.spanNaming: "semconv"` → `invoke_agent {name}`; docs on migrating dashboards; deprecation plan for flipping the default in the next major. **Acceptance:** both names selectable; default unchanged.

### P6: Conditional work (Tier 2)

Decide after P0-S5/P0-S4/P4: GenAI duration metrics, two-span model, per-session bridge, A2A-extension carrier.

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
| Orphan spans in backends that drop unexported parents | Medium | Traces missing | `link` policy; P0-S4; docs |
| Untrusted callers choose trace id/sampling | Medium (agents are unauthenticated by default) | Trace flooding | Strict validation; `link`/`ignore`; documented |
| Backends do not forward context to MCP tools | Medium | S1/S5 incomplete | D4 branch 2; attribute-level correlation still works |
| Duplicate SERVER spans when a host also runs HTTP auto-instrumentation | Medium | Double spans | Detect an active SERVER span context and skip/downgrade (open question Q3) |
| Grafana AI dashboards need metrics we do not emit | High | Dashboards empty | Out of baseline by design; P0-S5; P6 |

### Open questions for the owner

1. **Q1.** Is `parent` the right default for the inbound policy given endpoints are unauthenticated by default? (This document proposes `parent` with strong docs; `link` is the conservative alternative.)
2. **Q2.** Should `session.id` default to the A2A `contextId` (current behaviour) or only to an explicit `session_id`? (Current behaviour kept.)
3. **Q3.** When the host already runs HTTP server instrumentation, do we nest under that span (A2A semconv: enrich it) or still create ours?
4. **Q4.** Do we want `gen_ai.provider.name` on the request span (the backend provider)? The spec requires it on the CLIENT variant only.
5. **Q5.** Appetite for GenAI/A2A metrics if P0-S5 shows Grafana's dashboards require them?

---

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

**This repository** **[code]**: `packages/core/src/telemetry/{context,instrument,api,attributes,emitter-bridge,observability,cli-bootstrap}.ts`, `packages/core/src/events/transport.ts`, `packages/core/src/server/factory.ts`, `docs/observability.md`, `docs/otel-attribute-ownership.md`, `examples/otel-stack/`, and `node_modules/@a2a-js/sdk/dist/server/express/index.js` (header state).

### Not verified (carry into the spikes)

Langfuse's `gen_ai.operation.name` → observation-type mapping and its handling of a missing remote parent; Phoenix's handling of `gen_ai.*`-only spans beyond the docs statement; Codex inbound traceparent behaviour; OpenCode OTel support; whether `ctx.context.state.get("headers")` is populated for streaming requests; the exact A2A attribute list beyond the merged `a2a.md` summary; what Grafana Cloud's AI dashboards query.
