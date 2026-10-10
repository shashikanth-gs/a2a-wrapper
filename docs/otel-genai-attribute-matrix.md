# OpenTelemetry GenAI + A2A attribute matrix

Status: **research snapshot** (2026-10-10)  
Companion design: [opentelemetry.md](./opentelemetry.md)

This page is a **who-emits-what** matrix for:

1. Latest **OpenTelemetry GenAI** semantic conventions (attributes, key spans, metrics)
2. **MCP** OTel attributes from the same GenAI conventions repo
3. Vendor/runtime signals used by our wrappers (**Claude Code**, **Codex**, **Copilot**, **OpenCode**/AI SDK)
4. Proposed **A2A / wrapper** attributes (`a2a.*`) — A2A protocol itself defines **no** OTel conventions today

---

## Sources (latest)

| Source | URL / location | Notes |
|---|---|---|
| **OTel GenAI semconv (canonical)** | [`open-telemetry/semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai) (`model/gen-ai/registry.yaml`, `spans.yaml`, `metrics.yaml`; `model/mcp/*`) | Moved out of core `semantic-conventions`. Stability of attributes is still largely **`development`**. |
| Published HTML mirror | https://opentelemetry.io/docs/specs/semconv/gen-ai/ | Site still hosts pages; YAML in the GenAI repo is the source of truth. |
| Claude Code monitoring | https://docs.anthropic.com/en/docs/claude-code/monitoring-usage | Full span/metric/event catalog; GenAI mapping notes for tokens. |
| Copilot SDK | `@github/copilot-sdk` README § Telemetry | Enables CLI OTel via `telemetry` / `onGetTraceContext`. **No public per-attribute catalog** in the SDK package. |
| Codex | `codex-rs/otel` + `codex-rs/core/tests/suite/otel.rs` | Config-driven OTel; tests assert `gen_ai.usage.*` on response spans + many `codex.*` events/attrs. |
| OpenCode | `@opencode-ai/sdk` `openTelemetry?: boolean` | Turns on AI SDK `experimental_telemetry`. Actual OTLP attrs depend on host `registerTelemetry` / AI SDK OpenTelemetry integration. |
| Vercel AI SDK telemetry | https://sdk.vercel.ai/docs/ai-sdk-core/telemetry | Documents `gen_ai.*` (+ legacy `ai.*`) when OpenTelemetry integration is registered. |
| A2A protocol | https://a2a-protocol.org | **No OTel / GenAI attribute standard.** Wrapper uses private `a2a.*` namespace + sideband `trace.*` artifacts. |

---

## Legend

| Cell | Meaning |
|---|---|
| **BE** | Backend / CLI emits this on OTLP when its OTel is enabled |
| **Map** | Backend emits a *different* name that maps to this GenAI attribute (see notes) |
| **W** | Planned / owned by `a2a-wrapper` OTel layer (not implemented yet) |
| **SB** | Present today only as A2A sideband / `x-usage` metadata (not OTLP) |
| **—** | Not emitted / not applicable |
| **?** | Emits related spans/events, but **attribute list not publicly documented** (or depends on host wiring) |

Columns:

| Column | Component |
|---|---|
| **Std** | In current OTel GenAI/MCP registry? |
| **Claude** | Claude Agent SDK / Claude Code runtime (`CLAUDE_CODE_ENABLE_TELEMETRY` + traces) |
| **Codex** | Codex CLI (`[otel]` / `codex-rs/otel`) |
| **Copilot** | GitHub Copilot CLI via `@github/copilot-sdk` `telemetry` |
| **OpenCode** | OpenCode + AI SDK telemetry path |
| **AntiG** | `a2a-antigravity` (Python bridge) |
| **Wrapper** | `@a2a-wrapper/core` / `a2a-*` planned OTel (A2A-unique + fallback) |

**De-dupe reminder:** when a backend column is **BE** for tools/LLM, the wrapper must **not** also emit a duplicate OTel tool/LLM span (see [opentelemetry.md §3.1](./opentelemetry.md#31-span-ownership--de-duplication)). Sideband (**SB**) can still flow to orchestrators.

---

## 1. Span / operation names

Official GenAI span naming uses `gen_ai.operation.name` values such as `chat`, `execute_tool`, `invoke_agent`, `invoke_workflow`, `plan`, memory ops, etc. Vendors often use **their own span names** and only partially adopt `gen_ai.*` attributes.

| Operation / span concept | Std `gen_ai.operation.name` | Claude span name | Codex | Copilot | OpenCode / AI SDK | Wrapper planned |
|---|---|---|---|---|---|---|
| Inference / chat completion | `chat` (also `generate_content`, `text_completion`) | `claude_code.llm_request` | Response / turn spans (assert `gen_ai.usage.*`) | Session/message spans (**?** attrs) | AI SDK generation spans (`gen_ai.operation.name` etc. when registered) | Task-level only if BE off; else attrs on `a2a.task.execute` |
| Embeddings | `embeddings` | — | — | — | Possible via AI SDK embed | — |
| Tool execution | `execute_tool` | `claude_code.tool` (+ `.blocked_on_user`, `.execution`) | Tool handling spans + `codex.tool_*` events | Tool-call spans (**?**) | `execute_tool` / `gen_ai.tool.*` via AI SDK | `a2a.mcp.tool` **only if BE OTel off** |
| Invoke agent (remote) | `invoke_agent` | Subagent nests under parent `claude_code.tool` | Subagent/`agent.type` on events | — / ? | — / ? | Map A2A delegation → `a2a.delegation` (not vendor invoke_agent) |
| Invoke agent (in-process) | `invoke_agent` | `claude_code.interaction` (turn root) | Turn spans | — / ? | — / ? | `a2a.task.execute` ≈ A2A task invocation |
| Create agent | `create_agent` | — | — | — | — | — |
| Workflow | `invoke_workflow` | Workflow attrs on agent/tool spans | — / ? | — | — | Optional later |
| Plan | `plan` | — | — | — | — | — |
| Memory ops | `search_memory`, `create_memory`, … | — | — | — | — | — |
| User turn / interaction | *(vendor)* | `claude_code.interaction` | `codex` turn / `conversation_starts` | message/session spans | — | — (A2A task is the unit) |
| Hook / permission wait | *(vendor)* | `claude_code.hook`, `claude_code.tool.blocked_on_user` | `codex.tool_decision`, sandbox events | — / ? | — | — |
| MCP protocol call | MCP spans (`mcp.method.name=tools/call`, …) | Outbound MCP gets `traceparent`; MCP activity also in tools/events | `codex.tool_result` w/ `mcp_server*` | — / ? | — / ? | Sideband `trace.mcp`; OTel tool span only if BE off |
| A2A task execute | **not in GenAI std** | — | — | — | — | **`a2a.task.execute` (W)** |
| A2A session | **not in GenAI std** | `session.id` on Claude telemetry | conversation id events | session spans | — | **`a2a.session.*` (W)** |
| A2A delegation | **not in GenAI std** | — | — | — | — | **`a2a.delegation` (W)** |

---

## 2. Core GenAI attributes (registry)

Stability: **development** unless noted. Opt-in content fields must stay **off by default** in wrappers.

### 2.1 Provider / operation / request

| Attribute | Std | Claude | Codex | Copilot | OpenCode | AntiG | Wrapper | Notes |
|---|---|---|---|---|---|---|---|---|
| `gen_ai.provider.name` | ✓ | — (uses legacy `gen_ai.system=anthropic`) | ? / partial | ? | **BE?** (AI SDK) | — | **W** (`github_copilot` / `anthropic` / `openai` / …) | Prefer registry `provider.name`; Claude still documents `gen_ai.system`. |
| `gen_ai.system` | deprecated → provider.name | **BE** (`anthropic`) | — | — | **BE?** (legacy path) | — | avoid new use | Claude docs still emit this. |
| `gen_ai.operation.name` | ✓ | — (custom span names) | ? | ? | **BE?** | — | **W** on wrapper spans (`invoke_agent` / custom `a2a.task`) | |
| `gen_ai.request.model` | ✓ | **BE** | ? | ? | **BE?** | — | **W**/SB from usage | |
| `gen_ai.request.max_tokens` | ✓ | — | ? | ? | **BE?** | — | — unless known | |
| `gen_ai.request.temperature` | ✓ | — | ? | ? | **BE?** | — | — | |
| `gen_ai.request.top_p` / `top_k` | ✓ | — | ? | ? | **BE?** | — | — | |
| `gen_ai.request.stop_sequences` | ✓ | — | ? | ? | **BE?** | — | — | |
| `gen_ai.request.frequency_penalty` / `presence_penalty` | ✓ | — | ? | ? | **BE?** | — | — | |
| `gen_ai.request.seed` | ✓ | — | ? | ? | **BE?** | — | — | |
| `gen_ai.request.stream` | ✓ | — / Map via path | ? | ? | **BE?** | — | — | |
| `gen_ai.request.choice.count` | ✓ | — | — | — | — | — | — | |
| `gen_ai.request.encoding_formats` | ✓ | — | — | — | — | — | — | embeddings |
| `gen_ai.request.reasoning.level` | ✓ | **Map** (`effort` on llm_request) | **Map** (`codex.request.reasoning_effort` / turn) | ? | ? | — | **W** if config has `claude.effort` etc. | |
| `gen_ai.request.previous_response.id` | ✓ | — | ? | ? | ? | — | — | |
| `gen_ai.request.stream_cursor` | ✓ | — | ? | — | — | — | — | |
| `gen_ai.output.type` | ✓ | — | — | — | **BE?** | — | **W** if `claude.outputFormat` set | |

### 2.2 Response

| Attribute | Std | Claude | Codex | Copilot | OpenCode | AntiG | Wrapper | Notes |
|---|---|---|---|---|---|---|---|---|
| `gen_ai.response.id` | ✓ | **BE** (= `request_id`) | ? | ? | **BE?** | — | SB/W if known | |
| `gen_ai.response.model` | ✓ | Map via `model` | ? | ? | **BE?** | — | **W**/SB | |
| `gen_ai.response.finish_reasons` | ✓ | **BE** (from `stop_reason`) | ? | ? | **BE?** | — | — | |
| `gen_ai.response.status` | ✓ | — | ? | — | — | — | — | fetch_response |
| `gen_ai.response.time_to_first_chunk` | ✓ | **Map** (`ttft_ms` → seconds) | ? | ? | **BE?** (metric too) | — | SB `timeToFirstTokenMs` | |

### 2.3 Usage / tokens

| Attribute | Std | Claude | Codex | Copilot | OpenCode | AntiG | Wrapper | Notes |
|---|---|---|---|---|---|---|---|---|
| `gen_ai.usage.input_tokens` | ✓ | **Map** — Claude does **not** set this; use `input_tokens + cache_read_tokens + cache_creation_tokens` | **BE** | ? | **BE?** | — | **W**/SB on task summary | Claude documents explicit mapping. Our `UsageCallRecord` aligns conceptually. |
| `gen_ai.usage.output_tokens` | ✓ | **Map** (`output_tokens`) | **BE** | ? | **BE?** | — | **W**/SB | |
| `gen_ai.usage.cache_read.input_tokens` | ✓ | **Map** (`cache_read_tokens`) | **BE** | ? | **BE?** | — | **W**/SB | |
| `gen_ai.usage.cache_write.input_tokens` | ✓ | **Map** (`cache_creation_tokens`) | **BE** | ? | — / ? | — | **W**/SB | Older alias: `gen_ai.usage.cache_creation.input_tokens` (AI SDK / older docs). Our code comments still use old underscore form — **update when implementing**. |
| `gen_ai.usage.reasoning.output_tokens` | ✓ | — | **Map** (`codex.usage.reasoning_output_tokens`) | ? | ? | — | **W**/SB (`reasoningTokens`) | |
| `gen_ai.usage.text|image|audio.(input\|output)_tokens` | ✓ | — | — | — | — | — | — | modality breakdown |
| `gen_ai.usage.*.cache_read.input_tokens` | ✓ | — | — | — | — | — | — | modality cache breakdown |
| `gen_ai.token.modality` | ✓ | — | — | — | — | — | — | |

### 2.4 Conversation / agent / workflow

| Attribute | Std | Claude | Codex | Copilot | OpenCode | AntiG | Wrapper | Notes |
|---|---|---|---|---|---|---|---|---|
| `gen_ai.conversation.id` | ✓ | **Map** (`session.id`) | conversation / thread ids on events | session id spans (?) | ? | — | **W** ← A2A `contextId` | Natural join key for multi-turn. |
| `gen_ai.conversation.compacted` | ✓ | compaction events exist | ? | — | — | — | — | |
| `gen_ai.agent.id` | ✓ | **Map** (`agent_id` on subagent spans) | ? | ? | ? | — | **W** ← agent card / config id | |
| `gen_ai.agent.name` | ✓ | partial / workflow | ? | ? | **BE?** | — | **W** | |
| `gen_ai.agent.description` / `version` | ✓ | — | — | — | — | — | **W** optional | |
| `gen_ai.main_agent.id` / `name` / `description` | ✓ | parent/main distinction via `parent_agent_id` | `agent.type=main\|subagent` | ? | — | — | **W** for orchestrator parent | |
| `gen_ai.workflow.name` | ✓ | **BE**/gated (`workflow.name`) | — | — | — | — | — | |

### 2.5 Tools

| Attribute | Std | Claude | Codex | Copilot | OpenCode | AntiG | Wrapper | Notes |
|---|---|---|---|---|---|---|---|---|
| `gen_ai.tool.name` | ✓ | **Map** (`tool_name` / `tool_name_safe`) | tool name on handle_responses / events | **BE?** | **BE?** | — | **W** only if emitting tool spans | |
| `gen_ai.tool.call.id` | ✓ | **BE** | `call_id` on tool events | **BE?** | **BE?** | — | SB tool ids today | |
| `gen_ai.tool.type` | ✓ | — / infer MCP vs builtin | mcp vs function vs shell in events | ? | **BE?** | — | **W** as `a2a.tool.kind` companion | |
| `gen_ai.tool.description` | ✓ | — | — | — | — | — | — | |
| `gen_ai.tool.call.arguments` | ✓ opt-in | gated (`tool_input` / details) | gated / config | ? | **BE?** opt-in | — | **never by default** | |
| `gen_ai.tool.call.result` | ✓ opt-in | gated (`tool.output` event) | tool_result events | ? | **BE?** opt-in | — | **never by default** | |
| `gen_ai.tool.definitions` | ✓ opt-in | — | — | — | **BE?** | — | — | |

### 2.6 Content (opt-in, sensitive)

| Attribute | Std | Claude | Codex | Copilot | OpenCode | AntiG | Wrapper |
|---|---|---|---|---|---|---|---|
| `gen_ai.system_instructions` | ✓ opt-in | gated prompts / system_prompt event | `log_user_prompt` / agent response flags | `captureContent` | **BE?** opt-in | — | **off** |
| `gen_ai.input.messages` | ✓ opt-in | gated | gated | captureContent | **BE?** | — | **off** |
| `gen_ai.output.messages` | ✓ opt-in | gated (`response.model_output`) | gated | captureContent | **BE?** | — | **off** |

### 2.7 Retrieval / memory / embeddings / eval / prompt / skills

| Attribute | Std | Claude | Codex | Copilot | OpenCode | AntiG | Wrapper |
|---|---|---|---|---|---|---|---|
| `gen_ai.embeddings.dimension.count` | ✓ | — | — | — | — | — | — |
| `gen_ai.retrieval.*` | ✓ | — | — | — | — | — | — |
| `gen_ai.memory.*` | ✓ | — | — | — | — | — | — |
| `gen_ai.data_source.id` | ✓ | — | — | — | — | — | — |
| `gen_ai.evaluation.*` | ✓ | — | — | — | **BE?** (decide/eval ops) | — | — |
| `gen_ai.prompt.name` / `version` / `variable` | ✓ | — | — | — | — | — | — |
| `gen_ai.skill.name` / `description` / `source.uri` / `resource.name` | ✓ | skill events / gated `skill_name` | **BE** `codex.skill_invocation` (+ skill attrs) | — | — | — | — |

### 2.8 Error / server (shared semconv refs)

| Attribute | Std | Claude | Codex | Copilot | OpenCode | AntiG | Wrapper |
|---|---|---|---|---|---|---|---|
| `error.type` | ✓ (common) | Map (`error_class` / status) | failure events | ? | ? | — | **W** on task span |
| `server.address` / `server.port` | ✓ recommended on client inference | — | ? | ? | ? | — | optional |

---

## 3. MCP attributes (OTel GenAI MCP conventions)

| Attribute | Std | Claude | Codex | Copilot | OpenCode | AntiG | Wrapper | Notes |
|---|---|---|---|---|---|---|---|---|
| `mcp.method.name` | ✓ | — / via tool path | — / tool_result origin | ? | ? | — | **W** if MCP client span added later | Enum includes `tools/call`, `resources/read`, … |
| `mcp.session.id` | ✓ | — | — | — | — | — | — | |
| `mcp.protocol.version` | ✓ | — | — | — | — | — | — | |
| `mcp.resource.uri` | ✓ | — | — | — | — | — | — | |
| `jsonrpc.request.id` | ✓ (MCP span group) | — | — | — | — | — | — | |

Vendors more often expose MCP as **tool** spans/events (`mcp_server`, `mcp_tool.name`, …) rather than full MCP client/server span conventions.

---

## 4. Vendor-specific catalogs (non-registry)

### 4.1 Claude Code (high-signal)

Spans (traces beta): `claude_code.interaction` → `claude_code.llm_request` / `claude_code.tool` / `claude_code.hook`.

| Attribute / signal | Kind | Maps to GenAI? | Wrapper action |
|---|---|---|---|
| `span.type` | attr | — | ignore (vendor) |
| `user_prompt` / `user_prompt_length` | attr | content / length | never mirror prompts |
| `interaction.sequence` / `duration_ms` | attr | — | correlate via context |
| `parent.source` | attr | propagation | complements `onGetTraceContext` / `TRACEPARENT` |
| `model`, `input_tokens`, `output_tokens`, `cache_*_tokens` | attr | request.model / usage.* | prefer BE; wrapper summary optional |
| `ttft_ms`, `first_content_ms` | attr | `response.time_to_first_chunk` | |
| `tool_name`, `tool_use_id` | attr | `tool.name`, `tool.call.id` | do not duplicate tool span |
| `gen_ai.request.attempt` | span **event** | — | BE only |
| `tool.output` | span **event** | `tool.call.result` (opt-in) | off |
| Metrics: `claude_code.session.count`, `token.usage`, `cost.usage`, … | metrics | partial usage | don’t re-count if BE on |
| Events: `claude_code.user_prompt`, `tool_result`, `api_request`, … | logs/events | — | sideband remains separate |

Standard Claude resource/metric attrs: `session.id`, `user.*`, `organization.id`, `app.version`, `terminal.type`, optional VCS attrs.

### 4.2 Codex (`codex.*`)

| Signal | Kind | GenAI overlap | Wrapper action |
|---|---|---|---|
| Response/turn spans with `gen_ai.usage.*` | span attrs | **direct** | BE owns LLM usage spans |
| `codex.usage.reasoning_output_tokens`, `codex.usage.total_tokens` | span attrs | reasoning / total | map reasoning → GenAI; keep total vendor-specific |
| `codex.request.reasoning_effort`, `codex.turn.reasoning_effort` | span attrs | `request.reasoning.level` | |
| `codex.turn.token_usage.*` | span attrs | usage | |
| Events: `codex.conversation_starts`, `codex.api_request`, `codex.sse_event`, `codex.tool_result`, `codex.tool_decision`, `codex.sandbox_outcome`, `codex.skill_invocation` | log/events | tools/skills | don’t clone into wrapper tool spans when BE on |
| `[otel.span_attributes]` / `tracestate` | config | custom | can inject `a2a.wrapper.name` etc. |

### 4.3 Copilot

| Signal | Kind | GenAI overlap | Wrapper action |
|---|---|---|---|
| CLI spans: session, message, tool call | spans | likely tool/LLM (attrs **not listed** in SDK README) | Treat tool/LLM as **BE-owned** once `telemetry` configured |
| `TelemetryConfig` (`otlpEndpoint`, `filePath`, `exporterType`, `sourceName`, `captureContent`) | config | content capture = GenAI content opt-in | default captureContent false |
| `onGetTraceContext` → W3C `traceparent`/`tracestate` | propagation | parent link under `a2a.task.execute` | **required** for correlation without duplication |
| Inbound `traceparent` on tool handlers | propagation | — | host tools can nest correctly |

### 4.4 OpenCode / AI SDK

| Signal | Kind | GenAI overlap | Wrapper action |
|---|---|---|---|
| Config `openTelemetry: true` | flag | enables AI SDK experimental telemetry | expose flag only |
| AI SDK `gen_ai.*` on generation/tool spans | spans | large subset of registry | BE? only if process registered OTel integration |
| Legacy `ai.*` / `ai.telemetry.functionId` | spans | vendor AI SDK | don’t emit from wrapper |
| Metrics `gen_ai.client.operation.duration`, TTFC, etc. | metrics | std metrics | host/AI SDK |

### 4.5 Antigravity

| Signal | Kind | Notes |
|---|---|---|
| Native OTel | — | **None** in current Node wrapper surface |
| Sideband / usage | SB | lifecycle, mcp, usage artifacts today |
| Wrapper OTel | **W** | Until Python bridge supports OTel, wrapper may use `mirrorAgentEvents` fallback for tools |

---

## 5. A2A / wrapper attributes (proposed — not in OTel GenAI std)

A2A has **no** official OTel attribute registry. These are the wrapper-owned fields from [opentelemetry.md](./opentelemetry.md). Emit on **`a2a.task.*` / session / delegation** spans; do **not** invent a second tool span when BE already emits tools.

| Attribute | Claude | Codex | Copilot | OpenCode | AntiG | Wrapper | Source |
|---|---|---|---|---|---|---|---|
| `a2a.task.id` | — | — | — | — | — | **W** | A2A task id |
| `a2a.context.id` | — | — | — | — | — | **W** | A2A context id (also → `gen_ai.conversation.id`) |
| `a2a.agent.id` / `a2a.agent.name` | — | — | — | — | — | **W** | Agent config / card |
| `a2a.wrapper.name` / `a2a.wrapper.version` | — | — | — | — | — | **W** | `a2a-copilot@…` etc. |
| `a2a.protocol.version` | — | — | — | — | — | **W** | `1.0` / `0.3` negotiated |
| `a2a.parent_agent.id` | — | — | — | — | — | **W** | Orchestrator metadata |
| `a2a.orchestrator.trace_id` | — | — | — | — | — | **W** | Legacy non-W3C orchestrator id |
| `a2a.tool.kind` | — | — | — | — | — | **W**\* | `mcp` / `shell` / `builtin` / `a2a_subagent` (\*only on wrapper tool spans) |
| `a2a.mcp.server` | — | — | — | — | — | **W**\* / SB | MCP server id |
| `a2a.delegation` | — | — | — | — | — | **W** | boolean |
| `a2a.child_task.id` | — | — | — | — | — | **W** | delegated task |
| `a2a.rpc.method` | — | — | — | — | — | **W** | JSON-RPC method on HTTP span |

### Sideband today (not OTLP)

| Sideband / metadata | Approx. GenAI / A2A mapping | Emitters today |
|---|---|---|
| `trace.mcp` / `tool_call_*` | `execute_tool` / `gen_ai.tool.*` / MCP | All wrappers via `AgentEventEmitter` |
| `trace.thought` | — (reasoning text) | Copilot/Claude/… |
| `trace.lifecycle` | invoke_agent lifecycle | All |
| `trace.usage` / `metadata.x-usage` | `gen_ai.usage.*` | Copilot (+ others with trackUsage) |
| `trace.delegation` | A2A sub-agent | Wrappers with sub-agents |
| `trace.background_tasks` | — | Claude |

---

## 6. Official GenAI metrics (registry) vs vendors

| Metric | Std | Claude | Codex | Copilot | OpenCode/AI SDK | Wrapper |
|---|---|---|---|---|---|---|
| `gen_ai.client.operation.duration` | ✓ | — (custom) | ? | ? | **BE?** | optional task histogram |
| `gen_ai.client.inference.duration` | ✓ | — | ? | ? | **BE?** | — |
| `gen_ai.client.inference.time_to_first_chunk` | ✓ | Map ttft | ? | ? | **BE?** | — |
| `gen_ai.client.inference.time_per_output_chunk` | ✓ | — | — | — | **BE?** | — |
| `gen_ai.server.*` | ✓ | — | — | — | — | — |
| `gen_ai.invoke_agent.duration` / `inference_calls` / `tool_calls` | ✓ | partial via custom metrics | ? | ? | — | **W** on A2A task |
| `gen_ai.invoke_workflow.duration` | ✓ | — | — | — | — | — |
| `gen_ai.execute_tool.duration` | ✓ | tool `duration_ms` | ? | ? | **BE?** | only if wrapper tool spans on |
| `claude_code.*` metrics | vendor | **BE** | — | — | — | do not duplicate |
| Codex metrics client (`codex.*` counters/histograms) | vendor | — | **BE** | — | — | do not duplicate |

---

## 7. Naming debt inside this monorepo

`packages/core/src/events/usage.ts` comments currently reference **older** names:

| Current comment in repo | Latest registry name |
|---|---|
| `gen_ai.usage.cache_read_input_tokens` | `gen_ai.usage.cache_read.input_tokens` |
| `gen_ai.usage.cache_creation_input_tokens` | `gen_ai.usage.cache_write.input_tokens` (alias `cache_creation.input_tokens` still seen in AI SDK / Claude docs) |
| `gen_ai.usage.reasoning_tokens` | `gen_ai.usage.reasoning.output_tokens` |

When OTel export is implemented, emit **registry names**; keep `UsageCallRecord` field names stable and map at the OTel bridge.

---

## 8. Practical “full picture” for a2a-copilot (example)

When `otel.enabled` + `otel.backend.copilot` are on:

| Signal | OTLP emitter | A2A sideband |
|---|---|---|
| HTTP / A2A RPC | Wrapper / host HTTP instr | — |
| `a2a.task.execute` + `a2a.*` attrs | **Wrapper** | lifecycle artifacts |
| Session reuse | **Wrapper** | — |
| Model/tool spans | **Copilot CLI only** | `trace.mcp`, `trace.usage` still yes |
| Token totals on task | Wrapper attrs from `UsageCallRecord` (summary) | `x-usage` / `trace.usage` |
| Sub-agent call | **Wrapper** `a2a.delegation` | `trace.delegation` |

Same pattern for Claude/Codex: BE owns overlapping GenAI tool/LLM; wrapper owns A2A.

---

## 9. Gaps / follow-ups

1. **Copilot public attribute dump** — request or reverse-document CLI span attribute keys once we enable telemetry in a lab collector.
2. **OpenCode** — confirm whether `openTelemetry: true` alone exports OTLP or only enables AI SDK hooks (needs host `registerTelemetry`).
3. **Antigravity Python SDK** — check for OTel in upstream Google package when available.
4. **A2A community** — no standard yet; consider proposing `a2a.*` attributes upstream later.
5. Keep this matrix dated; re-pull [`semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai) before implementation (repo is actively changing; attributes remain `development`).

---

## 10. Quick links

- Design + de-dupe rules: [opentelemetry.md](./opentelemetry.md)
- GenAI repo: https://github.com/open-telemetry/semantic-conventions-genai
- Claude monitoring: https://docs.anthropic.com/en/docs/claude-code/monitoring-usage
- AI SDK telemetry: https://sdk.vercel.ai/docs/ai-sdk-core/telemetry
- Codex otel crate: https://github.com/openai/codex/tree/main/codex-rs/otel
