---
"@a2a-wrapper/core": minor
---

Provider-contract follow-ups from the Copilot and Claude migrations (#124), all additive (design doc 3.16).

- **Cumulative usage readings.** `run.reportUsage(reading)` and `RunObservability.recordCumulative(call, reading)`: a provider hands core a `cumulative` `CoreUsage` (with `series`, optionally `byModel`) and core returns the per-turn delta (`usageDelta`: per series and per model, a decrease starts a new epoch, never negative) against the previous reading, kept with the context binding (`ContextBinding.usageBaseline`) so it survives a restart. A lost baseline reports the whole reading only when the provider sets `CoreUsage.fresh`, otherwise nothing (never an over-report); a different series is a new total; rebinding another session ref resets the baseline. `RunObservability.usageNow()` returns what `finish()` reports without closing the lifecycle. `addModelUsage` is exported.
- **`CoreRequest.turn`**: the 1-based per-task turn ordinal, persisted as `RunRecord.turnCount` (keeps counting after a restart), and `turnArtifactId(kind, taskId, turn)`.
- **`run.settleSteer(handle, "requeue")`**: a provider-held steer that would be lost (an interrupt ends the backend process) becomes a core-queued message. Order after an interrupt: the interrupting message, then requeued steers in arrival order, then the messages that were already queued; persisted positions follow the same order.
- **Behaviour change: an `interrupt` now runs NEXT**, ahead of messages that were already core-queued (it was appended behind them), as design doc 3.4 says. One existing test asserted the old order and is rewritten.
- **Compatibility**: `CoreRequest.turn` is a new REQUIRED field and `run.bind` now returns a promise; hand-built `CoreRequest`s and fake `CoreTaskRun` views in wrapper test harnesses must be updated (none in this repository needed it).
- A degenerate cumulative reading (missing, null or zeroed totals) never replaces the usage baseline; an interrupted, canceled or stale turn reports nothing, so its spend lands on the next turn of the session.
- **`run.bind` resolves `"stored" | "dropped"`** (a caller that ignores the result keeps working; a live view still throws for an unstorable argument, a stale view never throws).
- **`run.status({ meta })`**: a non-terminal status with metadata and no text.
- **`CoreRequest.interactionMode`**: the mode of the runtime's interaction policy, so a provider need not guess it from its own configuration.
