---
"@a2a-wrapper/core": minor
---

Add `TaskRunRegistry`: provider-neutral task cancellation (#66). It owns the A2A rules every wrapper otherwise re-implements: run claiming, a guarded event bus that drops late events once a task is canceled, publishing `canceled` before the backend abort is awaited (the SDK closes the bus once `execute` returns), idempotent no-op cancels for unknown or finished tasks, and a bounded abort with an `onAbortFailed` hook. Wrappers supply only how to abort their backend. Also exports `TaskRun`, `CancelHooks`, `CANCELED` and `DEFAULT_ABORT_TIMEOUT_MS`.
