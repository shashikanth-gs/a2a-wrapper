# Observability

How to collect traces from `a2a-*` wrappers with [OpenTelemetry](https://opentelemetry.io/), and how that relates to A2A sideband `trace.*` artifacts.

## Two channels (keep both)

| Channel | Purpose | Transport |
|---|---|---|
| **A2A sideband** (`trace.mcp`, `trace.usage`, …) | Orchestrators and A2A clients | Event bus / optional HTTP event transport |
| **OpenTelemetry** | Platform collectors (Phoenix, Grafana Tempo, Langfuse, …) | OTLP |

Sideband is unchanged when you enable OTel. OTel does **not** replace A2A artifacts.

## Dependency model

| Package | Role |
|---|---|
| `@opentelemetry/api` | Optional peer of `@a2a-wrapper/core` — create spans / propagate context |
| OpenTelemetry **SDK** + OTLP exporter | Owned by **your host app** or a wrapper CLI bootstrap — **not** a hard dependency of core |

Without a registered `TracerProvider`, wrapper span calls are no-ops (zero overhead for most installs).

### Register a tracer (library / host)

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { trace } from "@opentelemetry/api";
import { setOtelTracer } from "@a2a-wrapper/core";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: "http://127.0.0.1:4318/v1/traces" }),
});
await sdk.start();

setOtelTracer(trace.getTracer("a2a-wrapper"));
```

### CLI bootstrap (Phase 4)

Wrapper CLIs call `bootstrapOtelSdkFromConfig` when `otel.enabled` and
`otel.exporter.endpoint` are set. That **dynamically imports** optional peers
(`@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`). If they
are missing, the process continues with no-op spans.

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto
```

Use `@opentelemetry/exporter-trace-otlp-http` only when `otel.exporter.protocol` is
`"http/json"`. Phoenix’s `/v1/traces` accepts **protobuf only** (`application/x-protobuf`).

### Local demo — Phoenix (no Docker required)

```bash
pip install 'arize-phoenix'
phoenix serve
# UI + OTLP HTTP: http://localhost:6006  (traces → /v1/traces)
# OTLP gRPC:      http://localhost:4317
```

Optional Docker image is in [`examples/otel-stack`](../examples/otel-stack) if you prefer compose.

**BYOK cookout (recommended):** shared fake Ollama + real wrapper CLIs — no cloud keys:

```bash
phoenix serve   # terminal 1
node examples/otel-stack/cookout-byok.mjs   # terminal 2
```

The LLM stub is [`examples/mock-ollama`](../examples/mock-ollama/) (reusable for
any feature, not just OTel). The cookout points `a2a-copilot` at `/v1`
(Responses API) and `a2a-claude` at `ANTHROPIC_BASE_URL` (Messages API), sends
A2A `message/send`, and checks Phoenix for `a2a.wrapper.sdk` spans.

Provider-only smoke (no Phoenix): `node examples/mock-ollama/smoke.mjs`.

## Agent config

```json
{
  "otel": {
    "enabled": true,
    "mirrorAgentEvents": false,
    "taskUsageRollup": true,
    "annotateUsageCalls": false,
    "exporter": {
      "endpoint": "http://127.0.0.1:6006",
      "protocol": "http/protobuf"
    },
    "backend": {
      "copilot": {
        "otlpEndpoint": "http://127.0.0.1:6006",
        "exporterType": "otlp-http",
        "propagateTraceContext": true
      }
    }
  }
}
```

**Structure (important):**

- **Wrapper-level (common to all packages):** `enabled`, `exporter`, `serviceName`,
  feature flags (`taskUsageRollup`, `annotateUsageCalls`, `mirrorAgentEvents`, …).
- **Provider-specific only under `otel.backend.<this-package>`:** Copilot’s OTLP
  knobs, Claude’s subprocess env flags, Codex’s `[otel]` overrides, OpenCode’s
  server flag. Each wrapper’s JSON Schema exposes **only its own** backend key
  (OpenCode does **not** list Codex, etc.).

