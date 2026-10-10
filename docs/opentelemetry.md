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

## 6. Phased delivery plan

### Phase 0 — Design (this doc)

Agree attribute dictionary, no-op policy, “sideband stays” rule, and **ownership / anti-duplication** matrix.

### Phase 1 — Core bridge (MVP)

- Add optional `@opentelemetry/api` peer + `packages/core/src/telemetry/otel.ts` (`setOtelTracer` / `withSpan` / attribute helpers).
- Instrument `createA2AServer` request path lightly **or** document that HTTP instr is host-owned (`@opentelemetry/instrumentation-express` / `http`).
- Add an `OtelEmissionPolicy` (or equivalent) shared by all wrappers: given `mirrorAgentEvents` + `backendOtelOn` + `emitOverlappingBackendSpans`, decide whether an `AgentEvent` may open a wrapper span.
- Hook `AgentEventEmitter` only through that policy — default: lifecycle annotations on the task span, **no** tool child spans when backend OTel is on.
- Unit tests: fake tracer + cases for (backend off / on / override) proving tool events do not double-span.
- Docs: how to register a provider; security note on content capture; Copilot de-dupe example.

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
