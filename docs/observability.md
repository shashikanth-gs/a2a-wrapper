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
Smoke without a full agent: `node examples/otel-stack/smoke-export.mjs`.

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

| Field | Meaning |
|---|---|
| `otel.enabled` | Emit wrapper spans such as `a2a.task.execute` |
| `otel.exporter.endpoint` | Shared OTLP hint inherited by backends when their own endpoint is omitted |
| `otel.mirrorAgentEvents` | Also turn sideband tool events into wrapper OTel tool spans (default `false`) |
| `otel.taskUsageRollup` | Stamp `a2a.task.usage.*` (± `gen_ai.usage.*`) on the task span (default `true`; sideband `x-usage` always) |
| `otel.annotateUsageCalls` | Per-call `a2a.llm.call` span **events** when wrapper is sole token source (default `false`; Claude/Codex wired) |
| `otel.backend.copilot` | Hook F: Copilot CLI OTLP + `onGetTraceContext` parent-link |
| `otel.backend.claude` | Hook F: `CLAUDE_CODE_ENABLE_TELEMETRY` + `OTEL_*` + `TRACEPARENT` in subprocess env |
| `otel.backend.codex` | Hook F: merged into Codex `configOverrides.otel` |
| `otel.backend.opencode` | Declares OpenCode server OTel on (de-dupe); enable the flag on the OpenCode server itself |
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

Backends (Copilot, Claude, Codex, …) already report tokens via SDK events. We keep that on the **A2A sideband** (`trace.usage`, `metadata["x-usage"]`) always — that is not OTLP.

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
