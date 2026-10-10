# OpenTelemetry demo stack (Jaeger)

Minimal local collector UI for developing `a2a-*` wrappers with OpenTelemetry.

## Start

```bash
docker compose -f examples/otel-stack/docker-compose.yml up -d
```

| Endpoint | Use |
|---|---|
| `http://127.0.0.1:4318` | OTLP HTTP — **preferred** (Copilot CLI + Node SDK) |
| `http://127.0.0.1:4317` | OTLP gRPC (Claude / generic) |
| `http://localhost:16686` | Jaeger UI |

## Agent config

```json
{
  "otel": {
    "enabled": true,
    "serviceName": "a2a-copilot-demo",
    "exporter": {
      "endpoint": "http://127.0.0.1:4318",
      "protocol": "http/protobuf"
    },
    "backend": {
      "copilot": {
        "propagateTraceContext": true
      }
    }
  }
}
```

## CLI bootstrap (optional deps)

When you run a wrapper CLI (`a2a-copilot`, …) with `otel.enabled` + `otel.exporter.endpoint`, `@a2a-wrapper/core` tries to start NodeSDK via **dynamic import**.

Install once in the wrapper (or host) package:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

Without those packages the CLI still runs; wrapper spans are no-ops until a host registers a tracer.

## What you should see

1. One **trace** per inbound A2A request (`a2a.task.execute` + backend children when Hook F is on).
2. Multi-turn / resume: separate traces joined by `gen_ai.conversation.id` / `a2a.task.id` (and optional span links with `a2a.task.link_reason=continue|retry`).

See [docs/observability.md](../../docs/observability.md).
