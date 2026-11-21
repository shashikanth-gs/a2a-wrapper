# Core data model and provider contract

Status: proposal, for discussion. Companion to [core-owned-a2a-boundary.md](core-owned-a2a-boundary.md), which states
the principles. This document is the data model, designed from evidence. Evidence lives in
[research/](research/) (one report per area, every claim labelled verified or inferred, with sources).

Research snapshot: 2026-11-21. A2A spec v1.0.1; `@a2a-js/sdk` 1.0.0 installed (upstream 1.3.0); Claude Agent SDK
0.3.286 (latest 0.3.329); Copilot SDK 1.0.5 (latest 1.0.34); Codex SDK 0.137.0 (latest 0.171.0); OpenCode 1.19.6
and 2.3.2; `google-antigravity` 0.1.5 (latest 0.1.24).

## 1. What the evidence says

### 1.1 Provider capability matrix

N = native, P = partial, W = workaround possible (provider-local), - = none. "Wrapper" = what the wrapper wires
today. Detail and sources: `research/provider-*.md`.

| Capability | Copilot | Claude | Codex | OpenCode | Antigravity |
|---|---|---|---|---|---|
| Abort a turn, session stays usable | N `session.abort()` (wrapper: not called) | N `interrupt()` | N SDK: kills process; app-server `turn/interrupt` | N v1 `abort`, v2 `interrupt` | P `halt_request`; queued turns still run |
| Steer a running turn | N `mode: immediate` (experimental); outcome seen later as `delivery: idle/steering/queued` | N streaming input, `priority now/next/later` | SDK -; app-server N `turn/steer` (needs `expectedTurnId`) | v2 N `delivery: steer/queue`; v1 implicit | - native; W cancel + re-run merged, or hook |
| Permission requests | N `onPermissionRequest`, or leave pending and answer later by RPC | N `canUseTool` (may stay pending) | SDK -; app-server N `item/*/requestApproval` | N `permission.asked` + reply once/always/reject | N in SDK (`ask_user`); bridge: -; W bridge work |
| Questions | P `ask_user`: one question, choices, freeform | N `AskUserQuestion`: 1-4 questions, multi-select | SDK -; app-server N experimental `requestUserInput` | N v1 option lists, v2 typed forms | P needs interactive mode + hook; bridge: - |
| Auth challenges | P error type, MCP OAuth | P error codes, `needs-auth`, URL elicitation | SDK P text only; app-server N `account/login/start` | P retry `action` link, MCP `needs_auth` | - static keys / ADC |
| Pending interaction survives restart | P permissions re-emitted by `continuePendingWork`; questions no | - (except `PreToolUse` `defer`, unspiked) | - | P re-listable while server lives; reload cancels | - |
| Resume conversation after restart | N | N | N (wrapper never calls `resumeThread`) | N (server-side sessions) | N in SDK; wrapper ignores the id |
| Unanswered interaction has a timeout/default | - none found | - none found | - none found | - none found | - none |
| Usage | N live | N cumulative per query | P final only (app-server live) | N with cost | P final only, cost null |
| Wrapper wiring today | `approveAll`, no questions, no abort | headless only, no `canUseTool` | exec mode, no resume | auto-replies `always` (writes persistent rules) | chat + stream only |

### 1.2 What the A2A side actually does (spec v1.0.1, SDK 1.0.0)

- A reply to `input-required` is a **new `message/send` on the same taskId**, and the SDK starts a **new
  `execute()`** for it. There is no correlation id between question and answer (the proposal for one, PR #2149, was
  closed).
- The SDK closes streams and blocking calls at `input-required` but not at `auth-required`; it does not re-drive an
  open stream after `execute()` returns in `auth-required`.
- The event bus is torn down when `execute()` returns, unless the last state was `input-required` or
  `auth-required`. Events published later are silently dropped.
- A message to a **working** task starts a **second concurrent `execute()`** on the same bus (guard PR a2a-js #632
  still open). The spec only says an agent "MAY accept additional messages for non-terminal states".
