/**
 * @module runtime
 *
 * The core-owned run runtime (SDK-free). The A2A-facing half lives in `a2a/`
 * (`CoreExecutor`, the event bus manager and the task store wrapper).
 */

// RunHandle / RunTurn are runtime-internal and deliberately not exported.
export {
  RunRegistry,
  type DetachedPublisherFactory,
  type RunRegistryOptions,
  type SweepOptions,
  type PublisherFactory,
} from "./run-registry.js";
export { InteractionsRuntime, type InteractionsRuntimeOptions } from "./interactions.js";
export {
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_INTERACTION_POLICY,
  DEFAULT_INTERACTION_TIMEOUT_MS,
  POLICY_CALLER,
  matchAutoAnswer,
  resolveInteractionPolicy,
  timeoutFor,
  type AutoAnswer,
  type AutoAnswerMatch,
  type AutoAnswerRule,
  type InteractionPolicy,
} from "./interaction-policy.js";
export { InMemoryRunStore, type RunStore } from "./run-store.js";
export {
  allowAll,
  type Authorizer,
  type AuthTarget,
  type CancelOutcome,
  type ExecuteInit,
  type ExecuteOutcome,
  type InteractionHost,
  type InteractionRuntime,
  type InterruptOutcome,
  type OrphanSource,
  type PendingHook,
  type RunInteractionHandle,
  type RequestIds,
  type RunPublisher,
  type RuntimeLogger,
  type SweepEntry,
  type SweepReport,
} from "./types.js";
