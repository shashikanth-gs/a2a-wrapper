---
"a2a-copilot": patch
---

Fix: `cancelTask` now aborts the running Copilot backend turn (#66). Previously it only published `canceled` and the session kept running until its TTL, wasting tokens and letting the old turn interleave with the next message in the same context.

- Calls `session.abort()` (bounded to 5s); if the abort fails or times out the session is discarded so the next message starts clean.
- Cancelling an unknown, finished or already-completing task is a silent no-op; a cancel racing completion yields exactly one terminal state.
- Events from the aborted turn are dropped, never published after `canceled`, and a canceled run reports `agent_error` ("Task canceled") through the event transport.
- The non-streaming prompt timeout timer is now cleared when the prompt settles.