- `TaskStore` is `save` / `load` / `list` with no lock; `cancel` calls the executor only when a bus exists.
- Core uses `UserBuilder.noAuthentication`, so every caller shares one owner scope; the spec requires per-caller
  scoping (13.1).
- No accepted A2A extension exists for permissions, approvals or forms. ADK and a2a-samples put the request in a data
  part plus text and answer on the same task.

### 1.3 Design drivers

1. **Four of five providers can steer and all can abort, but none says what happened.** Outcomes differ per call, so
   they are returned values, not declared flags.
2. **Nobody times out an unanswered interaction.** Core must own expiry, or runs hang forever.
3. **Permission replies carry more than yes/no:** persistence scope (once, session, location/project, permanent),
   feedback text for the model, and a "reject and abort the turn" variant.
4. **Questions are lists** (Claude 1-4, Codex and OpenCode lists, Copilot one), with options, multi-select,
   free-text and sometimes `secret`. Replies are maps keyed by question.
5. **Conversation state is already persisted by every provider, but every wrapper keeps `contextId` to session in
   memory.** A restart loses context (Codex never resumes). Core should persist the binding.
6. **Pending interactions are only sometimes re-attachable.** That varies per interaction, so it is data on the
   interaction (a handle), not a provider flag.
7. **A reply arrives as a new `execute()`.** A run must outlive the `execute()` call that started it.
8. **Usage is cumulative for some providers and per-round for others**, and the Claude wrapper double-counts.
9. **Identity is missing.** Who may approve a command is a security decision; core must own it.

## 2. Design decisions

- **D1. No provider capability flags.** Core reads what a provider implements (optional handlers) and what it
  returns (outcomes). Static data is limited to media types and identity for display (section 3.7).
- **D2. Interactions are core's.** A provider turns its native permission/question into a `CoreInteraction`, awaits
  `run.ask`, and turns the result back. Persistence, expiry, authorization, idempotency and A2A rendering are core.
- **D3. A run outlives `execute()`.** Core owns a `RunHandle` keyed by task; each SDK `execute()` is an *attachment*
  to it (section 4). This is the central mechanism and needs a spike (section 8).
- **D4. A message to a running task carries a caller-chosen `delivery`:** `queue` (default when the caller says
  nothing: becomes the next turn of that context), `steer` (inject into the running turn), or `interrupt` (abort
  the running turn, then run the message as a new turn). Core never lets the SDK start a second concurrent
  `execute()` for a live run.
- **D5. Unknown never approves.** Only an explicit `selected` outcome on an `allow_*` option approves. Unknown
  kinds, outcomes, expired, unavailable and malformed replies all deny.
- **D6. Every open union round-trips unknown members**, so a core upgrade never needs a provider upgrade and the
  reverse.

## 3. Data model

TypeScript is illustrative. Types live in `packages/core` and are exported without any A2A SDK type.

### 3.1 Primitives

```ts
type Meta = Record<string, unknown>;
type Open<T extends string> = T | (string & {});        // open enum: unknown values round-trip

interface CoreCaller {                                   // set by core from authentication (#68)
  id: string;                                            // stable subject, "anonymous" when unauthenticated
  kind: Open<"user" | "agent" | "service" | "anonymous">;
  scopes?: string[];
  claims?: Meta;
}

type CorePart =
  | { kind: "text"; text: string; meta?: Meta }
  | { kind: "data"; data: unknown; mediaType?: string; meta?: Meta }
  | { kind: "file"; name?: string; mediaType?: string; uri?: string; bytes?: Uint8Array; meta?: Meta }
  | { kind: "unknown"; raw: unknown };                   // kind this core version does not model

type CoreTaskState = Open<
  | "submitted" | "working" | "input-required" | "auth-required"
  | "completed" | "failed" | "canceled" | "rejected">;
```

### 3.2 Request, session binding and run

