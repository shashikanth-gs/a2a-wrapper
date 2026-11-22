---
"a2a-claude": minor
---

a2a-claude adopts core's follow-ups (#124). Non-breaking; two documented behaviours change, both in the direction the README described as a limitation.

- **Usage.** Core now diffs the cumulative `total_cost_usd` / `modelUsage` readings (the wrapper's own `usageDelta` and the `usageTotals` kept in the binding's meta are gone; core keeps the previous reading with the binding). A resumed session whose previous reading is lost (the process died between the session being bound and its first result) reports no cost for that one task instead of the whole session total. A session created in the turn is counted in full.
- **A task that ends in an error still reports its cost.** `error_max_turns`, `error_max_budget_usd` and `error_during_execution` results carry `total_cost_usd`: it is now recorded, and the failed status carries `x-usage` and `urn:a2a-wrapper:usage:v1` (previously that cost landed on the next successful task). *Behaviour change (additive metadata on a failed status).*
- **A steered message the CLI still held when the task is interrupted now runs** as its own turn of the task, right after the interrupting message (which runs next), instead of being dropped. A cancel still drops it. *Behaviour change: this was a documented limitation.*
- Response artifact ids use core's persisted per-task turn ordinal instead of a process-local counter (ids are unchanged; a task that continues after a restart no longer risks reusing the first turn's ids).
- README: which token measure is authoritative (`x-usage` tokens are the main loop; the per-model breakdown from `modelUsage` includes sub-agents and compaction and is what was billed).
