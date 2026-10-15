---
"@a2a-wrapper/core": minor
---

feat(otel): Phase 4 CLI bootstrap, span links, Jaeger demo stack

- `bootstrapOtelSdkFromConfig` / `shutdownOtelSdk` via dynamic import in `createCli`
- Span links on continue/retry invocations
- Optional peers for sdk-node + OTLP HTTP exporter
- `examples/otel-stack` docker-compose (Jaeger OTLP)