```ts
interface CoreRequest {                                  // what a provider receives
  runId: string; taskId: string; contextId: string;
  input: CorePart[];
  history: readonly CoreMessage[];
  caller: CoreCaller;
  session?: { ref: string; meta?: Meta };                // persisted provider session, if this context has one
  correlation: { eventId: string; parentAgentId?: string; trace?: CoreTraceContext; metadata: Meta };
  extensions: ReadonlyMap<string, unknown>;
}

interface TaskRun {                                      // what a provider acts through
  readonly signal: AbortSignal;                          // aborted on cancel
  status(state: CoreTaskState, text?: string): void;
  event(e: CoreEvent): void;                             // text/thought delta, tool, plan, todo, diff, usage, log
  artifact(a: CoreArtifact): void;
  ask(i: Omit<CoreInteraction, "id" | "expiresAt"> & { expiresAt?: string },
      opts?: { handle?: string }): Promise<CoreInteractionResult>;
  bind(session: { ref: string; meta?: Meta }): void;     // persist contextId -> provider session (survives restart)
  race<T>(work: Promise<T>): Promise<T | typeof CANCELED>;
  complete(result: CoreResult): void;
  fail(error: CoreError): void;
}
```

`bind` replaces each wrapper's in-memory `contextId` to session map. On the next request for that context
(including after a restart) core passes the stored `session` back in `CoreRequest`.

`handle` on `ask` is opaque provider data (a Copilot `requestId`, an OpenCode `requestID`, ...). Its presence is the
signal that the interaction can be re-attached after a restart; absent means it cannot. No flag is needed.

### 3.3 Interactions

```ts
interface CoreInteraction {
  id: string;                                            // core-assigned, stable, idempotency key
  kind: Open<"permission" | "question" | "form" | "auth" | "confirm">;
  title: string;
  description?: string;
  subject?: InteractionSubject;                          // what the question is about
  options?: InteractionOption[];                         // permission, confirm
  questions?: Question[];                                // question
  schema?: FlatSchema;                                   // form: flat JSON Schema subset (as MCP elicitation)
  auth?: AuthChallenge;                                  // auth
  expiresAt?: string;                                    // core fills from policy when absent
  meta?: Meta;
}

interface InteractionSubject {
  tool?: string; action?: string; command?: string;
  resources?: string[];                                  // paths, URLs, patterns
  risk?: Open<"low" | "medium" | "high">;
  detail?: Meta;
}

interface InteractionOption {                            // permission option; shape follows ACP, plus our fields
  id: string;
  label: string;
  kind: Open<"allow_once" | "allow_always" | "reject_once" | "reject_always">;
  scope?: Open<"call" | "session" | "context" | "location" | "project" | "permanent">;
  allowsFeedback?: boolean;                              // a reject may carry text for the model
  interrupts?: boolean;                                  // choosing it also aborts the turn (Claude deny.interrupt, Codex cancel)
}

interface Question {                                     // one entry of a question interaction
  id: string;
  header?: string;
  prompt: string;
  options?: { id: string; label: string; description?: string }[];
  multi?: boolean;
  allowFreeform?: boolean;                               // Claude/OpenCode "custom", Codex isOther, Copilot allowFreeform
  secret?: boolean;                                      // Codex isSecret: never logged, persisted or traced in clear
}

interface AuthChallenge {                                // out-of-band only; no credential forms
  service: string;
  url?: string;
  userCode?: string;                                     // device-code flows
  instructions?: string;
}
```

Result, always produced by core, never by a provider:

```ts
type CoreInteractionResult =
  | { outcome: "selected"; optionId: string; feedback?: string; by: CoreCaller }
  | { outcome: "answered"; answers: Record<string, { optionIds?: string[]; text?: string }>; by: CoreCaller }
  | { outcome: "submitted"; values: Meta; by: CoreCaller }          // form
  | { outcome: "declined"; feedback?: string; by: CoreCaller }      // dismissed or form declined
  | { outcome: "completed"; by?: CoreCaller }                       // auth finished out of band
  | { outcome: "canceled" }                                         // task canceled while pending
  | { outcome: "expired" }                                          // core timeout
  | { outcome: "unavailable"; reason: string };                     // nobody can answer (policy, no client)
```

