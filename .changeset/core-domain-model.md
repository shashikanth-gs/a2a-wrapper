---
"@a2a-wrapper/core": minor
---

Add the core-owned domain model and an A2A v1 adapter (additive, no existing export changed). New SDK-free types: `CorePart` (open union with an `unknown` member), `CoreTaskState`, `CoreRequest`, `CoreMessage` with `queue`/`steer`/`interrupt` delivery, `CoreInteraction` and `CoreInteractionResult`, `CoreUsage`, `SteerOutcome`, `AbortOutcome`, the `PendingInteraction`/`ContextBinding`/`RunRecord` persistence records, and the `ProviderExecutor` contract (`CoreTaskRun` is the provider-facing run). The adapter (`fromA2APart`, `toA2APart`, `fromA2ATaskState`, `toA2ATaskState`, `coreRequestFromContext`, `toStatusUpdate`, `toArtifactUpdate`, `renderInteraction`, `parseInteractionReply`, and friends) is the only new module that imports `@a2a-js/sdk`; unknown parts and task states round-trip instead of being dropped, and `isApproval` approves only an explicit `allow_*` selection.
