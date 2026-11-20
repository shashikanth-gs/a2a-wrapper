# Core-owned A2A boundary

Status: proposal, for discussion. Related: #64 (A2A conformance epic), #65, #66, #67, #68, #69, #71, #57, #49.

## 1. Principles

`@a2a-wrapper/core` is the only package that knows the A2A protocol and the A2A SDK. Provider wrappers
(`a2a-copilot`, `a2a-claude`, `a2a-codex`, `a2a-opencode`, `a2a-antigravity`) know only core's own types and
signals. Core defines its **own domain model**, a superset of what A2A can express, and adapts it to whatever
SDK version it runs on.

1. **Own the model.** Task, message, part, event, run, caller, interaction and correlation are core types.
   Core carries what A2A has plus what we add (correlation ids, trace and attribution, control signals).
2. **Upgrade in one place.** A new A2A version or SDK major changes the adapter in core. Wrappers and their
   `package.json` files do not change.
3. **Core is 100% A2A.** Every A2A operation has one defined core behaviour, independent of which provider
   is behind it. What a provider supports changes *how* an operation is carried out, never *whether core
   follows the spec*.
4. **No provider conditionals in core.** Core never branches on provider identity or on a feature flag such
   as `supportsSteering`. Core behaves by what a provider *implements* (section 5). Provider-specific
   workarounds live in that provider.
5. **Providers speak our format.** A provider emits questions, permission requests and status in core's
   vocabulary; core translates to and from A2A.

## 2. Where we are (measured)

- Each wrapper imports `@a2a-js/sdk` in exactly one source file, its executor, as `import type`, and lists
  it as a dependency. They use it to type `execute(ctx, bus)`; the only fields read are `taskId`,
  `contextId` and `userMessage`. Copilot and Codex also import an unused `Message` type.
- Core re-exports eight SDK types as its own public API (`AgentCard`, `Message`, `Part`, `TaskState`,
  `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`, `ExecutionEventBus`, `RequestContext`). Every
  `publish*` helper and `A2AExecutor` take the SDK's bus: the SDK leaks through core.
- The A2A v0.3 to v1.0 migration was absorbed inside core (`LegacyTaskState` plus a state map) with no
  wrapper call-site change. That should be the rule, not luck.
