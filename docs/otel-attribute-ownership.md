# OpenTelemetry attribute ownership (A2A wrappers)

Status: **implemented baseline** (Phases 1–5)  
Spec tracking: [semantic-conventions-genai#254](https://github.com/open-telemetry/semantic-conventions-genai/issues/254) (A2A semconv — **open / draft**), [#243](https://github.com/open-telemetry/semantic-conventions-genai/issues/243) (multi-agent identity).

This is the **who owns what** guide for `@a2a-wrapper/core` and the `a2a-*` wrappers. It is intentionally thinner than research dumps: only attributes we emit or deliberately refuse to emit.

## Mental model

| Unit | Meaning | OTel join key |
|---|---|---|
| **Request / turn** | One inbound A2A `execute` | Usually one `trace_id`; one `a2a.task.execute` span |
| **Conversation** | Chatbot / orchestrator thread | `gen_ai.conversation.id` (+ optional `session.id`) |
| **Task** | A2A task (may resume after `input-required`) | `a2a.task.id` |
| **Message** | One A2A user message | `a2a.message.id` |

~99%: **one request → one wrapper span**. Resume/retry = **new span**, same conversation/task ids (optional span link). Platforms (Langfuse, Datadog, Phoenix) group by conversation/session attributes — not by assuming one eternal parent span. See [observability.md](./observability.md).

## Ownership legend

| Owner | Responsibility |
|---|---|
| **W** | Wrapper / `@a2a-wrapper/core` |
| **BE** | Backend runtime (Copilot CLI, Claude Code, Codex, …) when Hook F enables its OTel |
| **SB** | A2A sideband only (`trace.*`, `metadata["x-usage"]`) — not OTLP |
| **—** | Do not emit |

## Correlation IDs (always wrapper)

| Attribute | Owner | Source | Notes |
|---|---|---|---|
| `gen_ai.conversation.id` | **W** | Metadata `conversation_id` / `conversationId`, else A2A `contextId` | Langfuse/Datadog/Phoenix session grouping ([#254](https://github.com/open-telemetry/semantic-conventions-genai/issues/254) + GenAI registry) |
| `session.id` | **W** | Metadata `session_id` / `sessionId`, else same as conversation | Phoenix / generic session attribute; broader than a single LLM thread when provided |
| `a2a.context.id` | **W** | A2A `contextId` | Always the protocol context id |
| `a2a.task.id` | **W** | A2A `taskId` | Draft [#254](https://github.com/open-telemetry/semantic-conventions-genai/issues/254) |
| `a2a.message.id` | **W** | Inbound `userMessage.messageId` | Draft #254 |
| `a2a.task.invocation` / `a2a.task.invocation_kind` | **W** | In-process execute count (`new` / `continue` / `retry`) | Wrapper extension (not in #254 yet) |
| `a2a.gateway.*` | **W** | Metadata `passkey`, `spectrum_id` / `spectrumId`, etc. | Gateway business keys — **attrs only**, never become `trace_id` |
| `a2a.parent_agent.id` | **W** | Metadata `parent_agent_id` | Acting/target identity still evolving in [#243](https://github.com/open-telemetry/semantic-conventions-genai/issues/243) |
| `a2a.orchestrator.trace_id` | **W** | Metadata `trace_id` | Orchestrator-supplied id (may differ from W3C `trace_id`) |

## Protocol / operation (wrapper)

| Attribute | Owner | Value today |
|---|---|---|
| Span name | **W** | `a2a.task.execute` / `a2a.task.cancel` |
| `gen_ai.operation.name` | **W** | `invoke_agent` (aligned with #254 “existing shared”) |
| `a2a.method.name` | **W** | `message/send` for executor path (draft #254) |
| `a2a.protocol.version` | **W** | Server protocol version option |
| `a2a.wrapper.core.version` | **W** | Installed `@a2a-wrapper/core` package.json version (auto) |
| `a2a.wrapper.sdk` / `a2a.wrapper.sdk.version` | **W** | Which `a2a-*` package is serving the request + its version |
| `a2a.wrapper.name` / `.version` | **W** | Legacy aliases of `a2a.wrapper.sdk` / `.sdk.version` |
| `gen_ai.agent.name` / `gen_ai.agent.id` | **W** | From `agentCard.name` — interim until #243 settles acting vs target |
| `a2a.agent.name` / `a2a.agent.id` | **W** | Same (A2A-local mirror) |

## Usage / tokens

| Signal | Owner when backend OTel **on** | Owner when backend OTel **off** |
|---|---|---|
| Per-call `gen_ai.usage.*` on **LLM spans** | **BE** | — |
| `gen_ai.usage.*` on **wrapper task span** | **—** (de-dupe) | **W** (fallback sole source) |
| `a2a.task.usage.*` on task span | **W** (per-**request** rollup) | **W** |
| Sideband `trace.usage` / `x-usage` | **SB** always | **SB** always |
| Token **metrics** from wrapper | **—** | **—** |

Never sum backend `gen_ai.usage.*` **and** wrapper task `gen_ai.usage.*` in the same dashboard query.

## Tools / LLM child spans

| Signal | Backend OTel on | Backend OTel off + `mirrorAgentEvents` |
|---|---|---|
| Tool / LLM child spans | **BE** only | **W** may emit `a2a.mcp.tool` from AgentEvents |
| Sideband `trace.mcp` / tool events | **SB** always | **SB** always |

## Gateway → span mapping (no extra spans)

Orchestrators / API gateways should put stable ids on A2A request **metadata** (or message metadata). The wrapper copies them onto `a2a.task.execute`:

| Gateway concept | Metadata keys accepted | Span attribute |
|---|---|---|
| Conversation / thread | `conversation_id`, `conversationId` | `gen_ai.conversation.id` |
| UX session | `session_id`, `sessionId` | `session.id` |
| Passkey / spectrum / ticket | `passkey`, `spectrum_id`, `spectrumId`, `ticket_id`, `ticketId` | `a2a.gateway.passkey` / `a2a.gateway.spectrum_id` / `a2a.gateway.ticket_id` |
| Orchestrator trace | `trace_id`, `traceId` | `a2a.orchestrator.trace_id` |
| Parent agent | `parent_agent_id`, `parentAgentId` | `a2a.parent_agent.id` |

Do **not** invent a span per gateway hop. Pass ids; parent-link only within the live request (`traceparent`).

## Spec drift policy

Until #254 / #243 merge:

1. Prefer draft `a2a.*` names from #254 when we already have the data.
2. Keep interim `gen_ai.agent.*` on the **acting** (local) agent; do not invent a parallel target-agent schema yet.
3. Avoid high-cardinality ids on **metrics** (`a2a.task.id`, `a2a.message.id` must stay on spans only — #254).
4. When the official YAML lands, map/rename in a dedicated semconv bump — do not block product wiring.

## Related

- Operator guide: [observability.md](./observability.md)
- Demo stack (Phoenix, no Docker required): [examples/otel-stack](../examples/otel-stack)
