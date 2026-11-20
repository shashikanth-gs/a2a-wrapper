---
"@a2a-wrapper/core": minor
"a2a-antigravity": minor
"a2a-claude": minor
"a2a-codex": minor
"a2a-copilot": minor
"a2a-opencode": minor
---

feat(events): event attribution, `events.transport: "both"`, and `${VAR}` in event settings

- New `events.transport: "both"` sends each event to the A2A sideband and the HTTP collector with the same `eventId`; a failing collector never blocks the A2A copy.
- `events.httpUrl` and `events.httpHeaders` values support `${VAR}` substitution (unset variable: left as written, warned once, value never logged). New env overrides `A2A_EVENTS_TRANSPORT` and `A2A_EVENTS_HTTP_URL`.
- Every event now carries the orchestrator's `propagatedMetadata` (bounded to 64 keys / 8 KB, key charset `[A-Za-z0-9_.-]`, secret-looking keys redacted).
- A2A trace artifacts gain `eventId`, `parentAgentId`, `otelTraceId`, `otelSpanId` in metadata and `event_id`, `parent_agent_id`, `propagated_metadata` in data.
- The JSON Schema of every wrapper accepts `events.transport: "both"`.
