---
"@a2a-wrapper/core": minor
---

Orphan handling follow-ups (additive). Core no longer calls `provider.abortOrphan` for an orphaned run whose context has a LIVE run in the same registry (the startup sweep and the store-cancel path): the live run uses the context's session, so stopping it or discarding its binding would be wrong; the orphan is reported as confirmed and the binding is left alone. `OrphanInfo` gains the optional `heldHandles` (the provider-held steer handles core knows for the run) so a provider can cancel exactly those. The `abort` contract now states the interrupt rule: held steers are requeued into core (`settleSteer(handle, "requeue")`) on `interrupt` and cancelled and dropped on `cancel`.
