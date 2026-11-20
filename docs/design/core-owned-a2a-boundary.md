# Core-owned A2A boundary

Status: proposal, for discussion. Related: #64 (A2A conformance epic), #65, #66, #67, #68, #69, #71, #49.

## 1. Principle

`@a2a-wrapper/core` is the only package that knows the A2A protocol and the A2A SDK. Provider wrappers
(`a2a-copilot`, `a2a-claude`, `a2a-codex`, `a2a-opencode`, `a2a-antigravity`) know only core's own types and
signals. Core defines its **own domain model**, a superset of what A2A can express, and adapts it to
whatever SDK version it runs on.

Three consequences drive everything below:

1. **Own the model.** Task, message, part, event, run, caller and correlation are core types. Core carries
   what A2A has plus what we add (correlation ids, trace and attribution, control signals, our extensions).
2. **Upgrade in one place.** A new A2A version or SDK major changes the adapter in core. Wrappers and their
   `package.json` files do not change.
3. **Control in one place.** Cancellation, lifecycle, the task store, authentication and tracing are core
   mechanisms. A provider supplies only provider behaviour (call my backend, abort my backend).

## 2. Where we are (measured)

- Each of the five wrappers imports `@a2a-js/sdk` in exactly one source file, its executor, as `import type`,
  and lists it as a dependency. They use it to type `execute(ctx, bus)`; the only fields read are `taskId`,
  `contextId` and `userMessage`. Copilot and Codex also import an unused `Message` type.
- Core re-exports eight SDK types as its own public API (`AgentCard`, `Message`, `Part`, `TaskState`,
  `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`, `ExecutionEventBus`, `RequestContext`). Every
  `publish*` helper and the `A2AExecutor` interface take the SDK's bus. So the SDK leaks through core, and
  an SDK change is a breaking change for every wrapper.
- Evidence the model works: the A2A v0.3 to v1.0 migration was absorbed inside core (`LegacyTaskState`
  plus a state map) and no wrapper call site changed. We want that to be the rule, not luck.