Per D5, a provider treats `selected` of an `allow_*` option as approval and everything else as denial. Providers map
`feedback` to their native field (Claude deny `message`, Copilot reject feedback, OpenCode reply `message`).

### 3.4 Steering and messages

```ts
interface CoreMessage {
  id: string;                                            // returned to the caller at insertion
  role: "user" | "agent";
  parts: CorePart[];
  from: CoreCaller;
  delivery?: Open<"queue" | "steer" | "interrupt">;      // caller intent; default "queue" (D4)
  idempotencyKey?: string;
  at: string;
  meta?: Meta;
}

type SteerOutcome =
  | { state: "inserted" }                                // folded into the running turn
  | { state: "held" }                                    // will be the next turn
  | { state: "rejected"; reason: Open<"no-active-turn" | "not-steerable" | "unsupported">; detail?: string };
```

Provider handler: `steer?(run, message): Promise<SteerOutcome>`. The outcomes map to evidence: Copilot
`delivery: steering | queued`, OpenCode 2 `steer | queue`, Claude `priority now | next | later`, Codex app-server
`turn/steer` (or `rejected: not-steerable` for review/compact turns), Antigravity workaround (cancel and re-run, then
`inserted`). A provider without `steer` gets the core default: a `steer` request is answered `held`, and the response says so; core
never silently changes the caller's choice.

`interrupt` is composed by core from `abort` plus a new turn in the context's lane, so it works for every provider that
implements `abort` (all five) and needs no new handler. Its outcome is `{ state: "interrupted" }` (the old turn
ended with the A2A state `canceled` for that turn, the new message starts the next turn on the same context).

```ts
type DeliveryResult = SteerOutcome | { state: "interrupted" };
```

### 3.5 Abort

```ts
interface AbortOutcome {
  stopped: "confirmed" | "unconfirmed";                  // did the backend acknowledge it stopped
  session: "reusable" | "discard";                       // can the bound session take the next turn
}
```

`abort?(run): Promise<AbortOutcome>`. A rejected or timed-out call is treated as
`{ stopped: "unconfirmed", session: "discard" }`; core then clears the binding and calls `release?(session)` so the
provider can drop its state. This replaces the earlier `onAbortFailed` hook. `abortOrphan?(info)` covers tasks the
store thinks are active but that have no live run.

### 3.6 Persistence records (core's `TaskStore` extension)

```ts
interface PendingInteraction {
  interaction: CoreInteraction;
  taskId: string; contextId: string; runId: string;
  state: "pending" | "answered" | "expired" | "canceled";
  createdAt: string; expiresAt: string;
  result?: CoreInteractionResult;                        // secret answers stored redacted
  handle?: string;                                       // opaque provider handle, if re-attachable
}
interface ContextBinding { contextId: string; session?: { ref: string; meta?: Meta }; updatedAt: string; }
interface RunRecord { runId: string; taskId: string; contextId: string; state: CoreTaskState; startedAt: string; }
```

After a restart, core finds `pending` records. Those with a `handle` go to the provider's
`reattach?(records)` so it can resume waiting (Copilot `continuePendingWork`, OpenCode re-list). The rest become
`expired` and the task is failed with a precise reason instead of hanging.

### 3.7 Static provider info and usage

```ts
interface ProviderInfo {                                 // descriptive only; core never branches on it
  id: string; displayName: string; version?: string;
  inputModes: string[]; outputModes: string[];           // media types, feed the agent card
}

interface CoreUsage {
  scope: "delta" | "cumulative";                         // core converts cumulative to delta (fixes double counting)
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; total?: number };
  costUsd?: number | null;                               // null when the provider does not report cost
  contextWindow?: { used?: number; limit?: number };
  model?: string;
}
```

### 3.8 Provider contract (summary)

```ts
interface ProviderExecutor {
  info(): ProviderInfo;
  initialize(): Promise<void>;
  run(req: CoreRequest, run: TaskRun): Promise<void>;                      // required
  steer?(run: TaskRun, m: CoreMessage): Promise<SteerOutcome>;
  abort?(run: TaskRunInfo): Promise<AbortOutcome>;
  abortOrphan?(info: { taskId: string; contextId: string; session?: { ref: string } }): Promise<void>;
  reattach?(pending: PendingInteraction[]): Promise<void>;
  release?(session: { ref: string }): Promise<void>;
  shutdown(): Promise<void>;
}
```

