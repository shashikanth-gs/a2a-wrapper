---
"a2a-codex": patch
---

Fix `cancelTask`: it looked up the run by contextId and published the terminal state under the contextId, so a cancel could miss the running task. Cancellation now uses core's `TaskRunRegistry` (cancel by taskId, `canceled` published exactly once and before the abort, late backend events dropped, idempotent), and a turn canceled while queued behind another in the same context is never started.