| Field | Meaning |
|---|---|
| `otel.enabled` | Emit wrapper spans such as `a2a.task.execute` |
| `otel.exporter.endpoint` | Shared OTLP hint inherited by backends when their own endpoint is omitted |
| `otel.mirrorAgentEvents` | Also turn sideband tool events into wrapper OTel tool spans (default `false`) |
| `otel.taskUsageRollup` | Stamp `a2a.task.usage.*` (± `gen_ai.usage.*`) on the task span (default `true`; sideband `x-usage` always) |
| `otel.annotateUsageCalls` | Per-call `a2a.llm.call` span **events** when wrapper is sole token source (default `false`; Claude/Codex wired) |
| `otel.backend.copilot` | **a2a-copilot only** — Hook F: Copilot CLI OTLP + `onGetTraceContext` |
| `otel.backend.claude` | **a2a-claude only** — Hook F: `CLAUDE_CODE_ENABLE_TELEMETRY` + `OTEL_*` + `TRACEPARENT` |
| `otel.backend.codex` | **a2a-codex only** — Hook F: merged into Codex `configOverrides.otel` |
| `otel.backend.opencode` | **a2a-opencode only** — declares OpenCode server OTel on (de-dupe) |
| `otel.propagation.*` / `otel.span.*` | Inbound trace-context policy and request-span kind; see [Joining the caller’s trace](#joining-the-callers-trace-distributed-tracing) |
| `otel.spanNaming` | `legacy` (default) keeps `a2a.task.execute` / `a2a.mcp.tool {tool}`; `semconv` uses the OpenTelemetry GenAI names `invoke_agent {agent}` / `execute_tool {tool}` (see [Span naming](#span-naming)) |
| `otel.compat` | Opt-in Langfuse / Phoenix attribute sets (see [Platform compatibility](#platform-compatibility-langfuse-and-phoenix)); default none |
| `otel.exporter.headers` | Extra OTLP request headers (`${VAR}` substitution, never logged) |
| `otel.emitOverlappingBackendSpans` | Unsafe; allow duplicates (debug only) |

Every wrapper stamps package identity on `a2a.task.execute`:

| Attribute | Value |
|---|---|
| `a2a.wrapper.core.version` | `@a2a-wrapper/core` version |
| `a2a.wrapper.sdk` | e.g. `a2a-claude`, `a2a-copilot` |
| `a2a.wrapper.sdk.version` | that package’s version |

### Mental model (keep this simple)

**~99% of traffic: one inbound A2A request → one wrapper span** (`a2a.task.execute`).
We do **not** invent a span tree “for every purpose.” Either:

1. open that one wrapper span and parent-link the backend (Copilot/Claude/…) into the same trace, **or**
2. just **pass the same correlation IDs** through (`gen_ai.conversation.id`, `a2a.task.id`, `a2a.message.id`) so Langfuse / Datadog / Phoenix can group turns even when `trace_id` changes.

A2A OTel conventions are still evolving ([semantic-conventions-genai#254](https://github.com/open-telemetry/semantic-conventions-genai/issues/254)). Context propagation is **not** the only join key — platforms group multi-turn work by **session/conversation attributes**.

| ID | Typical source | Lifespan |
|---|---|---|
| `gen_ai.conversation.id` | A2A `contextId` (or gateway conversation id) | Whole chatbot thread |
| `a2a.task.id` | A2A task | Logical unit of work (may span `input-required` + resume) |
| `a2a.message.id` | Inbound A2A message | One request / one turn |
| `trace_id` / `traceparent` | W3C context | **Usually one request**; new UI call ⇒ often a new trace |

### What appears in Phoenix / Tempo / Langfuse (happy path)

One **request** = one wrapper span + backend children (not one merged span):

```
a2a.task.execute          ← wrapper (Node), one per inbound request
  └─ Copilot / Claude …   ← backend CLI/runtime (same collector, parent-linked when configured)
```

### Joining the caller's trace (distributed tracing)

By default `a2a.task.execute` joins the trace of whoever called the agent, so an orchestrator, the wrapper and the backend show up as one connected trace. The wrapper reads a W3C `traceparent` (and `tracestate`) from the HTTP request headers (JSON-RPC and REST, blocking and streaming), then from the A2A message `metadata` as a fallback for callers that cannot set headers. Invalid values (wrong length, upper case, all-zero ids, version `ff`, repeated headers) are ignored, never half-trusted.

```json
{
  "otel": {
    "enabled": true,
    "propagation": {
      "inbound": "continue",
      "trustedPeers": ["10.0.0.0/8"],
      "untrusted": "restart",
      "carriers": ["header", "metadata"]
    },
    "span": { "server": "auto", "enrichServerSpan": false }
  },
  "server": { "trustProxy": "loopback" }
}
```

| Setting | Env override | Values (default first) | Meaning |
|---|---|---|---|
| `otel.propagation.inbound` | `A2A_OTEL_INBOUND` | `continue` \| `restart` \| `ignore` | `continue` joins the caller's trace. `restart` starts a new trace and adds a span link to the caller. `ignore` starts a new trace and discards the caller's context. |
| `otel.propagation.trustedPeers` | `A2A_OTEL_TRUSTED_PEERS` (comma list) | `[]` | CIDRs or IPs allowed to supply trace context. Empty means everyone. Callers outside the list get `untrusted`. Unknown addresses fail closed. |
| `otel.propagation.untrusted` | `A2A_OTEL_UNTRUSTED` | `restart` \| `ignore` | Policy for callers outside `trustedPeers`. |
| `otel.propagation.carriers` | `A2A_OTEL_CARRIERS` | `["header","metadata"]` | Where to look, in order of precedence. |
| `otel.span.server` | `A2A_OTEL_SERVER_SPAN` | `auto` \| `own` \| `nest` | `auto` nests under an existing recording SERVER span (for example from `@opentelemetry/instrumentation-http`) and otherwise creates its own SERVER span. `own` always creates one (duplicates a SERVER span if HTTP instrumentation is active). `nest` never extracts and always uses an INTERNAL span. |
| `otel.span.enrichServerSpan` | `A2A_OTEL_ENRICH_SERVER_SPAN` | `false` | Copy `a2a.task.id`, `a2a.context.id`, `a2a.message.id`, `gen_ai.conversation.id` and `gen_ai.agent.name` onto the ambient HTTP SERVER span. |
| `server.trustProxy` | none | Express `trust proxy` value | Set behind a gateway so the caller address used by `trustedPeers` is the real client, not the proxy. |

Trust, in one paragraph: an unauthenticated endpoint plus `continue` lets any caller choose your trace id and sampling decision, which can force sampling or pollute another team's trace. For public or semi-public endpoints use `trustedPeers` (with `untrusted: "restart"`) or set `inbound` to `restart`/`ignore`. The caller address comes from the socket (or `X-Forwarded-For` only when `server.trustProxy` allows it); a client-supplied `x-a2a-peer` header is always overwritten.

Every request span also records `a2a.propagation.policy` (`continue`, `restart`, `ignore`, or `nested`) and `a2a.propagation.source` (`header`, `metadata`, or `none`), so you can see why a trace was or was not connected.

Backend or collector auth: `otel.exporter.headers` (values accept `${VAR}`, never logged) or the standard `OTEL_EXPORTER_OTLP_HEADERS`. Events sent through the event transport now carry `otelTraceId` / `otelSpanId` (and `otel_trace_id` / `otel_span_id` on A2A artifact data) so a collector can join them to the trace.

Design, trade-offs and measurements: [`docs/design/distributed-tracing.md`](design/distributed-tracing.md).

### Span naming

`otel.spanNaming` (env `A2A_OTEL_SPAN_NAMING`) chooses the span **names**; attributes are identical in both modes.

| Span | `legacy` (default) | `semconv` |
|---|---|---|
| Request | `a2a.task.execute` | `invoke_agent {gen_ai.agent.name}` |
| Mirrored tool call (`mirrorAgentEvents`) | `a2a.mcp.tool {tool}` | `execute_tool {tool}` |
| Cancel | `a2a.task.cancel` | `a2a.task.cancel` (no GenAI equivalent) |

The OpenTelemetry GenAI conventions are still in Development, so `legacy` stays the default until they stabilise. Switching changes span names, so update any dashboard, alert or query that matches on them first; Langfuse and Phoenix do not depend on the name (use `otel.compat`). A future major release may flip the default; the change will be announced in the changelog.

### Platform compatibility (Langfuse and Phoenix)

Langfuse and Phoenix build their agent views from their **own** attributes, and Phoenix gives plain `gen_ai.*` spans no special treatment. `otel.compat` adds a small fixed set of those attributes **next to** the standard ones. It never changes or removes a standard attribute, and with no compat selected the attribute set is exactly what it was before.

```json
{ "otel": { "enabled": true, "compat": ["langfuse", "openinference"] } }
```

Environment override: `A2A_OTEL_COMPAT=langfuse,openinference` (`none` clears it).

| Span | `langfuse` adds | `openinference` adds |
|---|---|---|
| Request span (`a2a.task.execute`) | `langfuse.observation.type=agent` | `openinference.span.kind=AGENT`, `agent.name`, `graph.node.id`, `graph.node.name`, and `graph.node.parent_id` **only when the caller sent `parent_agent_id`** |
| Mirrored tool span (`a2a.mcp.tool`, needs `mirrorAgentEvents`) | `langfuse.observation.type=tool` | `openinference.span.kind=TOOL`, `tool.name` |

Not added on purpose: `input.value` / `output.value` / `langfuse.observation.input|output` (they carry content) and `llm.token_count.*` (would mislabel an AGENT span as an LLM span; usage stays on `a2a.task.usage.*`).

| Backend | Endpoint / protocol | Use |
|---|---|---|
| Langfuse | `<host>/api/public/otel`, `http/protobuf` or `http/json`, **not gRPC**; headers `Authorization: Basic <base64 pk:sk>` and `x-langfuse-ingestion-version: 4` (via `otel.exporter.headers` with `${VAR}`, or `OTEL_EXPORTER_OTLP_HEADERS`) | `compat: ["langfuse"]` |
| Phoenix | `http://<host>:6006/v1/traces`, `http/protobuf` **only** | `compat: ["openinference"]` |
| Grafana Tempo | OTLP gRPC `:4317` or HTTP `:4318` | No compat needed |

### Event attribution and transports

Sideband events (tool calls, lifecycle, usage) are stamped so a collector can join them to the trace and to the calling agent:

| Field (HTTP / custom transport) | A2A artifact | Meaning |
|---|---|---|
| `eventId` | `metadata.eventId`, `data.event_id` | Unique per event; identical on every transport copy |
| `otelTraceId`, `otelSpanId` | `metadata.otelTraceId/otelSpanId`, `data.otel_*` | Real W3C ids of the request span (omitted when OTel is off) |
| `parentAgentId` | `metadata.parentAgentId`, `data.parent_agent_id` | Calling agent, from the orchestrator's `parent_agent_id` |
| `propagatedMetadata` | `data.propagated_metadata` | Orchestrator's `propagated_metadata`, bounded (64 keys, 8 KB, key charset `[A-Za-z0-9_.-]`); values of secret-looking keys are `[redacted]` |

`events.transport` accepts `a2a` (default), `http`, or `both`. With `both` the A2A artifact and the HTTP POST carry the same `eventId`; one failing never blocks the other. `events.httpUrl` and `events.httpHeaders` values accept `${VAR}`, and `A2A_EVENTS_TRANSPORT` / `A2A_EVENTS_HTTP_URL` override the JSON.

### Re-entry, resume, retries (the ~1% the wrapper must handle)

The wrapper **cannot stop** the orchestrator (or another agent) from calling again:

| Case | What happens | How we mark it |
|---|---|---|
| First `execute` for a task | New request, no prior `ctx.task` | `a2a.task.invocation=1`, `invocation_kind=new` |
| Follow-up / `input-required` resume | Orchestrator sends another message; SDK sets `ctx.task` | New span, **same** `a2a.task.id` + conversation id, `invocation_kind=continue` |
| Client retry after failure | Same task id, often no `ctx.task` yet | New span, same ids, `invocation_kind=retry` |

So: **still one span per request** — never a multi-purpose span factory. Platforms join those spans via the stable IDs (session/conversation view), not by forcing one eternal parent across human wait time.

When a prior in-process attempt exists, the new span also gets an OTel **span link** (`a2a.task.link_reason=continue|retry`) for Tempo/Phoenix. Langfuse/Datadog still primarily group on `gen_ai.conversation.id`.

### Phase 3 — Backend passthrough (Hook F)

Wired in wrappers today:

| Wrapper | Config | What happens |
|---|---|---|
| **Copilot** | `otel.backend.copilot` | SDK `telemetry` on spawn + `onGetTraceContext` → active `a2a.task.execute` |
| **Claude** | `otel.backend.claude.enableTelemetry` | Subprocess env: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_*`, `TRACEPARENT` |
| **Codex** | `otel.backend.codex` | Merged into CLI `[otel]` via `configOverrides` |
| **OpenCode** | `otel.backend.opencode.openTelemetry` | Policy/de-dupe only — turn on OpenCode’s own server flag |
| **Antigravity** | — | No backend OTel; use `mirrorAgentEvents: true` for tool detail |

Notes:

- Copilot `telemetry` env applies when the SDK **spawns** the CLI. With external `copilot.cliUrl`, set OTEL on that process yourself; `onGetTraceContext` still parent-links RPCs.
- Prefer collector **OTLP HTTP `:4318`** when mixing Copilot + Node SDK (Claude can use HTTP or gRPC).
- Hosts still register the wrapper `TracerProvider` (see above); Hook F only configures **backend** exporters + propagation.

## Wrapper span attributes (selected)

| Attribute | Source |
|---|---|
| `a2a.task.id` / `a2a.context.id` | A2A task / context |
| `a2a.message.id` | Inbound A2A `userMessage.messageId` when present |
| `a2a.task.invocation` / `a2a.task.invocation_kind` | In-process execute count: `new` / `continue` / `retry` |
| `gen_ai.agent.name` / `a2a.agent.name` | `agentCard.name` |
| `gen_ai.conversation.id` | A2A `contextId` (platform session join key) |
| `a2a.wrapper.core.version` | `@a2a-wrapper/core` package version |
| `a2a.wrapper.sdk` / `.sdk.version` | Which `a2a-*` package + version (also mirrored as `.name` / `.version`) |
| `a2a.task.usage.*` | Per-**request** rollup from `LlmUsageAccumulator` when `otel.taskUsageRollup` (default on) |
| `gen_ai.usage.*` on task span | **Only when backend OTel is off** (fallback sole source) |

**Ownership reminder:** wrapper owns A2A/protocol + correlation IDs. Backend owns per-call `gen_ai.usage.*` on LLM spans when its OTel is on. Do not treat the wrapper as the universal owner of GenAI token attrs ([#254](https://github.com/open-telemetry/semantic-conventions-genai/issues/254) is still drafting A2A shape).

Full matrix + gateway metadata mapping: [otel-attribute-ownership.md](./otel-attribute-ownership.md).

## Usage / tokens — do not double-count

Backends (Copilot, Claude, Codex, …) already report tokens via SDK events. We keep that on the **A2A sideband** (`trace.usage`, `metadata["x-usage"]`) always — that is not OTLP. The task usage summary is also sent through the configured **event transport** (HTTP collector or custom) as the `usage` field of the `agent_finished` event (and `agent_error` for Copilot), so a collector can account for worker usage without reading the A2A response. Copilot, Claude and Codex do this; see each package README for the exact payload.

For **OpenTelemetry**:

| Situation | What the wrapper puts on `a2a.task.execute` | What the backend puts on LLM spans |
|---|---|---|
| Wrapper OTel only | `a2a.task.usage.*` **and** `gen_ai.usage.*` | nothing |
| Wrapper + backend OTel | `a2a.task.usage.*` only (A2A task total) | `gen_ai.usage.*` on vendor LLM spans |

Rules:

1. **Never** open a second LLM span just to carry usage.
2. **Never** emit wrapper token **metrics** that sum with backend GenAI metrics (Phase 2 does not add counters).
3. Dashboards: either sum `gen_ai.usage.*` on backend LLM spans **or** read `a2a.task.usage.*` on `a2a.task.execute` — not both.
4. Copilot, Antigravity, Claude, and Codex call `applyUsageSummaryToActiveSpan` on completed turns (per-request rollup; opt out with `otel.taskUsageRollup: false`).
5. Claude/Codex also call `applyUsageCallToActiveSpan` per LLM call — **no-op unless** `otel.annotateUsageCalls: true` (and backend OTel is off). Sideband `x-usage` is never gated by these flags.

## Programmatic API

```ts
import {
  setOtelTracer,
  withSpan,
  extractA2ATraceContext,
  getW3cTraceContext,
  resolveOtelEmissionPolicy,
} from "@a2a-wrapper/core";
```

`createA2AServer` automatically wraps the executor so every `a2a-*` provider gets `a2a.task.execute` / `a2a.task.cancel` when `otel.enabled` is true and a tracer is registered.

## Privacy

Do not enable backend content capture (`captureContent`, `OTEL_LOG_USER_PROMPTS`, etc.) unless you accept prompts and tool payloads in your collector. Wrapper instrumentation does not record prompt bodies by default.