Capabilities are the handlers present plus the values returned. Nothing says "this provider supports steering".

### 3.9 Interaction policy

"Auto-answer" means an interaction is answered by policy instead of by a person. Today every wrapper does this
silently (Copilot approves everything; OpenCode replies `always` and saves a permanent rule). Core makes it explicit
and configurable, and keeps today's behaviour as the default so nothing changes until an operator opts in:

```jsonc
"interactions": {
  "mode": "auto",            // "auto" (default): providers keep their native config; core asks nobody
                             // "ask": core asks the A2A client via input-required / auth-required
  "timeoutMs": 600000,       // ask mode: expiry for an unanswered interaction
  "onTimeout": "deny",       // "deny" | "fail": what the provider sees (outcome "expired")
  "autoAnswer": [            // ask mode: rules answered without a person; first match wins
    { "match": { "kind": "permission", "risk": "low" }, "answer": { "kind": "allow_once" } }
  ]
}
```

In `ask` mode, unmatched interactions go to the client, and an unanswered one expires into a denial (D5). The
authorization middleware (decision 3) later decides *who* may answer; this policy decides *whether* a person is asked.

## 4. A2A mapping and the run model (core internal)

The SDK calls `execute()` per request and tears the bus down when it returns, except at `input-required` and
`auth-required`. A reply is a new `execute()` on the same task. So core separates the **run** from the
**attachments**:

- `RunHandle` (core, per task) owns the provider call, its events and its pending interactions.
- The first `execute()` attaches, publishes events, and **returns when the run reaches a terminal state or an
  interrupted state**. At `input-required` it publishes the status and returns; the bus stays alive (SDK rule) and the
  provider call keeps running in the background, parked on `run.ask`.
- The reply's `execute()` **resolves the pending interaction** (it does not call `provider.run` again), attaches to the
  same `RunHandle`, forwards the remaining events, and returns at the next terminal or interrupted state.
- A message to a working task is intercepted by core before any provider call: handled per its `delivery` (D4:
  `queue` by default, `steer`, or `interrupt`). Core never lets the SDK start a second `execute()` for a live run.
- Because the SDK does not re-drive streams at `auth-required`, core completes the attachment with that status and
  expects a fresh request after the out-of-band step. Spike to confirm.

| Core | A2A |
|---|---|
| `status("input-required")` after `ask` | task state `input-required`; status message = text rendering; data part with the interaction (extension `urn:a2a-wrapper:interaction:v1`) |
| `auth` interaction | task state `auth-required`; message carries `url`/`userCode`; no credential collection |
| reply `selected` / `answered` / `submitted` | a message on the same task: structured data part `{interactionId, ...}` first, text fallback second ("approve", option label, number) |
| client that did not activate the extension | text rendering only, options numbered; core still parses the text reply |
| duplicate or late reply | idempotent on (task, interaction id); unknown or answered ids are ignored with no side effect |
| `expired` | task `failed` (or `canceled`) with the reason, per policy |
| cancel while pending | `outcome: "canceled"` delivered to the provider, then the normal cancel path |
| `CoreCaller` | from the A2A call context; permission replies require the task owner or a configured approver |

## 5. Per-provider fit (what lives in each provider)

