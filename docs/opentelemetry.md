# OpenTelemetry Design

Status: **proposal** (roadmap item — not yet implemented in this repo)  
Related: existing A2A sideband `trace.*` artifacts, `LlmUsageAccumulator` (OTel GenAI field alignment), sibling bridge [`a2a-mcp-skillmap`](https://github.com/shashikanth-gs/a2a-mcp-skillmap) (`setOtelTracer` / `withSpan`)  
**Attribute emission matrix (latest GenAI std + vendors):** [otel-genai-attribute-matrix.md](./otel-genai-attribute-matrix.md)

This document answers four questions:

1. Do the backend SDKs already speak OpenTelemetry, and can we reuse that?
2. Even when they do (or don’t), what must `@a2a-wrapper/core` and each `a2a-*` wrapper emit themselves?
3. What wrapper-specific attributes belong on those spans, beyond what the SDKs know about?
4. How do we avoid emitting the **same** tool/LLM work twice when the backend already exports OTel **and** we already have A2A sideband events?

---

## 1. Current state in this monorepo

| Layer | What exists today | Gap |
|---|---|---|
| **A2A sideband** | `AgentEventEmitter` → `A2ATransport` / `HttpTransport` emits `trace.mcp`, `trace.thought`, `trace.lifecycle`, `trace.usage`, … as A2A artifacts / HTTP POSTs | Protocol-level observability for orchestrators — **not** OTLP spans/metrics |
| **Usage model** | `UsageCallRecord` / `UsageTelemetryData` field names align with [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) | Names only — no `@opentelemetry/api` spans or meters |
| **HTTP server** | Express via `createA2AServer()` | No HTTP server instrumentation |
| **Distributed context** | Orchestrator `trace_id` / `parent_agent_id` in A2A metadata (e.g. Copilot `extractTraceContext`) | Not W3C `traceparent` / OTel `Context`; not linked to an OTel `TracerProvider` |
| **Roadmap** | README: optional OTel via `@opentelemetry/api`, no-op by default | Not implemented |

**Important separation:** keep A2A sideband traces and OpenTelemetry as **parallel** channels. Sideband stays the in-band protocol for orchestrators; OTel is for platform collectors (Jaeger, Tempo, Honeycomb, Datadog, …). Replacing sideband with OTel is not a goal.

**Anti-duplication rule:** sideband `tool_call_*` / `trace.mcp` events must **not** automatically become a second OTel tool span when the backend CLI already exports one. See [§3.1 Span ownership & de-duplication](#31-span-ownership--de-duplication).

---

## 2. Upstream SDK survey (as of the versions pinned here)

### Summary

| Backend | Package | Built-in OTel? | How to enable | Wrapper can link parent spans? |
|---|---|---|---|---|
| **GitHub Copilot** | `@github/copilot-sdk` | **Yes — first class** | `CopilotClientOptions.telemetry` (`otlpEndpoint`, `filePath`, `exporterType`, `sourceName`, `captureContent`) sets `COPILOT_OTEL_*` / `OTEL_*` on the spawned CLI | **Yes** — `onGetTraceContext` returns W3C `traceparent`/`tracestate`; tool handlers receive inbound context |
| **Claude (Agent SDK)** | `@anthropic-ai/claude-agent-sdk` | **Yes — via Claude Code runtime** | Env: `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus standard `OTEL_*` exporters ([Monitoring docs](https://docs.anthropic.com/en/docs/claude-code/monitoring-usage)). Settings also expose `otelHeadersHelper` | Partially — ambient/`options.env` can carry OTEL config; GenAI/`prompt.id` attributes exist in the runtime. No first-class “give me your Tracer” API in the TS surface we use |
| **OpenAI Codex** | `@openai/codex-sdk` (+ CLI) | **Yes — in CLI/Rust (`codex-rs/otel`)** | Codex config `[otel]` / `otel.exporter`, `otel.trace_exporter`, `otel.span_attributes`, `otel.tracestate` (default exporter `"none"`) | Partially — TS SDK accepts `CodexOptions.config` / `env`; can pass OTel TOML overrides. No TS-level `onGetTraceContext` like Copilot |
| **OpenCode** | `@opencode-ai/sdk` | **Partial / experimental** | Config flag `openTelemetry?: boolean` — “Enable OpenTelemetry spans for AI SDK calls (`experimental_telemetry`)” | Weak today — boolean flip only; exporter wiring is host/OpenCode-process concern |
| **Google Antigravity** | Python bridge (no npm AI SDK) | **Unknown / none in our Node surface** | N/A in `a2a-antigravity` today | Wrapper-owned spans only unless the Python SDK adds OTel later |

### Detail notes

#### Copilot — richest integration surface

The SDK intentionally does **not** depend on `@opentelemetry/api`. Instead:

- `telemetry?: TelemetryConfig` turns on the **CLI process** exporter.
- `onGetTraceContext?: TraceContextProvider` lets the host inject the current W3C context so app spans and CLI spans share one distributed trace.
- Inbound `traceparent` / `tracestate` appear on tool invocations.

**Wrapper implication:** `a2a-copilot` should (1) accept OTel config in agent JSON / env, (2) pass `telemetry` into the client, (3) implement `onGetTraceContext` from the active OTel context created for the A2A task span, (4) when Copilot backend OTel is on, **suppress** wrapper-synthesized OTel spans for tools/LLM that Copilot already emits — only keep A2A-unique spans (task/session/delegation) and still emit A2A sideband for the orchestrator.

#### Claude — env-driven runtime OTel

Claude Code / Agent SDK ships an internal OTLP stack (metrics, logs, traces; `OTEL_*` and `CLAUDE_CODE_OTEL_*` knobs). Enabling it is an **environment / managed-settings** concern, not a TS method call.

**Wrapper implication:** `a2a-claude` already can forward env into the SDK when marketplaces are used (`syncPluginInstallEnv`). For OTel we should:

- Document the env vars operators set on the wrapper process.
- Optionally add a small `claude.otel` / shared `otel` config block that *translates* into those env vars when spawning/query options are built — without importing the Anthropic OTel stack ourselves.
- Always emit **wrapper** spans for the A2A task lifecycle regardless of whether Claude’s exporter is on.

#### Codex — config-driven CLI OTel

The TypeScript SDK is a thin launcher; OTel lives in `codex-rs/otel`. Configuration is TOML-shaped (`exporter`, `trace_exporter`, `metrics_exporter`, `span_attributes`, `tracestate`, …).

**Wrapper implication:** fold OTel into `codex.configOverrides` (or a typed `codex.otel` that merges into overrides). Propagating W3C context into the CLI may require env / config fields as Codex evolves — treat parent-link as best-effort until the TS SDK exposes an explicit hook.

#### OpenCode — experimental AI-SDK telemetry flag

`openTelemetry: true` enables AI SDK experimental telemetry inside OpenCode. That is **not** the same as a full host-controlled TracerProvider.

**Wrapper implication:** expose the flag; still rely on core wrapper spans for A2A-level visibility. Revisit when OpenCode documents OTLP export + context propagation.

#### Antigravity — wrapper-only for now

Node side talks to a managed Python subprocess. Until that bridge emits OTel (or accepts a trace context), all spans/metrics are owned by `a2a-antigravity` + core.

---

## 3. Recommended architecture (three layers)

```
                    ┌─────────────────────────────────────┐
                    │  Collector (OTLP)                   │
                    └──────────────▲──────────────────────┘
                                   │ export (host-provided SDK)
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
   ┌──────┴──────┐         ┌───────┴────────┐       ┌───────┴────────┐
   │ Wrapper     │         │ Backend SDK/   │       │ Optional HTTP  │
   │ spans       │         │ CLI OTel       │       │ auto-instr.    │
   │ (A2A-only   │         │ (tools/LLM     │       │                │
   │  when BE on)│         │  when enabled) │       │                │
   └──────┬──────┘         └───────▲────────┘       └────────────────┘
          │                        │ parent context / env / telemetry cfg
          └────────────────────────┘
          A2A sideband (always, unchanged) ──► orchestrator
```

### 3.1 Span ownership & de-duplication

This is the Copilot case (and the general rule for any backend with native OTel).

#### The failure mode

For one MCP tool call you can accidentally get **three** representations:

1. **Copilot CLI OTel span** — e.g. execute_tool / GenAI tool span exported via `telemetry.otlpEndpoint`
2. **A2A sideband** — `tool_call_start` / `tool_call_end` → `trace.mcp` artifact on the EventBus (orchestrator)
3. **Wrapper-mirrored OTel span** — if we naïvely turn every `AgentEvent` into an OTel span

(1) and (3) both land in the same collector → **duplicate tool spans**, double latency, broken dashboards.  
(2) is a different channel (A2A protocol) and is **not** a duplicate of (1)/(3); orchestrators still need it.

#### Ownership matrix (who emits what to OTLP)

| Signal | Backend OTel **off** | Backend OTel **on** (e.g. Copilot `telemetry` set) |
|---|---|---|
| A2A task / cancel / session / delegation | Wrapper OTel span | Wrapper OTel span (**always** — backends don’t know A2A) |
| MCP / shell / builtin tool calls | Wrapper may emit `a2a.mcp.tool` (fallback) | **Backend only** — wrapper does **not** create a tool span |
| LLM / model call spans | Wrapper may attach usage attrs / fallback span | **Backend only** |
| Thinking / token streams as spans | Usually span **events** on task span, or omit | Prefer omit or single event on task span — never a second tool-like span |
| A2A sideband `trace.*` | Always (orchestrator) | Always (orchestrator) — independent of OTel |

#### Defaults (hard rules for implementation)

1. **`mirrorAgentEvents` defaults to `false`.** Turning AgentEvents into OTel child spans is opt-in and intended for backends *without* native OTel (or for debugging).
2. **When `otel.backend.copilot` (or equivalent) is configured, force `emitOverlappingBackendSpans: false`.** Even if someone sets `mirrorAgentEvents: true`, tool/`trace.mcp` / LLM-overlapping events must not open wrapper OTel spans. Log a one-shot warning if both were requested.
3. **Link, don’t clone.** Copilot’s `onGetTraceContext` makes CLI spans **children of** `a2a.task.execute`. That is correlation, not duplication. Do not also open `a2a.mcp.tool` for the same call.
4. **Sideband stays on.** Disabling wrapper OTel tool spans must never disable `AgentEventEmitter` → A2A/`HttpTransport` sideband.
5. **Usage:** put token totals on the **task span attributes** (from `UsageCallRecord`) rather than emitting a parallel `a2a.llm.usage` span when the backend already emits GenAI spans. Optional metric counters are OK if cardinality-safe.
6. **Same collector assumption.** Copilot CLI and the wrapper process should export to the **same** OTLP endpoint when both are enabled; otherwise you get split traces, which tempts people to “fix” it by mirroring — don’t.

#### Copilot-specific wiring

```
HTTP / A2A request
  └─ span: a2a.task.execute          ← wrapper (A2A attrs)
       ├─ span: a2a.session.*        ← wrapper (optional)
       ├─ span: a2a.delegation       ← wrapper only when we call sub-agents
       └─ (via onGetTraceContext)
            └─ Copilot CLI spans     ← tools, model calls (backend)
                 execute_tool / gen_ai.*
```

What we **do not** add under `a2a.task.execute` when Copilot telemetry is on:

- another span per `tool_call_start`/`tool_call_end`
- another span per `trace.usage` artifact

What we **still** do:

- emit sideband `trace.mcp` / `trace.usage` for the A2A client
- set `a2a.*` (+ summary `gen_ai.usage.*` if useful) on `a2a.task.execute`
- propagate W3C context into Copilot so CLI spans nest under the task

#### Config knobs

| Knob | Default | Meaning |
|---|---|---|
| `otel.enabled` | `false` | Wrapper OTel facade active |
| `otel.mirrorAgentEvents` | `false` | Map AgentEvents → wrapper OTel spans/events |
| `otel.emitOverlappingBackendSpans` | `false` | Allow tool/LLM spans even if backend OTel is on (**unsafe**; debug only) |
| `otel.backend.copilot` present | — | Implies backend OTel on → overlapping wrapper spans suppressed |

Pseudo-policy:

```ts
const backendOtelOn = Boolean(otel.backend?.copilot /* or claude/codex/… */);
const emitToolSpans =
  otel.enabled &&
  (otel.mirrorAgentEvents ?? false) &&
  (!backendOtelOn || otel.emitOverlappingBackendSpans === true);
```

### Layer A — `@a2a-wrapper/core` (always)

Follow the **skillmap pattern** (optional peer, structural tracer, no hard dependency):

- Optional peerDependency: `@opentelemetry/api` (peerDependenciesMeta.optional = true).
- Do **not** ship exporters / SDK (`NodeSDK`, OTLP exporter, …) inside core. Host apps and CLI entrypoints register a real `TracerProvider`.
- Public API sketch:

```ts
import { setOtelTracer, withSpan, getOtelTracer } from "@a2a-wrapper/core";
// or: createOtelBridge({ tracer })

await withSpan("a2a.task.execute", attrs, () => executor.execute(...));
```

- Prefer a thin facade that:
  - Uses `trace.getTracer("a2a-wrapper", version)` when `@opentelemetry/api` is resolvable **and** a provider was registered; otherwise no-op.
  - Or accepts an injected `OtelTracerLike` (skillmap-style) for tests and hosts that wrap the API.

**Zero cost when unused** remains a hard requirement (roadmap wording).

### Layer B — Wrapper executors (all `a2a-*`)

Instrument the shared lifecycle every wrapper already has:

| Span / metric | When | Notes |
|---|---|---|
| `a2a.task.execute` | `AgentExecutor.execute` | Root wrapper span for the task — **always** when OTel enabled |
| `a2a.task.cancel` | `cancelTask` | Link to prior execute if possible |
| `a2a.session.get_or_create` | Session manager | Reuse vs create attribute |
| `a2a.mcp.tool` | Tool start/end (from event mapper / hooks) | **Only if** backend OTel is off (or unsafe override). Never alongside Copilot `telemetry` |
| `a2a.delegation` | Sub-agent call | Child task id / agent URL — wrapper-owned (backends don’t emit A2A delegation) |
| Task-span `gen_ai.usage.*` attrs | When `UsageCallRecord` is recorded | Prefer attributes on the task span over a second LLM span when backend GenAI spans exist |
| Counters/histograms | task outcome, duration, tokens | Optional phase 2 |

Hook points already exist: `AgentEventEmitter.emit`, executors, session managers, MCP hooks/event mappers. Prefer **one** bridge in core that applies the ownership matrix above so five wrappers don’t each reinvent de-dupe logic.

### Layer C — Backend SDK passthrough (best-effort per wrapper)

| Wrapper | Passthrough work |
|---|---|
| `a2a-copilot` | Wire `telemetry` + `onGetTraceContext` from active OTel context |
| `a2a-claude` | Document / optionally map config → `CLAUDE_CODE_ENABLE_TELEMETRY` + `OTEL_*` in SDK `env` |
| `a2a-codex` | Map config → `codex.configOverrides.otel` (or nested TOML keys Codex expects) |
| `a2a-opencode` | Expose `openTelemetry` boolean into OpenCode config |
| `a2a-antigravity` | Wrapper spans only until Python bridge supports context |

Backend spans remain owned by the vendor runtimes. Wrapper spans supply the **A2A meaning** those runtimes do not know about.

### 3.2 Collector endpoint, protocols, and “one trace” (not one span)

#### Mental model (important)

We do **not** merge the Copilot span and the wrapper span into a single span.

We create **one distributed trace** (same `trace_id`) with a **parent/child span tree**:

```
trace_id = abc123
│
├─ span: a2a.task.execute              ← wrapper process (Node)
│    attributes: a2a.task.id, gen_ai.agent.name=agentCard.name, …
│    │
│    ├─ span: <copilot session/message>  ← Copilot CLI process
│    │    └─ span: execute_tool / …      ← Copilot CLI
│    │
│    └─ (optional) a2a.delegation        ← wrapper only
```

- **Same trace** ⇒ Grafana Tempo / Jaeger / Langfuse show one waterfall for the A2A task.
- **Different spans** ⇒ each operation keeps its own timing, status, and attributes.
- **Different processes** ⇒ wrapper Node process and Copilot CLI each export OTLP independently to the **same collector**.

Correlation glue: Copilot’s `onGetTraceContext` injects the active W3C `traceparent` from the wrapper’s `a2a.task.execute` span into the CLI. Without that, you get two unrelated traces in Tempo even if both hit the same endpoint.

#### Configure one collector for everyone

Recommended local shape:

```yaml
# otel-collector (or Grafana Alloy) listens on BOTH:
#   4317 = OTLP gRPC
#   4318 = OTLP HTTP
```

Shared agent config (sketch):

```json
{
  "otel": {
    "enabled": true,
    "serviceName": "a2a-copilot",
    "exporter": {
      "protocol": "http/protobuf",
      "endpoint": "http://127.0.0.1:4318"
    },
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

Rules:

1. **Wrapper exporter endpoint** and **Copilot `telemetry.otlpEndpoint`** must target the **same collector** (same host/deployment). That is how they “go together.”
2. **Protocol need not be identical wire format**, but for least surprise use the **same protocol both support**.
   - Copilot SDK today: **OTLP HTTP** only in public `TelemetryConfig` (`exporterType: "otlp-http"`, example `http://localhost:4318`).
   - Claude Code: gRPC (`4317`) or HTTP (`4318`) via `OTEL_EXPORTER_OTLP_PROTOCOL`.
   - Wrapper NodeSDK: can do either; default recommendation for Copilot monorepo path = **HTTP `4318`**.
3. A collector that only opens gRPC `4317` will accept Claude easily but **miss Copilot** unless Copilot also speaks gRPC (it doesn’t via the documented SDK config). Prefer collector with **both receivers**, or standardize on HTTP for Copilot+wrapper.
4. Optional env bootstrap for CLI mode:
   - `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`
   - `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
   - Wrapper maps the same values into Copilot `telemetry.otlpEndpoint`.

#### How a span actually leaves the process

| Emitter | Process | Export path |
|---|---|---|
| Wrapper `a2a.task.execute` | `a2a-copilot` Node | `@opentelemetry/sdk-trace-node` → OTLP exporter → collector `:4318/v1/traces` |
| Copilot tool/LLM spans | Copilot CLI child | CLI built-in OTel (env from SDK `telemetry`) → same collector `:4318` |
| A2A sideband `trace.mcp` | Node | **Not OTLP** — stays on A2A EventBus / HTTP transport for orchestrators |

Collector batches → backend exporter (Tempo, Jaeger, Langfuse OTel endpoint, Honeycomb, …).

#### What you see in Grafana Tempo / Langfuse / Jaeger

Search/open by `trace_id` (or by attribute `a2a.task.id` / `gen_ai.agent.name`):

```
[======== a2a.task.execute ==============================]  service=a2a-copilot
   [=== copilot message/turn ===]                            service=copilot-cli (or COPILOT_OTEL_SOURCE_NAME)
      [= execute_tool Read =]
      [= execute_tool Bash =]
   [== a2a.delegation =]   (only if wrapper called a sub-agent)
```

UI details:

| Product | What “together” means |
|---|---|
| **Grafana Tempo** + Explore / TraceQL | One trace waterfall; filter `resource.service.name` or `{span.a2a.task.id="…"}` |
| **Jaeger** | Same: one Trace ID, multiple Spans/Services |
| **Langfuse** (OTel ingestion) | Maps OTLP spans into a Langfuse trace/observations tree; parent/child preserved if `traceparent` was correct |

You will **not** see a single span that contains both Copilot tool attrs and `a2a.*` attrs. You see **related spans** in one tree. Put A2A identity (`gen_ai.agent.name` ← `agentCard.name`, `a2a.task.id`, …) on the **wrapper parent**; leave tool detail on **Copilot children**.

#### Failure modes (architecture tests)

| Misconfig | Symptom in Tempo |
|---|---|
| Wrapper and Copilot point at different collectors | Two traces; no parent/child |
| Copilot `telemetry` set but `propagateTraceContext` / `onGetTraceContext` missing | Two traces (or siblings under different roots), same collector |
| Wrapper also mirrors `tool_call_*` into OTel | Duplicate tool spans under the task |
| Collector only `:4317` gRPC, Copilot on HTTP `:4318` | Wrapper maybe OK if gRPC; Copilot spans missing |
| Sideband disabled expecting OTel to replace it | Orchestrator loses `trace.mcp` (different channel) |

---

## 4. Wrapper-level span attributes

Use OTel GenAI conventions where they fit; namespace A2A-specific fields under `a2a.*` (stable, low-cardinality where possible).

### On every `a2a.task.*` span

| Attribute | Source | Example |
|---|---|---|
| `a2a.task.id` | A2A task id | UUID |
| `a2a.context.id` | A2A context id | UUID |
| `a2a.agent.id` | Agent card / config | `copilot-reviewer` |
| `a2a.agent.name` | Config | human name |
| `a2a.wrapper.name` | Package | `a2a-copilot` |
| `a2a.wrapper.version` | package.json | `1.8.2` |
| `a2a.protocol.version` | Negotiated / default | `1.0` / `0.3` |
| `a2a.parent_agent.id` | Propagated metadata | optional |
| `a2a.orchestrator.trace_id` | Incoming metadata `trace_id` (legacy) | correlate with non-OTel orchestrators |
| `service.name` / `service.version` | Resource | set by host SDK |

### GenAI / model (when known)

| Attribute | Source |
|---|---|
| `gen_ai.provider.name` | `github_copilot` / `anthropic` / `openai` / `opencode` / `google` |
| `gen_ai.request.model` | Resolved model |
| `gen_ai.usage.input_tokens` / `output_tokens` / cache / reasoning | `UsageCallRecord` |
| `gen_ai.response.finish_reasons` | if available |

### MCP / tools

Used on wrapper `a2a.mcp.tool` spans **only when** the emission policy allows them (backend OTel off). When Copilot/backend owns tool spans, put A2A-only extras on the **task** span or on delegation spans — do not re-create the tool span just to attach these.

| Attribute | Source |
|---|---|
| `a2a.tool.name` | tool name |
| `a2a.tool.kind` | `mcp` / `shell` / `builtin` / `a2a_subagent` (already in Claude mapper) |
| `a2a.mcp.server` | MCP server id |
| `a2a.delegation` | boolean |
| `a2a.child_task.id` | delegated task |

### Transport / HTTP (server spans)

| Attribute | Source |
|---|---|
| `http.request.method` | Express / OTel HTTP semconv |
| `url.path` | `/a2a/jsonrpc`, `/a2a/rest`, agent-card |
| `a2a.rpc.method` | JSON-RPC method if applicable |

### Safety rules (align with sideband redaction)

- Never put raw prompts, file contents, tokens, or env values in attributes by default.
- Content capture (`captureContent`, Claude/Codex prompt logging) is **off unless explicitly enabled**, matching vendor defaults.
- Truncate high-cardinality / high-volume fields the same way event mappers already redact.

### Context propagation

1. Prefer W3C `traceparent` / `tracestate` on inbound HTTP (standard OTel propagators).
2. Also accept today’s A2A metadata `trace_id` / `parent_agent_id` and attach them as attributes; when no remote parent exists, still start a local root span.
3. Outbound sub-agent calls: inject W3C headers when the sub-agent client supports custom headers (already used for auth); include A2A metadata for older peers.

---

## 5. Config sketch

Shared block on every agent config (core `BaseAgentConfig`), optional:

```json
{
  "otel": {
    "enabled": true,
    "serviceName": "a2a-copilot",
    "tracerName": "a2a-wrapper",
    "mirrorAgentEvents": false,
    "emitOverlappingBackendSpans": false,
    "backend": {
      "copilot": {
        "otlpEndpoint": "${OTEL_EXPORTER_OTLP_ENDPOINT}",
        "exporterType": "otlp-http",
        "captureContent": false,
        "propagateTraceContext": true
      },
      "claude": {
        "enableTelemetry": true
      },
      "codex": {
        "exporter": "otlp-http",
        "traceExporter": "otlp-http",
        "spanAttributes": {
          "a2a.wrapper.name": "a2a-codex"
        }
      },
      "opencode": {
        "openTelemetry": true
      }
    }
  }
}
```

With the Copilot block present, collectors should see **one** tool span (from Copilot) under `a2a.task.execute`, plus A2A sideband `trace.mcp` for the orchestrator — not a second OTel tool span from the wrapper.

CLI / library mode:

- **Library:** host calls `NodeSDK.start()` then `setOtelTracer(trace.getTracer("a2a-wrapper"))` (or we auto-detect global provider).
- **CLI binary:** optional `--otel` / env `A2A_OTEL_ENABLED=1` that boots a minimal OTLP exporter **only in the wrapper package’s CLI entrypoint**, not in core — keeps core free of exporter deps.

---

## 6. Plumbing inventory — core-centric (no per-provider duplication)

Goal: **all shared OTel plumbing lives in `@a2a-wrapper/core`**. Wrappers only supply backend-specific passthrough (Copilot `telemetry`, Claude env, …). Surveyed 2026-10-10 against current `main` layout.

### 6.1 What every wrapper already does the same way

Every `*Executor.execute()` follows this pattern today:

| Step | Core API used | Copilot | Claude | Codex | OpenCode | Antigravity |
|---|---|---|---|---|---|---|
| 1. Read `taskId` / `contextId` / message | A2A `RequestContext` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 2. Resolve sideband transport | `resolveTransport(events, bus, …)` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 3. Build `AgentEventEmitter` | `new AgentEventEmitter({ agentId, agentName, traceId, transport })` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 4. `agentName` | `config.agentCard.name` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 5. `agentId` | slug of `agentCard.name` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 6. Publish submitted/working/… | `publishStatus` / `publishTask` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 7. Session | `sessionManager.getOrCreate(contextId)` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 8. Cancel | `cancelTask` + `publishStatus(canceled)` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 9. Server entry | `createA2AServer` ← `createCli` / server index | ✓ | ✓ | ✓ | ✓ | ✓ |

**Backend-only (must stay in wrappers):** client factories, event mappers / MCP hooks that translate vendor SDK events → `emitter.emit(...)`, Copilot/Claude/Codex OTel passthrough knobs.

### 6.2 Duplication / gaps to fold into core

| Concern | Today | Problem | Core home |
|---|---|---|---|
| Orchestrator metadata → `traceId` / `parentAgentId` | `extractTraceContext` **copied** in Copilot + OpenCode; Claude/Codex/Antigravity only use `contextId \|\| uuid` | Inconsistent parent linking | `extractA2ATraceContext(ctx)` in `packages/core/src/telemetry/` or `events/` |
| Emitter bootstrap | 5× nearly identical ctor blocks | Easy to drift when adding OTel | `createAgentEventEmitter({ config, ctx, bus, transport? })` |
| Task span lifecycle | **None** | Would be reimplemented 5× if added per executor | **Executor decorator** in `createA2AServer` (see §6.3) |
| AgentEvent → OTel | **None** | Mappers would each grow OTel code | Hook inside `AgentEventEmitter.emit` + `OtelEmissionPolicy` |
| Usage → span attrs | `LlmUsageAccumulator` in core; publish sites in Copilot/Antigravity | Mapping logic must not fork | `applyUsageToActiveSpan(summary \| record)` next to accumulator |
| W3C carrier for backends | Only sketched for Copilot | Each wrapper might invent inject/extract | `getW3cTraceContext()` / `withActiveTaskSpan()` in core |
| Config `otel` block | **None** | Would be copy-pasted into 5 `types.ts` | `OtelConfig` on `BaseAgentConfig` in `packages/core/src/config/types.ts` |
| Exporter bootstrap | **None** | Must not enter core as hard dep | Optional helper used from `createCli` only; library hosts bring NodeSDK |

### 6.3 Recommended attachment points (priority order)

```
createCli / host
    │  (optional) start OTLP exporter from config.otel.exporter
    ▼
createA2AServer(config, executorFactory)
    │  ★ HOOK A — wrap executor.execute / cancelTask once
    │     start/end a2a.task.execute | a2a.task.cancel
    │     ALS: store span + policy + agent attrs
    ▼
*Executor.execute (unchanged structure)
    │  ★ HOOK B — createAgentEventEmitter() [core helper]
    │     extractA2ATraceContext + agentCard → emitter
    │     bind emitter to active task span
    ├─ sessionManager.getOrCreate
    │     ★ HOOK C — optional thin wrapper helper recordSessionSpanAttrs
    │       (reuse|create) — called from helper or ALS annotation
    ├─ EventMapper / mcp-hooks → emitter.emit(...)
    │     ★ HOOK D — inside AgentEventEmitter.emit (core)
    │       policy: lifecycle → span events/attrs
    │               tool_* → child span ONLY if emitToolSpans
    ├─ LlmUsageAccumulator.record / final x-usage
    │     ★ HOOK E — applyUsageToActiveSpan (core)
    └─ backend client (wrapper-only)
          ★ HOOK F — passthrough only (Copilot telemetry + onGetTraceContext
                     calling core getW3cTraceContext())
```

#### Hook A — `createA2AServer` executor decorator (highest leverage)

In `packages/core/src/server/factory.ts`, after `executorFactory(config)`:

- Wrap `execute` / `cancelTask` so **every** provider gets `a2a.task.*` spans with:
  - `a2a.task.id`, `a2a.context.id`
  - `gen_ai.agent.name` / `a2a.agent.name` ← `config.agentCard.name`
  - `a2a.wrapper.name` ← from `ServerOptions` or config
  - status/error from thrown errors / finalization
- Uses `AsyncLocalStorage` so Hooks D/E see the active span without executors passing span objects around.
- **No executor file changes required** for the parent task span.

#### Hook B — shared emitter factory

Replace the 5 copy-pasted blocks with one core helper used by executors (small mechanical change, or gradually adopted):

```ts
const { emitter, traceContext } = createExecutionObservability({
  config, ctx, bus, customTransport,
});
```

Internally: `extractA2ATraceContext` + slug agentId + `resolveTransport` + `AgentEventEmitter` + register emitter with ALS.

#### Hook C — session

Prefer annotating the **active task span** (`a2a.session.reused=true|false`) from a tiny core helper after `getOrCreate`, rather than forcing `BaseSessionManager` to know OTel. Session managers stay backend-specific.

#### Hook D — `AgentEventEmitter.emit` (single chokepoint for sideband→OTel)

All mappers already converge here:

| Producer | Path into emitter |
|---|---|
| Claude `EventMapper` | `emitter.emit(tool_call_*\|agent_*\|thinking\|…)` |
| Codex `EventMapper` | same |
| Antigravity `EventMapper` | same |
| Copilot `McpEvidenceHooks` | `tool_call_start/end` |
| OpenCode executor inline | `tool_call_start/end` |
| Antigravity executor | `agent_started` directly |

So **do not** put OTel into each mapper. Put policy in `AgentEventEmitter`:

- Always keep existing `transport.send` (sideband).
- If ALS has an active task span + OTel enabled → apply `OtelEmissionPolicy`.

#### Hook E — usage accumulator

Keep recording in wrappers; **mapping to `gen_ai.usage.*` on the active span** is a core function called from Copilot/Antigravity (and others later) in one line — or from decorator finalization if we attach the accumulator to ALS later.

#### Hook F — backend passthrough (thin, per wrapper)

| Wrapper | File(s) | Core provides | Wrapper adds |
|---|---|---|---|
| Copilot | `executor.ts` client opts / session create | `getW3cTraceContext()`, shared `otel.exporter.endpoint` | `telemetry: { otlpEndpoint }`, `onGetTraceContext` |
| Claude | `client-factory.ts` `env` | env helpers / policy `backendOtelOn` | `CLAUDE_CODE_ENABLE_TELEMETRY` + `OTEL_*` when configured |
| Codex | `client-factory.ts` `config` | — | merge `otel` into `configOverrides` |
| OpenCode | config → OpenCode client | — | `openTelemetry` flag |
| Antigravity | — | mirrorAgentEvents fallback | none until Python OTel exists |

### 6.4 What must NOT be duplicated in providers

1. Tracer registry / `withSpan` / ALS task context  
2. `OtelEmissionPolicy` (de-dupe rules)  
3. Attribute dictionaries (`a2a.*`, GenAI mapping from `UsageCallRecord`)  
4. `extractA2ATraceContext`  
5. Parent `a2a.task.execute` span create/end  
6. W3C inject helper for backends  

Providers may only: call core helpers, and wire vendor SDKs (Hook F).

### 6.5 Concrete new core modules (proposed)

```
packages/core/src/telemetry/
  types.ts          # OtelConfig, OtelEmissionPolicy, A2ATraceContext
  context.ts        # ALS + extractA2ATraceContext + getW3cTraceContext
  api.ts            # setOtelTracer / withSpan / getOtelTracer (optional peer)
  attributes.ts     # buildTaskSpanAttributes(agentCard, ctx, …)
  usage-bridge.ts   # UsageCallRecord → gen_ai.usage.* on active span
  instrument.ts     # instrumentExecutor(executor, config) used by factory
  index.ts
```

Touch points in existing core files:

| File | Change |
|---|---|
| `server/factory.ts` | Call `instrumentExecutor` before `DefaultRequestHandler` |
| `events/transport.ts` | `AgentEventEmitter.emit` → policy hook (sideband unchanged) |
| `config/types.ts` | Optional `otel?: OtelConfig` on `BaseAgentConfig` |
| `config/loader.ts` | Env overrides for exporter endpoint / enabled |
| `cli/scaffold.ts` | Optional exporter bootstrap when `otel.enabled` (dynamic import of SDK — **not** a hard core dep) |
| `events/usage.ts` | Re-export / document mapping to latest GenAI names |
| `index.ts` | Export telemetry public API |

Wrapper diffs (minimal):

| Package | Change |
|---|---|
| All executors (later) | Prefer `createExecutionObservability()` instead of hand-rolled emitter ctor |
| `a2a-copilot` | Hook F: `telemetry` + `onGetTraceContext` from core helper |
| Others | Config passthrough only when enabling their backend OTel |

### 6.6 Validation checklist for “no duplication”

- [ ] Adding a 6th wrapper gets task spans **only** by implementing `A2AExecutor` + `createA2AServer` (Hook A).
- [ ] Tool double-emit tests live in **core** (`AgentEventEmitter` + policy), not in five packages.
- [ ] `extractA2ATraceContext` has a single implementation and unit tests in core.
- [ ] Grep for `OTEL_EXPORTER` / `startSpan` / `@opentelemetry` under `a2a-*/` returns only Hook F passthrough lines.

---

## 7. Phased delivery plan

### Phase 0 — Design (this doc)

Agree attribute dictionary, no-op policy, “sideband stays” rule, **ownership / anti-duplication** matrix, and **plumbing inventory (§6)**.

### Phase 1 — Core bridge (MVP)

- Add `packages/core/src/telemetry/*` as in §6.5 (optional `@opentelemetry/api` peer).
- **Hook A:** `instrumentExecutor` inside `createA2AServer`.
- **Hook D:** `AgentEventEmitter` + `OtelEmissionPolicy` (default: no tool child spans when backend OTel on).
- **Hook B precursor:** `extractA2ATraceContext` + optional `createExecutionObservability`.
- Unit tests with fake tracer (decorator + emitter policy + de-dupe).
- Docs: provider registration; Copilot de-dupe; collector HTTP `:4318`.

### Phase 2 — Wrapper attributes + usage mapping

- Each executor sets `a2a.*` + summary `gen_ai.*` on the task span.
- Map `LlmUsageAccumulator` records onto **task span attributes** / metrics (not duplicate LLM spans when backend GenAI spans exist).
- Propagate context on sub-agent HTTP calls.

### Phase 3 — Backend passthrough

- **Copilot first** (best API): config → `telemetry` + `onGetTraceContext`; when `backend.copilot` is set, automatically suppress overlapping wrapper tool/LLM spans.
- Claude env mapping + docs (same suppression when Claude telemetry env is enabled via config).
- Codex `configOverrides.otel`.
- OpenCode `openTelemetry` flag.
- Antigravity: evaluate Python-side later; until then `mirrorAgentEvents` may be the fallback for tools.

### Phase 4 — Polish

- Example docker-compose with Collector + Jaeger.
- Canary metrics dashboards / semconv compliance review.
- Optional CLI exporter bootstrap in each `a2a-*` bin.

---

## 7. What we will *not* do

- Make `@opentelemetry/sdk-*` or OTLP exporters a hard dependency of `@a2a-wrapper/core`.
- Replace A2A `trace.*` sideband artifacts with OTel.
- Enable prompt/content capture by default.
- Assume every backend SDK’s spans are sufficient — wrapper spans remain mandatory for A2A task/session/delegation semantics.
- **Mirror sideband tool/LLM events into OTel while Copilot (or any backend) telemetry is also exporting those same operations** — that is the double-emit bug this design forbids by default.

---

## 8. Suggested first implementation slice

Smallest useful PR after this design:

1. `packages/core` optional OTel facade + `OtelEmissionPolicy` + tests (including de-dupe cases).
2. Task span via `AsyncLocalStorage`; AgentEvents may add **events/attributes** on that span, but tool **child spans** only when policy allows.
3. `a2a-copilot`: `otel.backend.copilot` → SDK `telemetry` + `onGetTraceContext`; overlapping tool spans suppressed.
4. README roadmap bullet → link here; mark “Phase 1 in progress” when code lands.

---

## References

- Attribute matrix: [otel-genai-attribute-matrix.md](./otel-genai-attribute-matrix.md)
- Repo roadmap: [README.md § Roadmap](../README.md#roadmap)
- Usage types: `packages/core/src/events/usage.ts`
- Sideband transport: `packages/core/src/events/transport.ts`
- Skillmap precedent: `a2a-mcp-skillmap` `src/core/telemetry.ts`
- OTel GenAI semconv (canonical repo): https://github.com/open-telemetry/semantic-conventions-genai
- OTel GenAI HTML: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Claude monitoring: https://docs.anthropic.com/en/docs/claude-code/monitoring-usage
- Copilot SDK Telemetry section in `@github/copilot-sdk` README
- Codex OTel crate: `codex-rs/otel` in https://github.com/openai/codex
- AI SDK telemetry: https://sdk.vercel.ai/docs/ai-sdk-core/telemetry
