# Observability

How to collect traces from `a2a-*` wrappers with [OpenTelemetry](https://opentelemetry.io/), and how that relates to A2A sideband `trace.*` artifacts.

## Two channels (keep both)

| Channel | Purpose | Transport |
|---|---|---|
| **A2A sideband** (`trace.mcp`, `trace.usage`, …) | Orchestrators and A2A clients | Event bus / optional HTTP event transport |
| **OpenTelemetry** | Platform collectors (Grafana Tempo, Jaeger, Langfuse, …) | OTLP |

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

Point your collector (or Grafana Alloy) at OTLP HTTP `:4318` and/or gRPC `:4317`.

## Agent config

```json
{
  "otel": {
    "enabled": true,
    "mirrorAgentEvents": false,
    "backend": {
      "copilot": {
        "otlpEndpoint": "http://127.0.0.1:4318",
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
| `otel.mirrorAgentEvents` | Also turn sideband tool events into wrapper OTel tool spans (default `false`) |
| `otel.backend.copilot` | Copilot CLI will export its own OTLP spans — wrapper **will not** duplicate tool spans |
| `otel.emitOverlappingBackendSpans` | Unsafe; allow duplicates (debug only) |

### What appears in Tempo / Jaeger / Langfuse

One **trace**, parent/child spans (not one merged span):

```
a2a.task.execute          ← wrapper (Node), attributes include gen_ai.agent.name from agentCard.name
  └─ Copilot / Claude …   ← backend CLI/runtime (separate process), same collector
```

- **Copilot:** configure `telemetry.otlpEndpoint` (wired from `otel.backend.copilot` in a follow-up) and `onGetTraceContext` for parent linking.
- **Claude Agent SDK:** TypeScript host spawns Claude Code; enable runtime OTel via env (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_*`) and pass `TRACEPARENT` for parent linking.
- **Antigravity:** no backend OTel today — enable `otel.enabled` and set `mirrorAgentEvents: true` if you want tool detail in OTLP from the wrapper.

Use the **same collector** for wrapper and backend exporters. Prefer OTLP HTTP `:4318` when mixing Copilot with the Node SDK.

## Wrapper span attributes (selected)

| Attribute | Source |
|---|---|
| `a2a.task.id` / `a2a.context.id` | A2A task / context |
| `gen_ai.agent.name` / `a2a.agent.name` | `agentCard.name` |
| `gen_ai.conversation.id` | A2A `contextId` |
| `a2a.wrapper.name` | Server option / package name |
| `a2a.task.usage.*` | Task rollup from `LlmUsageAccumulator` (always when OTel on) |
| `gen_ai.usage.*` on task span | **Only when backend OTel is off** |

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
4. Copilot / Antigravity call `applyUsageSummaryToActiveSpan` today; Claude/Codex can adopt the same helper when they accumulate with `LlmUsageAccumulator`.

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