- Cancel was duplicated five ways and drifted (#66, PR #80). Core now owns the rules (`TaskRunRegistry`),
  but each wrapper still defines its own `cancelTask`.
- Permission and question handling is per wrapper (for example OpenCode's permission handler and polling,
  Copilot's permission callback, Claude's tool-permission hook), each with its own wire behaviour. #57 and
  #65 ask for this to be structured and A2A-compliant.

## 3. Target architecture

```
provider SDK <-> provider wrapper <-> core domain model <-> A2A adapter <-> @a2a-js/sdk <-> wire
 (Copilot,        (call backend,       (types, run, control,   (the only code     (only core
  Claude, ...)     abort, workarounds)  store, interactions)     importing the SDK)  depends on it)
```

Enforced by tests:

- Only `packages/core/src/a2a/**` imports `@a2a-js/sdk`. A guard test fails if any other file, or any
  wrapper `package.json`, references it.
- Core's public `index.ts` exports no SDK type.
- A second guard test fails if core source branches on a provider name (`copilot`, `claude`, `codex`,
  `opencode`, `antigravity`) outside documentation and test fixtures.

## 4. Core domain model (sketch)

Names are illustrative; the shape matters.

```ts
type Meta = Record<string, unknown>;

// Open unions: A2A's kinds plus ours, and a lossless escape hatch.
type CorePart =
  | { kind: "text"; text: string; meta?: Meta }
  | { kind: "data"; data: unknown; meta?: Meta }
  | { kind: "file"; name?: string; mediaType?: string; uri?: string; bytes?: Uint8Array; meta?: Meta }
  | { kind: "unknown"; raw: unknown };           // a kind this core version does not model; round-trips intact

type CoreTaskState =                              // one vocabulary; no legacy strings in providers
  | "submitted" | "working" | "input-required" | "auth-required"
  | "completed" | "failed" | "canceled" | "rejected";

interface CoreRequest {                           // what a provider receives
  taskId: string; contextId: string;
  input: CorePart[];
  history: readonly CoreMessage[];                // read-only view of earlier turns
  caller: CoreCaller;                             // authenticated identity, set by core (#68)
  correlation: { eventId: string; parentAgentId?: string; trace?: CoreTraceContext; metadata: Meta };
  extensions: ReadonlyMap<string, unknown>;       // negotiated A2A extensions, opaque to providers
}

interface TaskRun {                               // what a provider acts through
  readonly signal: AbortSignal;                   // aborted on cancel
  status(state: CoreTaskState, text?: string): void;
  artifact(a: CoreArtifact): void;                // buffered or streaming chunk
  ask(request: CoreInteraction): Promise<CoreInteractionResult>;   // section 6
  readonly inbox: AsyncIterable<CoreMessage>;     // messages the caller sent mid-task (section 7)
  race<T>(work: Promise<T>): Promise<T | typeof CANCELED>;
  complete(result: CoreResult): void; fail(error: CoreError): void;
}
```

Every entity carries `meta`/`extensions`, unions have an `unknown` member, and core may add fields without
breaking providers (they read only what they use).

## 5. Provider contract: capabilities by implementation, not by flag

```ts
interface ProviderExecutor {
  initialize(): Promise<void>;
  run(request: CoreRequest, run: TaskRun): Promise<void>;                  // required: the backend call
  abortBackend?(run: TaskRunInfo): Promise<void>;                          // stop the running turn
  abortOrphan?(info: { taskId: string; contextId: string }): Promise<void>;// stop backend work with no live run
  onMessage?(run: TaskRun, message: CoreMessage): Promise<MessageOutcome>; // steer a running turn
  resume?(state: ResumeState): Promise<void>;                              // continue after restart / pending interaction
  shutdown(): Promise<void>;
}
```

Core decides by whether a handler exists, never by who the provider is.

- **Implemented** (natively *or* through a provider-specific workaround): core calls it. How it is achieved is
  the provider's business. Example: a provider with no mid-turn injection implements `onMessage` as
  "abort the turn, resume the session with the merged prompt". That code lives in that provider only.
- **Not implemented:** core applies the *A2A-defined* default for that operation, not a blanket
  "not supported". Each default is the spec's behaviour and is the same for every provider, for example a
  precise A2A error (`TaskNotCancelable`, `UnsupportedOperation`) or a spec-defined queueing rule.
- The #73 conformance matrix is the source of truth: one row per A2A operation, with the core behaviour
  and the default when the handler is absent. A provider can improve a row by implementing the handler;
  it can never make core non-compliant by omitting one.

## 6. Interactions: permissions and questions in our format

Agents ask the user things: "may I run this command?", "which of these files?", "sign in to X first".
Each provider has its own mechanism. A2A models this as task states `input-required` / `auth-required`
plus a reply message on the same task. Core owns that translation.

```ts
type CoreInteraction =
  | { kind: "permission"; action: string; target?: string; risk?: "low"|"medium"|"high"; options: PermissionOption[]; detail?: Meta }
  | { kind: "question";   prompt: string; choices?: Choice[]; schema?: JsonSchema; multi?: boolean }
  | { kind: "auth";       service: string; instructions?: string; url?: string }
  | { kind: "confirm";    prompt: string };
interface CoreInteractionResult { outcome: "answered"|"declined"|"timeout"|"canceled"; value?: unknown; by?: CoreCaller }
```

Flow:

1. Provider calls `run.ask(interaction)` from inside its backend callback (for example its permission hook).
2. Core persists the pending interaction in the task store, moves the task to `input-required` (or
   `auth-required`), and publishes a status message with a text rendering plus a structured data part in
   a documented schema, so both plain and rich clients work.
3. The caller replies with an A2A message on the same task. Core parses it (structured part first, text
   fallback such as "1" or "approve"), validates it against the interaction, and resolves `ask`.
4. Core owns the policy around it: timeouts, cancel while pending (`outcome: "canceled"`), duplicate
   replies, and operator-configured auto-answer rules (for example auto-approve low-risk reads). Providers
   do not re-implement these.
5. If the process restarted while an interaction was pending, the durable store still has it. Core routes
   the reply to the provider's `resume`; if absent, core fails the task with a precise reason instead of
   leaving it hanging.

Providers only translate their native permission/question object to `CoreInteraction` and the result back.
This replaces the per-wrapper permission handlers and answers #57 and #65.

## 7. Steering a running task

A caller may want to redirect work in flight ("not that file, use the other one"). Protocol-wise this is a
message arriving for a task that is already running. Core must handle it deterministically for every
provider; there is no `steering` feature flag.

- Core receives the message, checks the task state and caller, and places it in `run.inbox`.
- If the provider implements `onMessage`, core hands it over and relays the outcome to the client:
  `accepted` (the turn was steered), `queued` (will run after the current turn), or `rejected` with a reason.
- If the provider does not implement it, core applies the spec-defined default for a message to a task that
  is not waiting for input (queue as the next turn, or the defined error), identically for every provider.
- A provider that can only approximate steering does so inside its own `onMessage`
  (abort-and-resume, prompt injection at the next tool boundary, and so on), documented in that provider.
  The spec text for messages to a working task is thin; the exact default is a conformance-matrix decision
  (#73) to be confirmed against the specification before implementation.

## 8. Cancel entry point and the task store

Cancel is a task-state transition, so the entry point is core's. Today the SDK's request handler loads the
task, rejects terminal tasks, and calls `executor.cancelTask` only if the task's event bus is live;
otherwise it marks the task canceled in the store and never calls the executor.

- **Live run:** core's `TaskRunRegistry` claims the run, publishes `canceled`, then calls the provider's
  `abortBackend` bounded by a timeout, with a discard-state fallback.
- **No live run, store says active** (restart with a durable store, #69, or another instance): core marks the
  task canceled, then calls `abortOrphan` so the provider can stop or discard the backend session for that
  context. Without this a durable store leaves orphaned backend work running.
- **Multi-instance:** the registry is per process. Behaviour when the run lives on another instance
  (forward, fail clearly, or document single-instance) must be decided with #69.
- The task store (memory or durable) sits behind a core `TaskStore` interface. Pending interactions
  (section 6), queued messages (section 7) and run metadata are persisted there. The SDK's store is adapted,
  not exposed.

## 9. Adapter and versioning

- `packages/core/src/a2a/` holds one adapter per supported SDK major (`v1` today). It translates between
  core types and SDK types, including wire quirks (v1.0 part oneof shape, state enum numbers).
- Contract tests run the same core scenarios through the adapter: submit, stream, cancel, input-required
  round trip, unknown-part round trip, message to a running task. When the SDK moves, those tests are the
  upgrade checklist.
- The protocol version core speaks is advertised in one place (the agent card), not per wrapper.

## 10. Migration

Each step is independently shippable and keeps wrappers working.

1. **Guards and inventory.** Add the "only core imports the SDK" and "no provider names in core" tests,
   initially allow-listing the five executors. No behaviour change.
2. **Core domain types and v1 adapter.** `A2AExecutor` stays, implemented by an adapter wrapping a
   `ProviderExecutor`.
3. **Core-owned cancel entry point** with `abortBackend` / `abortOrphan` (builds on PR #80). Migrate Copilot,
   then Codex, OpenCode, Antigravity, Claude. Fixes the known Codex task-id bug and the OpenCode and
   Antigravity ordering bugs on the way.
4. **Interactions (`run.ask`)** end to end with one provider first, then the rest; retire the per-wrapper
   permission handlers behind it (#57, #65).
5. **Steering (`inbox` / `onMessage`)** with the conformance-matrix default; implement a provider workaround
   only where a provider can support it.
6. **Move each wrapper to `ProviderExecutor`**, remove `@a2a-js/sdk` from its `package.json`, remove its
   allow-list entry. One PR per wrapper, verified against the real CLI where installed.
7. **Stop re-exporting SDK types from core**: deprecate, then remove at the next minor/major per release rules.
   New features (#67, #71, #68) land only on core types.

## 11. Alternatives considered

- **Status quo (re-export SDK types).** Cheapest, but any SDK change breaks all wrappers, and our own
  concepts must be wrapped anyway.
- **Mirror SDK types 1:1 under our names.** Removes the import, not the coupling.
- **Per-wrapper adapters.** Five copies of the same translation; exactly the cancel drift we saw.
- **Capability flags on the provider (`supportsX`).** Pushes provider knowledge into core's branching and
  invites the "if provider does this" conditionals we want to avoid; implementing a handler is the same
  signal without a second place to keep in sync.

## 12. Open questions

1. Is "union of A2A" a superset (our types contain every A2A concept plus ours, with `unknown` as the
   escape hatch), as proposed here?
2. Multi-instance cancel and pending interactions: forward, fail clearly, or single-instance until #69?
3. Breaking-change policy for removing the SDK type re-exports from core's public API.
4. Should `history` cover only the current context or the whole task tree?
5. Default for a message to a running task when the provider has no `onMessage`: queue as next turn, or
   reject? To be fixed in the #73 matrix against the spec text.
6. Interaction wire schema: pick a documented `data` part shape for `input-required`, and whether to align
   it with an existing A2A extension if one exists.
