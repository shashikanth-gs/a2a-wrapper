# OpenTelemetry Design

Status: **proposal** (roadmap item — not yet implemented in this repo)  
Related: existing A2A sideband `trace.*` artifacts, `LlmUsageAccumulator` (OTel GenAI field alignment), sibling bridge [`a2a-mcp-skillmap`](https://github.com/shashikanth-gs/a2a-mcp-skillmap) (`setOtelTracer` / `withSpan`)

This document answers three questions:

1. Do the backend SDKs already speak OpenTelemetry, and can we reuse that?
2. Even when they do (or don’t), what must `@a2a-wrapper/core` and each `a2a-*` wrapper emit themselves?
3. What wrapper-specific attributes belong on those spans, beyond what the SDKs know about?

---

## 1. Current state in this monorepo

| Layer | What exists today | Gap |
|---|---|---|
| **A2A sideband** | `AgentEventEmitter` → `A2ATransport` / `HttpTransport` emits `trace.mcp`, `trace.thought`, `trace.lifecycle`, `trace.usage`, … as A2A artifacts / HTTP POSTs | Protocol-level observability for orchestrators — **not** OTLP spans/metrics |
| **Usage model** | `UsageCallRecord` / `UsageTelemetryData` field names align with [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) | Names only — no `@opentelemetry/api` spans or meters |
| **HTTP server** | Express via `createA2AServer()` | No HTTP server instrumentation |
| **Distributed context** | Orchestrator `trace_id` / `parent_agent_id` in A2A metadata (e.g. Copilot `extractTraceContext`) | Not W3C `traceparent` / OTel `Context`; not linked to an OTel `TracerProvider` |
| **Roadmap** | README: optional OTel via `@opentelemetry/api`, no-op by default | Not implemented |

**Important separation:** keep A2A sideband traces and OpenTelemetry as **parallel** channels. Sideband stays the in-band protocol for orchestrators; OTel is for platform collectors (Jaeger, Tempo, Honeycomb, Datadog, …). Bridging them (optional “mirror `AgentEvent` → span events/attributes”) is fine; replacing sideband with OTel is not.

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

**Wrapper implication:** `a2a-copilot` should (1) accept OTel config in agent JSON / env, (2) pass `telemetry` into the client, (3) implement `onGetTraceContext` from the active OTel context created for the A2A task span.

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
   │ (core API)  │         │ (if enabled)   │       │                │
   └──────┬──────┘         └───────▲────────┘       └────────────────┘
          │                        │ parent context / env / telemetry cfg
          └────────────────────────┘
          A2A sideband (unchanged) ──► orchestrator
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
| `a2a.task.execute` | `AgentExecutor.execute` | Root wrapper span for the task |
| `a2a.task.cancel` | `cancelTask` | Link to prior execute if possible |
| `a2a.session.get_or_create` | Session manager | Reuse vs create attribute |
| `a2a.mcp.tool` | Tool start/end (from event mapper / hooks) | Child of task; may overlap SDK tool spans — use links/attributes, don’t double-bill metrics |
| `a2a.delegation` | Sub-agent call | Child task id / agent URL |
| `a2a.llm.usage` (event or span attrs) | When `UsageCallRecord` is recorded | Map existing fields → `gen_ai.*` attributes |
| Counters/histograms | task outcome, duration, tokens | Optional phase 2 |

Hook points already exist: `AgentEventEmitter.emit`, executors, session managers, MCP hooks/event mappers. Prefer **one** bridge in core that listens to `AgentEvent` (or wraps `emit`) so five wrappers don’t each reinvent span open/close.

### Layer C — Backend SDK passthrough (best-effort per wrapper)

| Wrapper | Passthrough work |
|---|---|
| `a2a-copilot` | Wire `telemetry` + `onGetTraceContext` from active OTel context |
| `a2a-claude` | Document / optionally map config → `CLAUDE_CODE_ENABLE_TELEMETRY` + `OTEL_*` in SDK `env` |
| `a2a-codex` | Map config → `codex.configOverrides.otel` (or nested TOML keys Codex expects) |
| `a2a-opencode` | Expose `openTelemetry` boolean into OpenCode config |
| `a2a-antigravity` | Wrapper spans only until Python bridge supports context |

Backend spans remain owned by the vendor runtimes. Wrapper spans supply the **A2A meaning** those runtimes do not know about.

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
    "mirrorAgentEvents": true,
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

CLI / library mode:

- **Library:** host calls `NodeSDK.start()` then `setOtelTracer(trace.getTracer("a2a-wrapper"))` (or we auto-detect global provider).
- **CLI binary:** optional `--otel` / env `A2A_OTEL_ENABLED=1` that boots a minimal OTLP exporter **only in the wrapper package’s CLI entrypoint**, not in core — keeps core free of exporter deps.

---

## 6. Phased delivery plan

### Phase 0 — Design (this doc)

Agree attribute dictionary, no-op policy, and “sideband stays” rule.

### Phase 1 — Core bridge (MVP)

- Add optional `@opentelemetry/api` peer + `packages/core/src/telemetry/otel.ts` (`setOtelTracer` / `withSpan` / attribute helpers).
- Instrument `createA2AServer` request path lightly **or** document that HTTP instr is host-owned (`@opentelemetry/instrumentation-express` / `http`).
- Wrap / hook `AgentEventEmitter` so `agent_started`/`finished`/`error` and tool events open/close or annotate spans when a tracer is set.
- Unit tests with a fake tracer (skillmap-style).
- Docs: how to register a provider; security note on content capture.

### Phase 2 — Wrapper attributes + usage mapping

- Each executor sets `a2a.*` + `gen_ai.*` on the task span.
- Map `LlmUsageAccumulator` records onto span attributes / metrics.
- Propagate context on sub-agent HTTP calls.

### Phase 3 — Backend passthrough

- **Copilot first** (best API): config → `telemetry` + `onGetTraceContext`.
- Claude env mapping + docs.
- Codex `configOverrides.otel`.
- OpenCode `openTelemetry` flag.
- Antigravity: evaluate Python-side later.

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

---

## 8. Suggested first implementation slice

Smallest useful PR after this design:

1. `packages/core` optional OTel facade + tests.
2. Hook `AgentEventEmitter.emit` → span events / status on task span stored in `AsyncLocalStorage`.
3. One wrapper (`a2a-copilot`) wires task-span + Copilot `telemetry`/`onGetTraceContext` behind `otel.enabled`.
4. README roadmap bullet → link here; mark “Phase 1 in progress” when code lands.

---

## References

- Repo roadmap: [README.md § Roadmap](../README.md#roadmap)
- Usage types: `packages/core/src/events/usage.ts`
- Sideband transport: `packages/core/src/events/transport.ts`
- Skillmap precedent: `a2a-mcp-skillmap` `src/core/telemetry.ts`
- OTel GenAI semconv: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Claude monitoring: https://docs.anthropic.com/en/docs/claude-code/monitoring-usage
- Copilot SDK Telemetry section in `@github/copilot-sdk` README
- Codex OTel crate: `codex-rs/otel` in https://github.com/openai/codex