| Provider | Native fit | Provider-local work |
|---|---|---|
| Claude | `canUseTool` to `ask`; `AskUserQuestion` to `questions`; streaming input to `steer`; `interrupt()` to `abort` (`session: reusable`) | stream user messages instead of one-shot; return `null` when answered out of band; map `feedback` to deny `message`; spike `defer` hook for restart durability |
| Copilot | `onPermissionRequest` or pending-RPC to `ask`; `mode: immediate` to `steer` (read the `delivery` event for the outcome); `session.abort()` to `abort` | stop using `approveAll`; wire `ask_user`/elicitation; pass `handle` (requestId) and implement `reattach` via `continuePendingWork` |
| Codex | exec SDK: abort + `resumeThread` only | to get permissions and steering the provider must move to `codex app-server` (experimental): `requestApproval` to `ask`, `turn/steer` to `steer`; call `resumeThread`; fix `cancelTask` using `contextId` as the task id |
| OpenCode | `permission.asked` / `question.asked` / `form.created` to `ask`; v2 `delivery` to `steer`; `interrupt` to `abort` | stop auto-replying `always`; v1/v2 split behind one handler; `handle` plus re-list for `reattach`; note a reject cancels every pending permission in that session |
| Antigravity | SDK has `ask_user` and hooks; abort via `halt_request` | bridge work: expose `ask_user` and an interaction hook; `steer` as cancel + re-run on the same session; fix queued-turn-after-cancel and double `canceled`; persist `conversation_id` via `bind` |

## 6. What this changes versus the first design doc

- `abortBackend` plus `onAbortFailed` becomes `abort` returning `AbortOutcome`.
- `run.ask` replaces per-wrapper permission handlers, and gains `handle`, expiry, authorization and idempotency.
- `inbox` as an async iterable is dropped: steering is a handler with a typed outcome, and the default is core's.
- New: `bind`/`ContextBinding`, `PendingInteraction`, `RunHandle` attachments, `CoreUsage.scope`, `CoreCaller` in replies.

## 7. Evidence-driven findings to track as issues

- A2A SDK is at 1.0.0 with the concurrent-`execute()` hazard and no bus retention; upstream 1.2 adds
  `keepBusAliveStates`, `settleByTaskId` and an atomic cancel. Treat 1.2 as the floor for interactions.
- Wrapper security smells: OpenCode auto-replies `always` (writes persistent project rules); Copilot uses `approveAll`.
- Codex never resumes its thread and passes `contextId` as the task id on cancel; Antigravity publishes `canceled`
  twice and runs queued turns after cancel; Claude wrapper appears to store cumulative cost per round (inferred, to verify).
- Version drift is large for all five (see the snapshot at the top); pins block current features.
- No per-caller authentication: all callers share one owner scope (spec 13.1).

## 8. Open decisions and spikes

Decisions (settled 2026-11-21):

1. **Message to a running task:** the caller chooses `delivery` per message: `queue` (default), `steer` or
   `interrupt` (section 3.4).
2. **Secret questions:** allowed in v1. We assume an authenticated or local deployment. The `secret` flag stays in the
   model so redaction (logs, store, traces) and refusal rules can be added later without a model change.
3. **Who may answer:** deferred, and designed as middleware. Core routes every interaction reply, steer and cancel
   through one choke point, `authorize(caller, action, target)`, which is allow-all in v1. The caller identity is
   recorded in `by` from the start (`anonymous` for now), so adding the check later changes no data model.
4. **A2A SDK:** upgrade to the latest release (1.3.0 at the research snapshot) before any interaction work.
5. **Codex:** stays on the exec SDK for now. It offers no interactions or steering until revisited; core defaults apply
   (a `steer` request is `held`; permission requests cannot arise because exec mode cannot prompt).
6. **Auto-answer policy:** see 3.9. Default preserves today's per-wrapper behaviour; asking a client is opt-in.

Spikes before implementation:

- **S1.** Validate the run/attachment model (section 4) on SDK 1.0.0 and 1.2: park a run at `input-required`, send the
  reply, confirm the second `execute()` only resolves the ask and streams the rest.
- **S2.** Real Copilot: `onPermissionRequest` left pending, answered later by RPC; measure `immediate` steering and the
  `delivery` event.
- **S3.** Real Claude: `canUseTool` pending across an A2A round trip; `defer` hook behaviour on resume.
- **S4.** OpenCode 2: `delivery` steer vs queue; re-list of pending asks after a wrapper restart.
- **S5.** Codex `app-server` approval and `turn/steer` round trip (only if decision 5 is yes).
