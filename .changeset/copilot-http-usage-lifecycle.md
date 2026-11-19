---
"a2a-copilot": patch
---

Fix: usage and lifecycle events now reach the configured event transport (#56). Previously, with `events.transport: "http"` (or a custom transport), a collector received `tool_call_*` events but no lifecycle events and no usage, because Copilot published usage only on the A2A event bus (`trace.usage`, `metadata["x-usage"]`).

- New `agent_started` event once per task, and exactly one terminal `agent_finished` or `agent_error` event.
- `agent_finished` carries `data.usage`, the same `UsageTelemetryData` summary that is sent as `x-usage` (totals plus the per-call `calls` log). `cost` is the provider-reported sum and stays `null` when none is reported; it is never estimated.
- `agent_error` carries the failure message and `data.usage` (`null` when no LLM call had been made), so tokens spent before a failure are still accounted for.
- The terminal event is awaited so it reaches the collector before the task is reported finished, capped at 2 seconds so a slow or unreachable collector cannot stall tasks.
- With the default A2A transport, clients now also see `trace.lifecycle` sideband artifacts (`state: started` / `finished` / `error`) from Copilot, as they already do from Claude, Codex and Antigravity. `trace.usage` and `x-usage` are unchanged.
- README documents the events Copilot emits and the HTTP payload shape.
