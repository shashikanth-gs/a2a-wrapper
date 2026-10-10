# OpenTelemetry demo — Arize Phoenix (lightweight)

Local collector UI for developing `a2a-*` wrappers. **No Docker required.**

Phoenix is lighter than a Jaeger all-in-one compose stack: one Python process,
OTLP HTTP on the same port as the UI.

## Start Phoenix

```bash
pip install 'arize-phoenix'
# or: uvx --from arize-phoenix phoenix serve
phoenix serve
```

| Endpoint | Use |
|---|---|
| `http://127.0.0.1:6006/v1/traces` | OTLP HTTP — **preferred** (wrapper NodeSDK + Copilot) |
| `http://127.0.0.1:4317` | OTLP gRPC (Claude / generic) |
| `http://localhost:6006` | Phoenix UI |

Set `otel.exporter.endpoint` to the **origin** (`http://127.0.0.1:6006`);
`@a2a-wrapper/core` appends `/v1/traces` for the HTTP exporter.

## Agent config

See [`agent-otel.snippet.json`](./agent-otel.snippet.json):

```json
{
  "otel": {
    "enabled": true,
    "serviceName": "a2a-wrapper-demo",
    "taskUsageRollup": true,
    "annotateUsageCalls": false,
    "exporter": {
      "endpoint": "http://127.0.0.1:6006",
      "protocol": "http/protobuf"
    }
  }
}
```

## CLI bootstrap (optional deps)

When a wrapper CLI runs with `otel.enabled` + `otel.exporter.endpoint`, core
dynamically starts NodeSDK. Install once:

```bash
# protobuf (default) — required for Phoenix; preferred for Copilot
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto
# optional: JSON encoding if otel.exporter.protocol = "http/json"
# npm install @opentelemetry/exporter-trace-otlp-http
```

## Smoke / cookout scripts (this repo)

With Phoenix already running:

```bash
# 1) Synthetic core span (bootstrap + attrs only)
node examples/otel-stack/smoke-export.mjs

# 2) Recommended: BYOK cookout via **fake Ollama** (no GPU, no cloud keys)
#    - mock-ollama speaks OpenAI /v1/responses (Copilot) + Anthropic /v1/messages (Claude)
#    - boots real a2a-copilot + a2a-claude CLIs against it
#    - asserts Phoenix has a2a.wrapper.sdk spans + usage
node examples/otel-stack/cookout-byok.mjs
```

Why fake Ollama? Copilot already supports BYOK → Ollama (`copilot.provider.baseUrl`),
and Claude Code supports Ollama via `ANTHROPIC_BASE_URL` (Anthropic-compatible API).
That is a more realistic cookout than stubbing the session manager.

Optional lower-level script (executor + fake client, no CLI spawn):

```bash
node examples/otel-stack/smoke-providers.mjs
```

## What you should see

1. One **trace** per inbound A2A request (`a2a.task.execute` + backend children when Hook F is on).
2. Attributes: `a2a.wrapper.core.version`, `a2a.wrapper.sdk`, `a2a.wrapper.sdk.version`,
   `gen_ai.conversation.id` / `session.id`, optional `a2a.task.usage.*`.
3. Multi-turn / resume: separate traces joined by conversation/task ids (optional span links).

See [docs/observability.md](../../docs/observability.md) and
[docs/otel-attribute-ownership.md](../../docs/otel-attribute-ownership.md).