- Cancel logic was duplicated five ways and drifted (see #66, PR #80). Core now owns the rules
  (`TaskRunRegistry`), but each wrapper still defines its own `cancelTask` entry point.

## 3. Target architecture

```
provider SDK  <->  provider wrapper  <->  core domain model  <->  A2A adapter  <->  @a2a-js/sdk  <->  wire
 (Copilot,         (only: call backend,    (types, run, control,   (the only code     (only core
  Claude, ...)      abort backend)          store, correlation)     importing the SDK)  depends on it)
```

Rules, each enforceable by a test or lint:

- Only `packages/core/src/a2a/**` (the adapter) imports `@a2a-js/sdk`. A CI-free guard test greps the
  workspace and fails if any other file or any wrapper `package.json` lists it.
- Core's public API (`index.ts`) exports no SDK type. SDK types appear only inside the adapter.
- Wrappers depend on `@a2a-wrapper/core` and their provider SDK, nothing else A2A-related.

## 4. Core domain model (sketch)

Names are illustrative. The shape matters more than the spelling.

```ts
// Open unions: A2A's kinds plus ours, and a lossless escape hatch.
type CorePart =
  | { kind: "text"; text: string; meta?: Meta }
  | { kind: "data"; data: unknown; meta?: Meta }
  | { kind: "file"; name?: string; mediaType?: string; uri?: string; bytes?: Uint8Array; meta?: Meta }
  | { kind: "unknown"; raw: unknown };           // a part kind this core version does not model; round-trips intact

type CoreTaskState =                              // A2A states, one vocabulary, no legacy strings in providers
  | "submitted" | "working" | "input-required" | "auth-required"
  | "completed" | "failed" | "canceled" | "rejected";

interface CoreRequest {                           // what a provider receives
  taskId: string; contextId: string;
  input: CorePart[];                              // already extracted; text helper included
  history: readonly CoreMessage[];                // read-only view of previous turns (follow-ups, #65)
  caller: CoreCaller;                             // authenticated identity, set by core (#68)
  correlation: { eventId: string; parentAgentId?: string; trace?: CoreTraceContext; metadata: Meta };
  extensions: ReadonlyMap<string, unknown>;       // negotiated A2A extensions, opaque to providers
}

interface TaskRun {                               // what a provider acts through
  readonly signal: AbortSignal;                   // aborted on cancel
  status(state: CoreTaskState, text?: string): void;
  artifact(a: CoreArtifact): void;                // buffered or streaming chunk
  requestInput(prompt: CoreInputRequest): Promise<CoreInputResponse>;   // #65, #57
  race<T>(work: Promise<T>): Promise<T | typeof CANCELED>;
  complete(result: CoreResult): void; fail(error: CoreError): void;
}
```

Extensibility is deliberate: every entity carries `meta` and `extensions`, unions have an `unknown`
member, and core may add fields without breaking providers (they read only what they use).

## 5. Provider contract

```ts
interface ProviderExecutor {
  initialize(): Promise<void>;
  run(request: CoreRequest, run: TaskRun): Promise<void>;       // the backend call
  abortBackend?(run: TaskRunInfo): Promise<void>;               // stop the running turn
  abortOrphan?(info: { taskId: string; contextId: string }): Promise<void>;  // see 6
  shutdown(): Promise<void>;
}
```

Core adapts a `ProviderExecutor` to the SDK's `AgentExecutor` internally. Providers never define
`execute(ctx, bus)` or `cancelTask`.

## 6. Cancel entry point and the task store

Cancel is a task-state transition, so the entry point is core's. Today the SDK's request handler loads the
task, rejects terminal tasks, and calls `executor.cancelTask` only if the task's event bus is live;
otherwise it marks the task canceled in the store and never calls the executor.

- **Live run** (this process): core's `TaskRunRegistry` claims the run, publishes `canceled`, then calls the
  provider's `abortBackend` bounded by a timeout, with a discard-state fallback.
- **No live run, store says active** (restart with a durable store, #69; or another instance): core still
  marks the task canceled, then calls `abortOrphan` so the provider can stop or discard the backend session
  for that context. Without this a durable store leaves orphaned backend work running.
- **Multi-instance:** the registry is per process. Core must define the behaviour when the run lives on
  another instance (forward, or fail with a clear error, or document single-instance as a limit). Decision
  needed with #69.
- The task store itself (memory or durable) sits behind a core `TaskStore` interface; the SDK's store is
  adapted, not exposed.

## 7. Adapter and versioning

- `packages/core/src/a2a/` contains one adapter per supported SDK major (`v1` today). It translates between
  core types and SDK types, including wire quirks (v1.0 part oneof shape, state enum numbers).
- Contract tests run the same core scenarios through the adapter: submit, stream, cancel, input-required,
  unknown part round-trip. When the SDK moves, those tests are the upgrade checklist.
- Core advertises the protocol version it speaks in one place (agent card), not per wrapper.

## 8. Migration

Each step is independently shippable and keeps wrappers working.

1. **Guard and inventory.** Add the "only core imports the SDK" test (initially allow-listing the five
   executors). No behaviour change.
2. **Core domain types and adapter.** Add the types in section 4 and the v1 adapter; `A2AExecutor` stays,
   implemented by an adapter wrapping a `ProviderExecutor`.
3. **Core-owned cancel entry point** plus `abortBackend` / `abortOrphan` (builds on PR #80). Migrate
   Copilot first, then Codex, OpenCode, Antigravity, Claude. Fixes the known Codex task-id bug and the
   OpenCode / Antigravity ordering bugs on the way.
4. **Move each wrapper to `ProviderExecutor`**, remove `@a2a-js/sdk` from its `package.json`, remove the
   allow-list entry. One PR per wrapper, verified against the real CLI where installed.
5. **Stop re-exporting SDK types from core.** Deprecate the eight re-exports, then remove at the next
   minor/major per the repo's release rules. Add new features (#65, #67, #71, #68) only on core types.

## 9. Alternatives considered

- **Keep re-exporting SDK types (status quo).** Cheapest, but every SDK change breaks all wrappers, and we
  cannot add our own concepts without wrapping them anyway.
- **Mirror SDK types 1:1 under our names.** Removes the import but not the coupling: an SDK change still
  forces a type change in every wrapper. We want our own shape, not a rename.
- **Per-wrapper adapters.** Five copies of the same translation; exactly the drift we saw with cancel.

## 10. Open questions

1. Is "union of A2A" meant as a superset (our types contain every A2A concept plus ours), as proposed here?
2. Multi-instance cancel (section 6): forward, error, or declare single-instance until #69?
3. Breaking change policy for removing the SDK type re-exports from core's public API.
4. Should provider-visible `history` include only the current context or the full task tree?
