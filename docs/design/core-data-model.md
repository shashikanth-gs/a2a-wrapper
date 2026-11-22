# Core data model and provider contract

Status: proposal, for discussion. Companion to [core-owned-a2a-boundary.md](core-owned-a2a-boundary.md), which states
the principles. This document is the data model, designed from evidence. Evidence lives in
[research/](research/) (one report per area, every claim labelled verified or inferred, with sources).

Steering of in-flight tasks (#109) is implemented and described in section 3.12; 3.4, 3.5, 3.10 and 3.11 carry its choices.
Context binding persistence and resume after a restart (#110) is implemented and described in section 3.13; 3.2, 3.5, 3.6 and 3.8 carry its choices.
The first wrapper on the contract, Copilot (#111), and what core gained for it are described in section 3.14.

Revised after the review of #106 (types, adapter and this document): turn semantics, unknown states, owned and
versioned records, interaction shapes, usage deltas and versioned wire keys. Sections 3.1-3.8 and 4 describe the
revised model; `@a2a-js/sdk` is now 1.3.0 (core's peer dependency).

Research snapshot: 2026-11-21. A2A spec v1.0.1; `@a2a-js/sdk` 1.0.0 installed at the snapshot (now 1.3.0); Claude Agent SDK
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
  nothing: becomes the next turn of that task), `steer` (inject into the running turn), or `interrupt` (abort
  the running turn, then run the message as the next turn of the same task). A task is a sequence of turns and goes
  terminal only when the last turn ends and nothing is queued; an interrupt never ends it with `canceled`. A message
  with only a `contextId` starts a new task in the context lane. Core never lets the SDK start a second concurrent
  `execute()` for a live run.
- **D5. Unknown never approves.** Only an explicit `selected` outcome on an `allow_*` option approves. Unknown
  kinds, outcomes, expired, unavailable and malformed replies all deny.
- **D6. Every open union round-trips unknown members**, so a core upgrade never needs a provider upgrade and the
  reverse.

## 3. Data model

TypeScript is illustrative; the source of truth is `packages/core/src/model/`. Types are exported without any A2A SDK
type. Anything core persists is built from `Json` / `JsonObject` (3.6); live metadata (`Meta`) stays loose.

### 3.1 Primitives

```ts
type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
type JsonObject = { readonly [k: string]: Json };
type Meta = Record<string, unknown>;                     // live, in-flight metadata only; stored data uses JsonObject
type Open<T extends string> = T | (string & {});        // open enum: unknown values round-trip

interface CoreCaller {                                   // set by core from authentication (#68)
  id: string;                                            // stable subject, "anonymous" when unauthenticated
  kind: Open<"user" | "agent" | "service" | "anonymous">;
  scopes?: readonly string[];                            // kept on the caller, never on the request
  claims?: JsonObject;
}

type CorePart =
  | { kind: "text"; text: string; mediaType?: string; meta?: Meta }
  | { kind: "data"; data: unknown; mediaType?: string; meta?: Meta }
  | CoreFilePart                                         // bytes (optionally with the uri they came from) | uri; never neither
  | { kind: "unknown"; raw: unknown };                   // kind this core version does not model

type CoreTaskState = Open<
  | "submitted" | "working" | "input-required" | "auth-required"
  | "completed" | "failed" | "canceled" | "rejected">;

type TaskStateClass = "active" | "interrupted" | "terminal" | "unknown";
function classifyState(s: CoreTaskState): TaskStateClass;   // callers must handle "unknown" explicitly
```

`isTerminalState` and `isInterruptedState` remain. Unknown is neither.

**Unknown task states.** Core never produces one: a provider cannot name a state (3.2). Core can receive one (a peer
agent, an old stored task). The policy, in order: treat the task as still running (`classifyState` returns
`"unknown"`, which is neither terminal nor interrupted), keep the original string for display, and let each caller
decide what to do about it, for example fail the task after a policy timeout in which no known state arrives. An
unknown state is never read as completion and never as approval. On the wire core never emits
`TASK_STATE_UNSPECIFIED`; see section 4.

### 3.2 Request, session binding, run and events

```ts
interface CoreRequest {                                  // what a provider receives
  runId: string;                                         // one per task
  turnId: string;                                        // one per turn of the run
  taskId: string; contextId: string;
  input: readonly CorePart[];
  history: readonly HistoryMessage[];                    // from and at are optional: A2A stores neither, so neither is invented
  caller: CoreCaller;
  session?: { ref: string; meta?: JsonObject };         // persisted provider session, if this context has one
  correlation: { eventId: string; parentAgentId?: string; trace?: CoreTraceContext; metadata: Meta };
  extensions: ReadonlyMap<string, unknown>;
}

interface CoreTaskRun {                                  // what a provider acts through
  readonly signal: CoreAbortSignal;                      // aborted on cancel AND on interrupt; signal.reason is the AbortReason
  progress(text?: string, meta?: Meta): void;            // always "working"
  event(e: CoreEvent): void;
  artifact(a: CoreArtifact): void;
  ask(i: CoreInteractionRequest, opts?: AskOptions): Promise<CoreInteractionResult>;
  bind(session: { ref: string; meta?: JsonObject }): void;  // persist contextId -> provider session (survives restart)
  race<T>(work: Promise<T>): Promise<T | typeof CANCELED>;
  complete(result: CoreResult): void;                    // completed
  fail(error: CoreError): void;                          // failed
  reject(reason: CoreError): void;                       // rejected: the request is refused, not attempted
  beginHeldTurn(handle: string): CoreTaskRun;            // a provider-held message now runs: new turnId, task stays non-terminal
  dropHeld(handle: string): void;                        // the provider discarded a held message (flush on interrupt/cancel)
}
```

**When a task goes terminal.** A task goes terminal only when the last turn ends AND no core-queued message remains
AND no provider-held handle remains un-run and un-dropped. A provider that answers a steer with `queued` (Copilot
enqueue, OpenCode inbox, Claude `later`) holds the message; when that message starts, the provider calls
`run.beginHeldTurn(handle)` and ends the returned view's turn with `complete`, `fail` or `reject`; when the provider
discards it (a cancel or interrupt flushed its queue), it calls `run.dropHeld(handle)`. The `handle` is the one the
provider returned in `SteerOutcome.queued`; it is REQUIRED there (a provider with nothing better uses
`CoreMessage.id`), because without a handle the message could never be announced or dropped and the task would never
go terminal. **Liveness backstop:** if `provider.run()` settles while held handles are neither begun nor dropped, core
treats them as dropped (and reports it), so a provider that forgets cannot keep a task open forever. Without these calls
`complete()` of the running turn would end the task and the held message's output would arrive after it is terminal and
be dropped. The cancel/abort side of the runtime is implemented (issue #107, section 3.10), so is `ask` (issue #108,
section 3.11) and so is the steering runtime that drives `beginHeldTurn` / `dropHeld` (issue #109, section 3.12).

`signal.reason` is the `AbortReason` core stopped the run for (`cancel`, `interrupt`, `shutdown`), and an interrupt
aborts the signal too, so a provider reading only the signal can tell a stop-and-continue from a stop-for-good.

A provider cannot name a task state. Terminal states come only from `complete`, `fail` and `reject`; interrupted
states only from `ask`; `progress` is always `working`. A state core does not know can therefore never be emitted.

**Runs and turns.** A task has one `runId` and is a sequence of turns, each with a `turnId`. A message queued or
interrupting at a task is the next turn of that same task; the task goes terminal only when the last turn ends and
nothing is queued for it (3.4).

**How a run ends.**

- `run()` resolves without calling `complete`, `fail` or `reject`: core completes the turn with the text accumulated
  from `text` events, or fails it (`code: "internal"`, "provider returned without a result") when there is none.
- `run()` rejects: core fails the turn with the error message.
- After a cancel, everything the provider publishes is dropped, including a late `complete`. Exactly one terminal
  outcome wins, claimed synchronously (as `TaskRunRegistry` does today).
- A second `complete`/`fail`/`reject` for one turn is ignored.

```ts
type CoreEvent = ({
  type: "text" | "thought";  messageId?: string; text: string;       // DELTAS: append text to the message messageId
} | {
  type: "tool"; id: string; name: string; kind?: ToolKind;           // read | edit | delete | move | search | execute | think | fetch | switch_mode | other
  state: Open<"started" | "running" | "completed" | "failed">;
  input?: unknown; output?: unknown;
  locations?: readonly { path: string; line?: number }[];
  parentToolId?: string;
} | { type: "plan"; entries: ... } | { type: "todo"; items: ... }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "usage"; usage: CoreUsage }
  | { type: "log"; level: ...; message: string }
  | { type: "unknown"; raw: unknown }) & { agent?: { id: string; parentId?: string } };  // set for a sub-agent's events

interface CoreError { message: string; code?: Open<"timeout"|"backend"|"auth"|"internal"|"rate_limit"|"context_overflow"|"invalid_request"|"unavailable">;
                      retryable?: boolean; detail?: unknown; }
```

`bind` replaces each wrapper's in-memory `contextId` to session map. On the next request for that context
(including after a restart) core passes the stored `session` back in `CoreRequest`, when it may (the rules are in
3.13: the binding belongs to the caller, was written by this provider and has not expired). The signature stays
`bind(session: { ref; meta? })`; a `ref` that is empty or a `meta` that is not JSON-safe makes `bind` throw a `TypeError`
(a binding that cannot be stored would otherwise be lost silently, and the context would not resume after a restart).
A provider whose backend cannot resume `request.session` reports `code: "session-not-found"` (3.5).

**Records of runs.** A `RunRecord` is one record per task (`runId`), updated per turn. The startup sweep reads its state
through `classifyState`: `active` with no live handle is an orphan, `unknown` is handled by policy and never assumed
finished.

**Context lane.** Turns in one context run one at a time. A message that carries only a `contextId` (no `taskId`)
starts a new task in that context and waits in the context's lane behind the running turn; core never runs two turns of
one context concurrently, so one provider session never sees overlapping prompts.

`handle` on `ask` is opaque provider data (a Copilot `requestId`, an OpenCode `requestID`, ...). Its presence is the
signal that the interaction can be re-attached after a restart; absent means it cannot. No flag is needed.

### 3.3 Interactions

`CoreInteraction` is a union keyed by `kind`, so each kind has the fields it needs:

```ts
interface InteractionBase {
  id: string;                                            // core-assigned, stable, idempotency key
  title: string; description?: string;
  subject?: InteractionSubject;                          // what the question is about
  expiresAt?: string;                                    // core fills from policy when absent
  replyCode?: string;                                    // core-assigned, see "stale text replies"
  meta?: JsonObject;
}
type CoreInteraction =
  | (InteractionBase & { kind: "permission"; options: NonEmpty<InteractionOption> })
  | (InteractionBase & { kind: "confirm";    options: NonEmpty<InteractionOption> })
  | (InteractionBase & { kind: "question";   questions: NonEmpty<Question> })
  | (InteractionBase & { kind: "form";       schema: FlatSchema })
  | (InteractionBase & { kind: "auth";       auth: AuthChallenge })
  | (InteractionBase & { kind: string & {}; options?; questions?; schema?; auth? });   // a kind this core does not model
```

The open last member accepts any kind string, so the compiler alone cannot reject a `permission` with no options.
`normalizeInteraction(request, {id})` is the enforcement and runs on every `run.ask`: a `confirm` without options gets
`allow_once` / `reject_once`; a `permission` with no options, a `question` with no questions, a `form` with no schema,
an `auth` with no service, duplicate ids or non-JSON `meta` are refused (core answers the ask `unavailable`). An
unknown kind passes through and can only be answered by explicit option selection.

```ts
interface InteractionOption {                            // permission option; shape follows ACP, plus our fields
  id: string; label: string;
  kind: Open<"allow_once" | "allow_always" | "reject_once" | "reject_always">;
  scope?: Open<"call" | "session" | "context" | "location" | "project" | "permanent">;
  allowsFeedback?: boolean;                              // a reject may carry text for the model
  interrupts?: boolean;                                  // choosing it also aborts the turn (Claude deny.interrupt, Codex cancel)
}
interface Question {                                     // one entry of a question interaction
  id: string; header?: string; prompt: string;
  options?: readonly { id: string; label: string; description?: string; meta?: JsonObject }[];
  multi?: boolean;
  allowFreeform?: boolean;                               // Claude/OpenCode "custom", Codex isOther, Copilot allowFreeform
  secret?: boolean;                                      // Codex isSecret
}
interface FlatSchema {                                   // MCP elicitation subset: primitives, enums, titled enums, multi-select
  properties: Record<string, { type?: "string"|"number"|"integer"|"boolean"|"array"; title?; description?;
                               enum?: Json[]; oneOf?: { const; title }[];              // titled single choice
                               items?: { enum?: string[]; anyOf?: { const: string; title: string }[] };  // multi-select
                               minItems?; maxItems?; default?: Json }>;
  required?: readonly string[];
}
interface AuthChallenge { service: string; url?: string; userCode?: string; instructions?: string; }   // out-of-band only
interface AskOptions { handle?: string; signal?: AbortSignal; }
```

`FlatSchema` validation reads own properties only (`Object.hasOwn`): a value named `constructor` or `__proto__` is not
a declared field.

Result, always produced by core, never by a provider:

```ts
type CoreInteractionResult =
  | { outcome: "selected"; optionId: string; feedback?: string; amendment?: JsonObject; by: CoreCaller }   // amendment: edits to the proposed action
  | { outcome: "answered"; answers: Record<string, { optionIds?: string[]; text?: string; freeText?: string }>; by: CoreCaller }
  | { outcome: "submitted"; values: JsonObject; by: CoreCaller }    // form
  | { outcome: "declined"; feedback?: string; by: CoreCaller }      // the caller explicitly refused
  | { outcome: "dismissed"; by?: CoreCaller }                       // the caller closed it without choosing (MCP "cancel")
  | { outcome: "completed"; by?: CoreCaller }                       // auth finished out of band
  | { outcome: "canceled" }                                         // task canceled while pending
  | { outcome: "expired" }                                          // core timeout
  | { outcome: "withdrawn" }                                        // the provider withdrew the ask (AskOptions.signal)
  | { outcome: "unavailable"; reason: string };                     // nobody can answer (policy, no client, malformed request)
```

`unavailable` also carries a typed `code` (`policy-auto`, `interactions-disabled`, `invalid-request`, `internal`; an open union, `reason`
stays human text): a provider acts on the code, not on the text and not on its own configuration. An unknown or missing code is an
ordinary denial.

Per D5, a provider treats `selected` of an `allow_*` option as approval and everything else as denial. Providers map
`feedback` to their native field (Claude deny `message`, Copilot reject feedback, OpenCode reply `message`) and
`amendment` to theirs (Claude `updatedInput`). `freeText` is text typed beside or instead of the options ("other");
`text` is a free-form-only answer.

**Withdrawal.** `AskOptions.signal`: when it aborts before an answer, core resolves the ask `{outcome: "withdrawn"}`,
marks the record `withdrawn`, and presents the next queued interaction, or returns the task to `working` if none.

**Several asks in one task (per-task FIFO).** A task presents one interaction at a time. The first `ask` is
`presented`; asks made while one is open are `queued`, in `seq` order. When the presented one ends (answered, expired,
canceled, withdrawn) the lowest-`seq` queued one is presented. A reply is always matched against the presented
interaction, so a stale reply for an earlier one cannot reach a later one. Pure helpers: `initialInteractionState`,
`presentedInteraction`, `nextQueuedInteraction`. The queueing runtime is implemented (#108, section 3.11).

**Stale text replies.** Core assigns each interaction a `replyCode`: four characters from an alphabet without look-alikes
(no `0 1 I L O`), about 920,000 values, deterministic from the interaction id and its per-task `seq` (so re-rendering the
prompt shows the same code, and a stale code from the previous interaction does not collide with the next by
construction). The text rendering says "Reply with the option number and the code, for example `1 K7M2`", and `parseInteractionReply` selects an
`allow_*` option from text only when the reply carries the presented interaction's code ("1 K7", "yes K7"). No code,
a wrong code, or an interaction with no code: the reply is ignored. A text reject needs no code (a stale "no" only
denies); "no" / "deny" selects a `reject_once` option that does NOT have `interrupts: true`, and falls back to an
interrupting one only when it is the only reject. Structured replies are bound by `interactionId` and need no code. The code is not a secret and not
authentication; it stops a "yes" meant for one prompt from approving the next.

**Unparseable replies.** When a text reply to the presented interaction cannot be parsed (no code, wrong option, no
match), `parseInteractionReply` returns `undefined` and core ignores the message with no side effect; the runtime
re-publishes the prompt with a hint ("That reply could not be matched to the open request.", then the numbered options
and the code; implemented in #108, section 3.11). Claude's global `AskUserQuestion` `response`
maps to `declined` with `feedback`.

**Kind spelling.** `normalizeInteraction` refuses a `kind` that equals a known kind after trim and case-folding
("Permission", " confirm"): it is a typo, and treating it as an unknown kind would skip the shape checks. Subject
`detail` and option `meta` must be JSON-safe like `meta`.

**Free-form answers.** When an interaction has questions, "no", "n", "deny" and "decline" are answers like any other;
declining a question is the structured `declined`, never a word.

**Expiry defaults** (core fills `expiresAt` from policy when the provider gives none; `interactions.timeoutMs` in 3.9
overrides): permission, confirm, question and form 10 minutes; auth 30 minutes (a person signs in on another device).
An expired interaction is stored `expired`. What the PROVIDER sees depends on `onTimeout` (3.9): under `"deny"` its `ask`
resolves `{outcome: "expired"}` and the same run goes on; under `"fail"` (the default) core fails the task through
`registry.expire`, whose terminal claim is taken synchronously before the ask promise is delivered, so the provider sees
`{outcome: "canceled"}` and its `signal` aborts with reason `cancel`. The stored record and the failed task say why. Neither
outcome approves.

**Secrets.** Secret questions are allowed in v1 by owner decision, which deviates from MCP form-mode elicitation
("MUST NOT request secrets"). The `secret` flag keeps redaction possible: `redactSecretAnswers` drops the text of
secret answers before they are stored and returns the removed paths, which the record keeps in `result.redacted`.

### 3.4 Steering and messages

A task is a sequence of turns (3.2). A message to a task that is running runs as the next turn of that same task, by
the caller's `delivery`:

- `queue` (default): next turn of the task, after the running turn ends.
- `steer`: folded into the running turn.
- `interrupt`: stop the running turn, then run the message as the NEXT turn of the task: it runs before provider-held steers handed
  back with `settleSteer(handle, "requeue")` and before messages that were already core-queued (3.16 gives the full order).

The task stays `working` through all three: an interrupt does **not** end the task with `canceled`. This follows the
open A2A steering proposal (a2aproject #2125), which keeps the task working on a steer and goes `input-required` with
`interrupted: true` when a turn is stopped waiting for direction; the proposal is not final and the inbound alias in
section 4 is best effort. The task goes terminal only when the last turn ends and nothing is queued for it. A message
with only a `contextId` starts a new task in the context lane (3.2). Precisely: the task goes terminal only when the
last turn ends AND no core-queued message AND no provider-held handle remains (3.2).

**Not the #2125 `interrupt`.** In the A2A proposal `interrupt` means "stop and wait": the task goes `input-required` with
`interrupted: true`. Core's `interrupt` aborts the turn and runs the message as the next turn. The inbound alias exists
for best-effort compatibility only and is never advertised in the agent card. The one place core does what the proposal
says is an `interrupt` that carries NO content (an empty or control-only message): the turn is aborted and the task parks
in `input-required` with `interrupted: true` until the next message (decision 2, section 3.12). So the alias differs
from #2125 exactly when the interrupting message has content.

**Decisions settled for #109 (owner, recorded here; implementation in 3.12).**

1. **A message to a running task carries a caller-chosen `delivery`**: `queue` (default), `steer`, `interrupt`. Core has no
   provider branching and no flags: capabilities are which `ProviderExecutor` handlers exist and the outcomes they return,
   and unsupported behaviour gets a core fallback that says so (below).
2. **While an interaction is presented** (the task is parked), `interrupt` may preempt it (pending interactions settle
   `canceled`, `abort(info, "interrupt")`, the message becomes the next turn); `steer` and `queue` do not answer or withdraw an
   interaction, they are queued behind it. `delivery: steer | interrupt` is routed BEFORE `handleReply`; a message with
   no `delivery` stays a reply attempt first; an explicit `queue` is a reply only when it parses as one, else it waits.
3. **`interrupt` with no follow-up content** aborts the turn and parks the task as `input-required` with `interrupted: true`
   (A2A proposal #2125), holding the context lane until the next message continues it.
4. **How the caller learns the `DeliveryResult`**: a streaming caller gets it as the metadata of the Message that answers its
   request, on its own stream; a blocking caller gets the same Message at once. The spike changed the blocking half of the
   original wording (the task with the result in its status message), see 3.12.

```ts
interface CoreMessage {
  id: string;                                            // returned to the caller at insertion
  role: "user" | "agent";
  parts: readonly CorePart[];
  from: CoreCaller;
  delivery?: Open<"queue" | "steer" | "interrupt">;      // caller intent; default "queue" (D4)
  idempotencyKey?: string;
  at: string;
  meta?: Meta;
}

type SteerOutcome =                                      // what a provider's steer handler returns
  | { state: "inserted" }                                // folded into the running turn
  | { state: "queued"; handle: string }                  // the provider holds it in its own queue; handle is required
  | { state: "rejected"; reason: Open<"no-active-turn" | "not-steerable" | "unsupported">; detail?: string };

type DeliveryResult =                                    // what core tells the caller
  | { state: "inserted"; taskId: string; messageId: string }
  | { state: "queued"; taskId: string; messageId: string; holder: "provider" | "core"; position?: number }
  | { state: "interrupted"; taskId: string; messageId: string }
  | { state: "rejected"; taskId: string; messageId: string; reason: string; detail?: string };
```

Provider handler: `steer?(run, message): Promise<SteerOutcome>`. Outcomes map to evidence: Copilot
`delivery: steering | queued`, OpenCode 2 `steer | queue`, Claude `priority now | next | later`, Codex app-server
`turn/steer` (or `rejected: not-steerable` for review/compact turns), Antigravity workaround (cancel and re-run, then
`inserted`). A provider that returns `queued` holds the message (`holder: "provider"`; `deliveryFromSteer`) and must later call
`run.beginHeldTurn(handle)` or `run.dropHeld(handle)` (3.2), or `run.settleSteer(handle, "inserted" | "dropped")` when the backend
reveals only later that the message was folded into a turn that was running (record `done`) or never delivered (record `dropped`):
the handle is released without starting a turn; idempotent; silent after a cancel. A `SteerOutcome` with a state this core version does not know
is reported as `rejected` / `unsupported` even though the provider may have accepted the message, so a caller must not
blindly resend: resend only with the same `idempotencyKey` or `messageId`. A provider
without `steer` gets the core default: core holds the message in its own per-context lane (`queued`,
`holder: "core"`) and runs it as the next turn; the response says so (`reason: "steer-unsupported: ..."`), and core never
silently changes the caller's choice. A `rejected` outcome is reported `rejected` and the message is NOT queued (unless the
caller asked for `queue`); a handler that throws or times out is `rejected` / `steer-failed` and is remembered by message
id (the provider may have taken it, so a retry must not deliver twice), while a definitive provider rejection is not (a retry
tries again).

`interrupt` is composed by core from `abort(run, "interrupt")` plus the message as the next turn of the same task, so it
works for every provider that implements `abort` (all five) and needs no new handler. Its result is
`{ state: "interrupted" }`. The stopped turn ends without a terminal task state. A provider with no `abort` handler cannot be
interrupted: the message is queued by core and the result says `queued` with `reason: "interrupt-unsupported: ..."` (the
running turn is not touched).

### 3.5 Abort

```ts
type AbortReason = Open<"cancel" | "interrupt" | "shutdown">;
interface AbortOutcome {
  stopped: "confirmed" | "unconfirmed";                  // did the backend acknowledge it stopped
  session: "reusable" | "discard";                       // can the bound session take the next turn
}
```

`abort?(run, reason): Promise<AbortOutcome>`. The reason decides what happens to the provider's native queue: on
`interrupt` the task continues with the next turn, so the provider **keeps** its queue; on `cancel` the task is going
away, so it **flushes** it; `shutdown` is treated as `cancel` unless the provider can resume. A rejected or timed-out
call is treated as `{ stopped: "unconfirmed", session: "discard" }`; core then clears the binding and calls
`release?(session)` so the provider can drop its state. This replaces the earlier `onAbortFailed` hook.

**`session: "discard"` and the issuer rule (#110).** On `discard` (from `abort`, `abortOrphan` or a failed abort) core deletes
the binding only if it still names the session that turn used (a binding rebound meanwhile survives) and calls `release`
with the ref, except when the stored binding has another issuer (another provider or session format): that ref may not be this
provider's to drop and never reaches its `release` (the binding is still deleted). `abortOrphan` after a restart goes through the same path, so a
`discard` clears the binding there too.

**`session-not-found` (#110).** `CoreError.code` gains `"session-not-found"` (exported as `SESSION_NOT_FOUND`, with a
`SessionNotFoundError` a provider can throw). It means: the session in `request.session` is not known to the backend. A
provider reports it with `run.fail({code})` (or `reject`) or by throwing, and core then (1) deletes the binding, (2) does
NOT publish that failure, and (3) runs the SAME turn (same `runId`, same `turnId`, same input) once more with no `session`.
Rules, all tested: only when the turn started from a stored binding; only once (a second `session-not-found` on the retry is
an ordinary failure, `failed` with that code, never a loop); only if the turn has published nothing a replay would repeat (no
`event`, `artifact`, `ask` or `bind`), because after output core cannot replay the turn, so the failure is final and the
binding is NOT forgotten; the first call's view is dead after the retry (its late events, bind and `complete` are dropped),
and a cancel while the retry is being set up wins. `release` is not called (the backend says it is gone). A provider that can
tell cheaply should say `session-not-found` before it emits anything; `probeSession` (3.8) lets core find out at start-up.

`RunRegistry.deliver` with `delivery: "interrupt"` calls `abort(info, "interrupt")` (never `cancel`) only when the provider has the
handler; the lane waits for it to settle before the interrupting message runs (#107), and a cancel arriving meanwhile sends
`abort(info, "cancel")` after it so the provider flushes its native queue (3.10).

`abortOrphan?(info): Promise<AbortOutcome>` (`info` is `{runId, turnId, taskId, contextId, reason, session?}`) covers tasks the store thinks are active but that have no live run. It
returns an outcome, like `abort`, so core can record what the backend confirmed.

**Bus lifetime and orphans (types here; runtime is issue #107).** Core owns the event bus lifetime through SDK 1.3
`ExecutionEventBusManager.settleByTaskId`, which is offered the decision when `execute()` returns and may keep the bus
alive. With SDK 1.3, `tasks/cancel` on a task that has no bus never calls the executor: it writes `CANCELED` straight
to the `TaskStore` (`dist/server/index.js`, `cancelTask`, about lines 3233-3263). A run that is active in core's
`RunRecord` but has no live handle (the process restarted, the bus was settled) would be canceled in the store while
the backend keeps working. Core therefore (a) wraps `TaskStore.save` to detect a `CANCELED` transition for a task whose
`RunRecord` is active with no live handle and calls `abortOrphan`, and (b) runs a startup sweep over active
`RunRecord`s. Both are implemented (#107, section 3.10).

### 3.6 Persistence records (core's `TaskStore` extension)

Every record is JSON-safe, versioned and owned:

```ts
interface RecordHeader {
  v: 1;                                                  // a reader refuses a higher version
  owner: { id: string; kind: string };                   // the task owner; per-caller scoping (spec 13.1) reads it
  tenant?: string;
  createdAt: string; updatedAt: string;
}

type InteractionState = "queued" | "presented" | "answered" | "expired" | "canceled" | "withdrawn";
interface PendingInteraction extends RecordHeader {
  interaction: CoreInteraction;
  taskId: string; contextId: string; runId: string;
  seq: number;                                           // per-task order; FIFO of presentation
  state: InteractionState;                               // queued and presented are open, the rest final
  expiresAt: string;
  result?: CoreInteractionResult & { redacted?: readonly string[] };  // redacted: removed paths, e.g. "answers.token.text"
  handle?: string;                                       // opaque provider handle, if re-attachable
}
interface ContextBinding extends RecordHeader {
  contextId: string;                                     // owner/tenant = the caller that owns the CONTEXT (3.13)
  session?: { ref: string; meta?: JsonObject; issuer: string };   // issuer: `<ProviderInfo.id>@<sessionFormat ?? "1">`, equality only
  lastUsedAt?: string;                                   // last bind or resume (touch); the TTL and GC measure this
}
interface RunRecord extends RecordHeader {              // one per task (runId), updated per turn
  runId: string; taskId: string; contextId: string; turnId: string;
  state: CoreTaskState; startedAt: string; endedAt?: string;
  cancel?: { requestedAt: string; by: string; abort?: AbortOutcome };
  input?: readonly CorePart[];                           // diagnostics only
}
interface QueuedMessageRecord extends RecordHeader {     // a message held for a task, survives a restart
  taskId: string; contextId: string;
  message: CoreMessage;                                  // live; encodeRecord stores bytes as $bytes:v1
  holder: "provider" | "core"; position?: number; handle?: string;   // position: ordering key, monotonic per run (3.12)
  state: "queued" | "running" | "done" | "dropped" | "unknown";   // unknown: provider-held, fate not confirmed by the sweep
  reason?: string;                                       // why it ended dropped or unknown
}
```

`RunRecord.input` is diagnostics only: core never replays it after a crash (a replay could repeat side effects). It may
hold bytes and secrets, so a store treats it like any other sensitive field (encryption, retention, redaction). A
`QueuedMessageRecord` is restart-safe as follows.

*Core-queued messages* (`holder: "core"`): after a restart core replays only records still in `queued`, in `position`
order. Before it calls `provider.run` for one it persists `queued -> running` with an atomic claim (compare-and-set on
the record), so two core instances or a crash between claim and run cannot start it twice. A record found in `running`
at restart is an orphaned turn: it is NEVER replayed (the turn may already have had side effects); the orphan sweep
handles it (3.5). Queued messages may expire after a long outage (core drops those older than a policy age). If the
orphan sweep fails the task, its remaining queued messages are marked `dropped` and reported, because the SDK rejects
messages to a terminal task. The alternative is for the sweep to end only the orphaned turn (as `failed` for that turn)
and let the task continue with its queue. **Recommended: the alternative**, ending only the orphaned turn and continuing
the queue, whenever the provider session is reusable; fail the whole task (and drop and report the queue) only when the
session must be discarded.

*Provider-held messages* (`holder: "provider"`): do not assume the provider's queue died (the OpenCode v2 inbox is
durable server side). Before marking one `dropped`, core calls `abortOrphan({reason: "cancel"})`; it marks the record
`dropped` only when the outcome is `stopped: "confirmed"`. Otherwise it records "state unknown" and reports it. `reattach`
may alternatively cover held handles, so a provider that can resume its queue gets them back and calls
`run.beginHeldTurn` or `run.dropHeld` itself.

`encodeRecord` turns a record into plain JSON (`JSON.stringify`-safe): file bytes inside file parts become
`{kind: "file", bytes: {"$bytes:v1": "<base64>"}, uri?, ...}` (the marker is decoded wherever it appears, and a user
object that merely looks like `{kind: "file", bytes: {base64}}` is left alone); `undefined` is dropped; anything else
that is not JSON (a function, `Date`, `Map`, class instance, `NaN`, bigint) throws at write time, and so does ANY live
object that uses the reserved `$bytes:v1` key (a client's data part must not be turned into bytes, so core never
re-encodes stored data). A `__proto__` key is kept as an ordinary own property on both encode and decode, never as a
prototype. `normalizeInteraction` also checks the whole request is JSON-safe (schema defaults, extra fields), so bad
input is refused at ask time. `decodeRecord` reverses it, restoring `Uint8Array`, and refuses a
record with no version or a version newer than this core's. `encodePart` / `decodePart` do the same for one part.

After a restart, core finds open records (`presented`, `queued`). Those with a `handle` go to the provider's
`reattach?(records, runs)` so it can resume waiting (Copilot `continuePendingWork`, OpenCode re-list). The rest become
`expired` and the task is failed with a precise reason ("server restarted") instead of hanging. Implemented in #108:
the sweep reads `interrupted` run records (`input-required` / `auth-required`), see 3.11.
Context bindings are not part of that sweep: they are resolved when the next request for their context starts (owner, issuer and TTL rules, then handed to the provider as `request.session`), and optionally validated at start-up with `probeSession` (3.13).

### 3.7 Static provider info and usage

```ts
interface ProviderInfo {                                 // descriptive only; core never branches on it (except sessionFormat, equality only)
  id: string; displayName: string; version?: string;
  sessionFormat?: string;                                // format of the session refs the provider persists; NOT the package version (3.13)
  inputModes: readonly string[]; outputModes: readonly string[];   // media types, feed the agent card
}

interface UsageCounters { input?; output?; cacheRead?; cacheWrite?; reasoning?; total?: number }
interface CoreUsage {
  scope: "delta" | "cumulative";
  series?: string;                                       // identity of the running total (cumulative)
  tokens: UsageCounters;
  costUsd?: number | null;                               // null when the provider does not report cost
  contextWindow?: { used?: number; limit?: number };
  model?: string;
  byModel?: Record<string, UsageCounters & { costUsd?: number | null }>;
}
function usageDelta(prev: CoreUsage | undefined, next: CoreUsage): CoreUsage;
```

`cumulative` is a running total, and a running total only means something against its own previous reading. `series`
names the thing that accumulates (for example one per provider session); two readings belong together only when their
`series` is equal. `usageDelta` is the pure conversion core applies:

- `next.scope === "delta"`: returned as is.
- No `prev`, or a different `series`: the reading is the delta (a new total).
- Same series: each (series, model) group is diffed on its own, the top-level counters and every `byModel` entry. If any
  counter or the cost of a group went DOWN, the total was reset and a new epoch starts: the delta is the new reading,
  never a negative number.

This is what the evidence needs: Claude's `total_cost_usd` is cumulative across turns, resumes from the transcript and
resets on `/clear`. A provider that resumes a session and keeps reporting the same series with continuing totals yields
plain differences; one that starts a fresh total reports a new `series` (or the total drops and the epoch rule applies).
`contextWindow` is a point-in-time reading and is passed through. A provider that reports an aggregate over several models
MUST leave `model` unset and use `byModel`; `model` on an aggregate would attribute everything to one model.

### 3.8 Provider contract (summary)

```ts
interface ProviderExecutor {
  info(): ProviderInfo;
  initialize(): Promise<void>;
  run(req: CoreRequest, run: CoreTaskRun): Promise<void>;                  // required
  steer?(run: CoreTaskRun, m: CoreMessage): Promise<SteerOutcome>;
  abort?(run: TaskRunInfo, reason: AbortReason): Promise<AbortOutcome>;
  abortOrphan?(info: { taskId: string; contextId: string; session?: { ref: string } }): Promise<AbortOutcome>;
  reattach?(pending: readonly PendingInteraction[]): Promise<void>;
  release?(session: { ref: string }): Promise<void>;
  probeSession?(session: { ref: string; meta?: JsonObject }): Promise<"alive" | "gone" | "unknown">;   // #110, optional
  shutdown(): Promise<void>;
}
```

`probeSession` is additive and optional (no flag): core calls it only when `validateBindingsOnStart` is set (3.13). A provider
without it, or whose probe rejects or times out (`abortTimeoutMs`), is treated as `"unknown"`: the binding is kept and the first
resume decides (`session-not-found`). `"gone"` deletes the binding; `"alive"` keeps it. It must not change the session.

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
  "onTimeout": "fail",       // "fail" (default) | "deny". "fail": the task fails; the provider sees {outcome: "canceled"}
                             //   and its signal aborts (reason "cancel"). "deny": the provider sees {outcome: "expired"}
  "autoAnswer": [            // rules answered without a person; first match wins (both modes, see below)
    { "match": { "kind": "permission", "risk": "low" }, "answer": { "kind": "allow_once" } }
  ]
}
```

In `ask` mode, unmatched interactions go to the client, and an unanswered one expires (D5: never an approval). The
authorization middleware (decision 3) later decides *who* may answer; this policy decides *whether* a person is asked.

**Implemented (#108): `InteractionPolicy`** (`runtime/interaction-policy.ts`, passed as `RunRegistryOptions.interactionPolicy`).
Choices made where this section was open:

- `mode: "auto"` is the default and keeps today's behaviour: core asks nobody, nothing is published or stored, and a
  provider that still calls `run.ask` gets `{outcome: "unavailable"}` (a denial). Existing wrappers never call it, and an
  unmigrated or half-migrated wrapper keeps its native handling because the default config has NO rules.
- `autoAnswer` applies in BOTH modes when rules are configured (owner decision): in `auto` mode a rule answers what it
  matches and everything else is `unavailable`, so an operator can reproduce today's approve-everything with one catch-all
  `{match: {}, answer: {kind: "allow_once"}}` rule. In `ask` mode unmatched interactions go to the client. A rule is `{match: {kind?, risk?, tool?, action?}, answer: {kind} | {optionId} |
  {decline: true}}`; `kind` picks the first option of that option kind. Only option-based interactions (permission,
  confirm) can be auto-answered; a rule asking for an option kind the interaction does not offer does not match. The
  answer is recorded `by: {id: "policy", kind: "service"}` (`POLICY_CALLER`), the record is stored `answered`, nothing is
  published and the run never parks. `{decline: true}` selects a plain `reject_once` (not an interrupting one).
- `timeoutMs` overrides the 10-minute default of every kind but `auth`; `authTimeoutMs` (default 30 minutes) overrides auth.
- **`onTimeout` default is `"fail"`, not `"deny"` (spec problem, see 3.11).** An expiry always resolves the interaction
  `expired` and stores it `expired`; `"fail"` then ends the task through `registry.expire` (terminal `failed`, reason in the
  status message, provider aborted), `"deny"` lets the provider see the denial (`expired`) and the same run goes on.
- A malformed policy throws at construction (a typo must not silently become "ask nobody").

### 3.10 Run runtime: the cancel entry point (implemented, #107)

Code: `packages/core/src/runtime/` (SDK-free: `RunRegistry`, `RunHandle`, `RunStore`) and `a2a/` (`CoreExecutor`,
`RunEventBusManager`, `OrphanGuardTaskStore`, `createBusPublisher`). The choices the implementation made:

- **One `RunHandle` per task, lifetime = the terminal claim.** `active -> (finalizing | canceling | expiring) -> ended`,
  claimed synchronously and once. Registered at the first `execute()` (or lane admission), removed after the terminal
  event is published and the stream closed. `TaskRunRegistry` stays as a shim over the same handle and behaves as before
  (it awaits the abort; the core entry point does not).
- **`cancel(taskId, by)`**: `authorize` (sync or async, allow-all by default) -> sync claim -> settle pending interactions,
  drop core-queued and provider-held messages (records get `state: "dropped"`, `reason`) -> persist `RunRecord.state =
  canceled` and publish ONE `canceled` status, close the stream -> abort the signal (reason `cancel`) -> `provider.abort`
  in the background with a timeout. The RPC awaits only the record write. The abort outcome is recorded on
  `RunRecord.cancel.abort`; `session: "discard"` (or a rejection/timeout = `ABORT_FAILED_OUTCOME`) deletes the
  `ContextBinding` and calls `provider.release`. With no `abort` handler core waits (bounded) for `run()` to settle and
  records `unconfirmed` / `reusable` (settling proves nothing: `race` wakes on stop and a provider may return early; only an
  `abort` handler can yield `confirmed`); not settling in time is `ABORT_FAILED_OUTCOME`.
- **Context lane.** Turns of one context run one at a time. The lane slot of a canceled run is released only after its abort
  outcome is applied, so the next task never reuses a session the backend may still be stopping. A run still waiting in
  the lane when canceled is removed: `canceled` is published, the provider is never called.
- **`interrupt`** (`RunRegistry.interrupt`) aborts the turn's signal with reason `interrupt` and calls
  `abort(info, "interrupt")`; no terminal claim, no `canceled`, the task stays non-terminal and continues with the next
  turn (the interrupting message, or one that arrives later). The lane waits for that abort too.
- **A second `execute()` on a live task never starts a provider call.** `delivery: steer | interrupt` goes to the steering
  runtime (`RunRegistry.deliver`, #109, 3.12); a message with no `delivery` (or an explicit `queue`) that is a reply to the
  presented interaction goes to the interactions runtime (`InteractionRuntime.handleReply`, #108); otherwise the message is
  queued as the next turn (default delivery, D4) with a `QueuedMessageRecord`, claimed `queued -> running` by compare-and-set
  before its turn runs.
- **Pending interactions** register `PendingHook`s on the handle; cancel (and expiry) settle them `canceled` inside the
  claim. `ask` is the interactions runtime (#108, 3.11); with the default `mode: "auto"` it still answers `unavailable`.
  `RunRegistry.expire` is the third claim.
- **Orphans.** `RunRegistry.handleStoreCancel(taskId)` is what `OrphanGuardTaskStore` calls when the SDK saves `CANCELED`:
  if the `RunRecord` is non-terminal and no live handle or in-flight terminal write exists, the record is marked
  canceled and `abortOrphan(info)` runs in the background (a live handle is canceled through the normal path instead).
  `RunRegistry.cancel` on a task with no handle but an active record does the same and publishes `canceled` on the bus
  it was given. `RunRegistry.sweep` is the startup pass: `active` records only (`interrupted` ones are left to the
  interactions runtime, an unknown state is reported and never assumed finished), one `abortOrphan` per run; core-queued
  `queued` records are claimed and replayed only through a caller-supplied `replay` hook and only when the session is
  reusable, `running` ones are dropped and never replayed; provider-held ones become `dropped` on `confirmed`, `unknown`
  otherwise; a task that cannot continue is failed (and the A2A store told through `endTask`). A missing `abortOrphan`
  handler counts as `ABORT_FAILED_OUTCOME` (core cannot stop the backend, so it cannot trust the session).
- **Wiring.** `createA2AServer(..., { runRegistry })` is opt-in: it installs `RunEventBusManager` (takes ownership of the bus
  in `settleByTaskId` while a live run exists, releases it when the run ends), wraps the task store with
  `OrphanGuardTaskStore` and runs the sweep. Without the option nothing changes for wrappers on `TaskRunRegistry`.
- **`RunStore`** (`InMemoryRunStore`) keeps `RunRecord`, `ContextBinding` (#110 added `listBindings`, `touchBinding` and a
  compare-and-delete `deleteBinding(contextId, ifRef?)`, 3.13) and `QueuedMessageRecord`, stores the ENCODED form
  (a non-JSON record fails at write time) and has the atomic `claimQueued`. Persistent stores come with #69.
- **Known SDK limits.** `cancelTask(taskId, bus)` receives no call context, so the caller recorded for a cancel is `anonymous`
  until the SDK exposes it. SDK 1.3 has NO guard against a second `execute()` on a live task (a2a-js #632 is the open
  proposal); `sendMessageStream` just does `createOrGetByTaskId`. Before #109 this meant: `CoreExecutor.execute` published no
  Task event for the second request (the bus is shared with the first stream), so the SDK's `_advanceStreamPattern` threw on
  THAT stream ("Received statusUpdate before initial 'Message'/'Task' event") while core had queued the message, so the client got
  an error for a message that would execute and a retry duplicated it. **Solved in 3.12**: the second request gets a private
  bus and one Message carrying the `DeliveryResult`.
- **Records and terminal state.** The terminal `RunRecord` write is retried; until it succeeds an in-memory tombstone
  (bounded, 1000 entries) is trusted over the store, so a failed write cannot make a finished run look active (a second
  cancel, or the SDK's own save of `CANCELED` being treated as an orphan). A queued message's record moves to `done` when
  its turn ends. `endTaskInStore` and the sweep use the record's owner and tenant so owner-scoped stores find the task; the
  sweep runs `abortOrphan` for up to 4 runs at a time. `CoreExecutor.execute` never rejects while the task is live (an SDK
  rejection publishes a second terminal event on the shared bus). `RunHandle` is `@internal` and not exported; the other
  runtimes see `RunInteractionHandle`.
- **Cancel during an interrupt's abort.** `RunHandle.aborting` keeps the in-flight `abort(info, "interrupt")`. A cancel or
  expiry arriving meanwhile waits for it, THEN sends `abort(info, "cancel")` (so the provider flushes its native queue),
  and only then releases the lane.
- **Decisions for #108 (settled by the owner, implemented in 3.11).** (1) A parked run holds its context lane until it
  resolves or expires: providers cannot run two turns on one session, so a second task in the context waits up to the
  interaction timeout. (2) Expiry calls `registry.expire` per the policy (`onTimeout`, defaults 10 minutes, auth 30).
  (3) `handleReply` never throws (`CoreExecutor` swallows an `execute()` rejection on a live task, which would hide the
  error). (4) Restart: pending interactions with a provider `handle` go to `provider.reattach` when it exists, else the sweep
  fails the task with reason "server restarted" and marks the pending records `expired`. (5) Secrets are allowed in answers
  for now (a deviation from MCP form-mode elicitation, which forbids requesting them), never logged, and stored redacted.
- **Decisions for #109 (all settled, section 3.12).** A second message on a live streaming task (the response is honest: one
  Message with the result on a private bus, no error); how a `DeliveryResult` reaches a blocking `sendMessage` caller (the same
  Message, at once); `interrupt` with no follow-up message (parks in `input-required`, interrupted, instead of waiting for a next
  turn forever); where steer dispatch happens (`RunRegistry.attach`, before `handleReply` for `steer` and `interrupt`).
- **Trust.** A store-triggered cancel is recorded as `{id: "store", kind: "service"}` and goes through `authorize`; once
  `authorize` is real, decide whether that identity is trusted (the SDK writes `CANCELED` on behalf of any caller).

### 3.10.1 Spike S1 results: what SDK 1.3 does at `input-required` and `auth-required` (#108)

Measured with the real `DefaultRequestHandler` (in-memory task store) and a bare executor that parks and returns; the
facts are pinned as executable documentation in `packages/core/src/__tests__/a2a/s1-interrupted-states.test.ts`, so an SDK
upgrade that changes one fails there first. The design in 3.11 follows from them.

| Question | Finding |
|---|---|
| (a) blocking `message/send` that parks at `input-required` | Returns the Task with state `input-required` and the status message. `execute()` returned, and the bus is kept alive (`keepBusAliveStates` defaults to the interrupted states; core also owns it through `settleByTaskId`). |
| (b) `message/stream` that parks | The stream delivers `task`, `working`, `input-required` and ENDS: `ExecutionEventQueue.events()` stops at a terminal state or `input-required`. |
| (c) the reply | A new `message/send` or `message/stream` on the same `taskId`. The SDK runs a SECOND `execute()` on the SAME bus. It has already appended the reply to the stored task's `history` and passes the stored task (`ctx.task`, still `input-required`) to that `execute()`. The original stream is long closed: nothing is attached to the bus, so any event published with no new request consuming it is lost to the task store (the SDK updates the store only from consumed events). |
| the opening event | A STREAMING request throws "Received statusUpdate before initial 'Message'/'Task' event" when its first event is a status update, so the reply's `execute()` must publish the Task snapshot (`ctx.task`) first. A BLOCKING request does not check and works either way. A snapshot published while ANOTHER stream is attached to the shared bus breaks that stream ("Stream ordering violation": a `task` event inside a task-lifecycle stream). This is the #117 finding: the live-task attach path skipped the snapshot and the reply stream failed; for a message to a WORKING task the snapshot would break the running stream, which is why that case needed its own answer (spike S2, 3.12). |
| (d) `auth-required` | Different from `input-required`: the SDK queue does NOT stop there, so a streaming client's stream stays open (it expects the executor to resume on the same bus after out-of-band credential injection) while a blocking caller gets the snapshot at once and the SDK keeps draining in the background. If the original stream is left attached, the reply's Task snapshot breaks it (as above) and the continuation of the run reaches only the reply's stream. The older "a fresh request is expected" assumption is superseded: the reply to an auth challenge is also a new request on the same task. |

Consequences for core (all implemented):

1. The first `execute()` returns at the park (`ExecuteOutcome` `parked`) and `CoreExecutor` calls `bus.finished()` for BOTH
   states. At `input-required` the SDK would have stopped listening anyway; at `auth-required` closing it is what keeps the
   reply's snapshot from breaking an open stream, so a client sees the same lifecycle for every interaction.
2. The reply's `execute()` publishes the Task snapshot (`ctx.task`) only when the run is PARKED (`registry.isParked`): then no
   stream is attached. It never does for a run with a stream attached (that is #109).
3. A reply is a new attachment: a new publisher over the same bus. Streamed-artifact bookkeeping (which artifacts already have
   their first chunk, so the next chunk `append`s) is therefore shared per task, or the text after an approval would REPLACE
   the text before it.
4. Nothing consumes the bus while the run is parked, so what core itself does to a parked run (an expiry timer, a withdrawal,
   the next queued interaction, the run completing) would never reach the task store. Core writes the store through the SDK's
   own `ResultManager` (`createStorePublisher`, the registry's "detached publisher"; the server factory wires it). The
   registry switches to it when the last attachment left at a park and back when a reply attaches.

### 3.11 Interactions runtime (implemented, #108; also delivers #65 and #57 at the core level)

Code: `runtime/interactions.ts` (`InteractionsRuntime`, SDK-free), `runtime/interaction-policy.ts`, `model/interaction-reply.ts`
(the SDK-free `parseInteractionReply`, re-exported by the adapter), `a2a/store-publisher.ts`. `RunRegistry` builds the runtime
itself (`interactionPolicy`); the seam for a different one (`InteractionRuntime`, `bind`, `restore`) stays.

- **`run.ask(request, opts)`** assigns the interaction id, the per-task `seq` and the reply code (`replyCodeFor(id, seq)`),
  fills `expiresAt` from policy (a provider-given `expiresAt` is kept), runs `normalizeInteraction` (a malformed request is
  answered `unavailable` with the reasons and never parks), and writes a `PendingInteraction` through `RunStore` (new
  `putPending` / `getPending` / `listPending`, in-memory implementation included). The first ask of a task is `presented`, later
  ones `queued` (FIFO by `seq`, exactly one presented). Only the presented one is published; a queued one's expiry clock
  starts when it is presented (unless the provider fixed `expiresAt`).
- **Parking (#65).** Presenting an interaction writes `RunRecord.state = input-required` (`auth-required` for kind `auth`, so
  the restart sweep sees an `interrupted` record), publishes through `RunPublisher.interaction()` (the adapter's
  `renderInteraction`: text rendering with numbered options and the reply code, plus the structured data part under
  `urn:a2a-wrapper:interaction:v1`), and signals the run parked. `provider.run` stays pending on the `ask` promise, the
  context lane stays held, and the first `execute()` returns `parked`. The parked flag is sticky (`RunHandle.parked`,
  cleared by `signalResumed` before the ask promise resolves) so a reply whose attachment starts waiting after the provider
  already re-parked does not lose the boundary.
- **Replies and resume.** The registry routes a message for a task with a live run to `handleReply`. While an interaction is
  presented EVERY message to the task is a reply attempt: it is parsed (`parseInteractionReply`) against the PRESENTED
  interaction only (structured by `interactionId`, which wins over text beside it; a text approval needs the reply code),
  checked with `authorize(by, "answer", target)` (the single choke point; `by` is the caller from the call context), and on
  success the parked ask resolves and the SAME `provider.run` continues (no second provider run). Then the next queued
  interaction is presented, or the task returns to `working` (a `working` status on the reply's stream). A reply that cannot be
  used (stale id, wrong or missing code, unknown option or outcome, malformed, denied) is ignored: the presented interaction is
  re-published as a status message with a hint, the task stays interrupted, and nothing is approved (D5). A duplicate
  structured reply for an interaction that already ended is ignored with no side effect. `handleReply` never throws: an
  internal error (or an authorizer that throws) consumes the message when anything is open, so it can never run as a turn.
- **Ending.** Answered, `expired`, `canceled` (the task was canceled or ended: the registry's claim settles every presented and
  queued interaction synchronously; complete, fail or reject of the turn does the same after the terminal event, so a run that
  completes with an ask queued drops it cleanly) or `withdrawn` (`AskOptions.signal`: the next queued interaction is presented,
  or the task returns to `working`). Every state change is stored. Timers are `unref`'d and cleared on every end.
- **Expiry** (per kind, 3.9): the interaction resolves and is stored `expired`; then `onTimeout` `"fail"` (default) ends the
  task through `registry.expire` (terminal `failed`, code `timeout`), `"deny"` lets the same run go on. With `"fail"` the
  provider's pending asks are settled by the claim, so the provider sees `canceled` rather than `expired` (the stored record
  says `expired`); neither approves.
- **Detached writes.** Core acts on a parked run nobody consumes (expiry, withdrawal, next interaction, completion) through
  `RunHandle.sink`, which is the detached publisher (`createStorePublisher` over the A2A task store and the SDK's
  `ResultManager`) from the moment the last attachment left at a park until a reply attaches. The server factory wires it.
- **Restart.** `RunRegistry.sweep` no longer skips `interrupted` records. Pending interactions with a `handle`, when the
  provider implements `reattach(pending, runs)`: core re-creates the run (live handle, running turn without a provider call,
  lane held, session from the binding), restores the interactions (same ids, `seq` and codes, timers re-armed against the
  ORIGINAL deadline) and calls `reattach`; the provider calls `runs.view(taskId).ask(request, {handle})` for each, which returns
  the restored interaction's promise, so a client reply after the restart resolves it and the provider continues its turn.
  Otherwise (no `reattach`, no handle, or `reattach` rejects or times out) the open records become `expired`, the run record
  `failed`, and `endTask` tells the A2A store: reason "server restarted".
- **Secrets.** Answers to `secret` questions reach the provider; the stored `PendingInteraction` is redacted
  (`redactSecretAnswers`, paths in `result.redacted`) and no result is ever logged. The A2A task is covered too: the SDK appends
  the reply to `task.history` and saves it BEFORE `execute()` runs, so `OrphanGuardTaskStore.save` (on every write path) asks
  `registry.redactReply` about each user message and stores a copy without the secret (the input is never mutated, the provider's
  request shares those part objects). A structured answer is judged by the stored interaction it names (so it works for a late
  save and after a restart); a text-only reply is replaced entirely when it is the message just appended and the presented
  interaction has a secret question (the text may be the secret), and remembered by message id for later saves. Limits: the
  replying client's OWN stream still carries its own message in the Task snapshot; a text-only reply to an interaction that
  mixes secret and plain questions is hidden as a whole; push notifications are sent by the SDK from the same events and are not
  covered.
- **Two replies at once.** Every message that arrives while the run is parked used to publish its own Task snapshot on the
  shared bus; the second landed inside the first reply's lifecycle stream and broke it (the window is the whole `authorize`
  await). The snapshot is now a one-shot synchronous claim per park (`registry.beginReply`, cleared when that attachment
  leaves or the run parks or resumes again). A reply that loses the claim publishes no snapshot, does not call
  `registry.execute`, is never queued as a turn, and is not used. Since #109 the claim is taken when the shared bus is handed out (`RunEventBusManager.createOrGetByTaskId`),
  and the loser has a private bus: it is answered with a Message (`rejected` / `reply-conflict`), never an error (3.12). The claim
  carries a token (only its holder can refresh or release it) and is kept fresh while the holder's request lives (3.12).
- **Process-local versus stored state.** Everything about an interaction's life is in the store: the record (state, result,
  `seq`, handle) and, for "was this already answered", `getPending` (the in-process `settledIds` set is only a cache in front of
  it, so a duplicate structured reply after a restart is still recognised). Deliberately process-local: the per-run state on a
  `WeakMap` keyed by the run handle (open items, timers, the `seq` counter, answers given to a restored interaction before its
  provider re-asked), the context lanes, tombstones and orphan claims, the bounded set of recognised secret message ids, and the
  publishers' per-task artifact bookkeeping (`RunRegistry.publisherState`, dropped when the run ends and at shutdown; the store
  publisher's write queues belong to its factory). A new run for an old task starts its `seq` at 1: records are keyed by
  interaction id, so nothing collides; only a restored run continues from the stored `seq`. A `RunStore` over SQLite or
  Postgres needs only the three `*Pending` methods for this.
- **Other things implemented in round 2.** A timer longer than 2^31-1 ms (a configurable `timeoutMs` can be) re-arms until the
  deadline has really passed; an interaction answered after a restart but before its provider re-asked is handed to the re-ask
  by handle; `settle` is guarded so a late timer, abort or reply can never rewrite a final record.

**Known limits, documented not coded.**

- **N3.** A late text reply after its interaction resolved ("yes" arriving after a timeout) is not a reply any more: the task is
  `working`, so the message follows the default delivery and becomes the next turn. Structured replies (which name the
  interaction) are ignored as duplicates; plain text cannot be told apart. #109 decided what a message to a working task means
  (3.12) and this stays: the sender is told `queued`, so it can see the message did not answer anything.
- **N6.** Detached store writes (`createStorePublisher`) and the `ResultManager` writes of a consumed stream are each serialized
  but not against each other. The SDK protects terminal states, and the one window left (a late `input-required` landing after a
  `working`) is small and is corrected by the next event.
- **N7.** RESOLVED in #109: `delivery` `steer` / `interrupt` is routed BEFORE `handleReply` (3.12); an explicit `queue` is a reply
  only when it parses as one.
- **N8.** #111: a provider must pass `{handle}` on every ask it wants re-attachable after a restart; without one the sweep fails
  the task ("server restarted").

**Spec problems found.**

1. 3.9 gave `onTimeout` default `deny`, while the owner decision (2) and the table in section 4 say expiry fails the task
   through `registry.expire`. The default is `fail`; `deny` is the opt-in.
2. `ProviderExecutor.reattach(pending)` could not work: after a restart the provider has no run view to continue with. It now
   gets `runs.view(taskId)`, and re-asks with the handle (see Restart).
3. The doc said the SDK does not re-drive streams at `auth-required`; SDK 1.3 keeps the stream open instead (3.10.1). Core
   closes the attachment at every park.
4. A reply to an interrupted task needs the Task snapshot, a task with a stream attached must not get one, and nothing consumes
   the bus while parked (3.10.1); none of this was in the original model.
5. `RunPublisher` gained `interaction()`; a message to a task whose interaction is presented could no longer be queued or steered
   (it was a reply attempt), so `delivery` on such a message was ignored until the interaction ended. RESOLVED in #109: a steer
   or a queue never answers or withdraws an interaction, they wait behind it; an interrupt may preempt it (3.12).
6. The structured payload is always attached next to the text (the agent card does not declare the interaction extension yet,
   so activation cannot be detected); gate `createBusPublisher`'s `interaction()` on activation once the card declares it.
7. A duplicate structured reply while the task is `working` (not parked) is consumed without a snapshot, so a streaming client
   gets the "before initial Task" error; same family as the second-message-on-a-live-task problem. RESOLVED in #109: it gets a
   private bus and an answering Message (`rejected` / `reply-ignored`).

### 3.12 Steering runtime (implemented, #109)

Code: `RunRegistry.deliver` and the `attach` path in `runtime/run-registry.ts` (SDK-free), `a2a/bus-manager.ts`
(`RunEventBusManager`, which bus a request gets), `a2a/core-executor.ts` (the answer), `a2a/adapter.ts` (the wire form of a
`DeliveryResult`), `runtime/interactions.ts` (`handleReply` options).

#### Spike S2: what SDK 1.3 does with a second request to a WORKING task

Measured with the real `DefaultRequestHandler` and a bare executor (no core runtime), pinned in
`__tests__/a2a/s2-message-to-working-task.test.ts`; an SDK upgrade that changes a fact fails there first.

| Question | Finding |
|---|---|
| (a) what does the second request get | A second `execute()` on the SAME `ExecutionEventBus`, and its own `ExecutionEventQueue` on it: every event of either `execute()` reaches BOTH streams. The SDK has already appended the message to the stored task's `history` and hands that task to `execute()`. |
| (b) a streaming second request, first event a status update | The SECOND stream throws "Received statusUpdate before initial 'Message'/'Task' event" (and so does one that publishes nothing, on the first event of the running task). The first stream is unaffected. |
| (c) first event a Task snapshot, or a Message | Valid for the second stream, but the FIRST (task-lifecycle) stream breaks: "Stream ordering violation: received task / message in task lifecycle stream". Nothing published on the shared bus can open the second stream safely. |
| (d) a blocking second request | On the shared bus it returns only when the whole task ends (the SDK queue does not stop at `working`). |
| (e) `execute()` that rejects | The SDK publishes a synthetic Task + FAILED on the shared bus: the running stream breaks for a task that is still running. This is why `CoreExecutor` never rejects for a live task. |
| (f) the stock bus manager | The second `execute()` returning calls `finished()` and `cleanupByTaskId` on the SHARED bus: the running stream ends early and never sees its terminal event. Core's `settleByTaskId` returns `true` for a live run, which prevents it. |
| (g) the way out | `ExecutionEventBusManager.createOrGetByTaskId` is the seam. Handing the second request a PRIVATE bus lets its `execute()` answer with ONE `Message` (a valid answer to `message/send` and `message/stream`): the second stream gets exactly that event and ends, a blocking caller gets it at once, the first stream is untouched, and the Message is not written to the task store (only the SDK's own history append of the user message remains). |

#### Design

- **Which bus.** `RunEventBusManager.createOrGetByTaskId`: the first request of a task, and every request while the task is
  not live, get the shared bus (the SDK's behaviour). For a LIVE task: the one request that may carry the run on gets the shared
  bus (a reply to a parked task: the winner of the park's reply claim, taken here), every other request gets a private bus
  (`isPrivateBus`). `settleByTaskId` keeps the shared bus while the run is live and never lets a private bus replace the
  call context the shared one is cleaned up with.
- **The answer** (`CoreExecutor.answer`, private bus). The message goes to `RunRegistry.execute` with `carriesStream: false` and
  an `onDelivery` callback; the `DeliveryResult` is published as ONE agent `Message` (text for humans plus the result under
  `urn:a2a-wrapper:delivery-result:v1` in its metadata) and the bus is finished. The client never gets an error for a message
  that will be delivered, and never the reverse (an error for a message that is silently queued). A request that ends with no
  answer is given `rejected` / `not-delivered`; one for a task that ended in between is `rejected` / `task-ended`; a message with
  no `delivery` to a parked task on a private bus (it lost the reply claim) is `rejected` / `reply-conflict`, never queued as a
  turn (a late "yes" would run as one). The task's own stream keeps carrying everything: the queued turn's output reaches the
  stream that was already open.
- **Streaming versus blocking caller (decision 4, adjusted by the spike).** Both get the same single Message, on their own
  request. The original wording had a blocking caller receive the task with the result in its status message; on a private bus
  that needs a Task snapshot built from the request-time task, which would overwrite the status and history the running stream
  saved meanwhile (the SDK merges a snapshot into the store), so the Message is the safe form. The limit that matters: a
  blocking `message/send` to a working task returns at once with a Message, not at the end of the task; only the request that
  started the task (or the one that resumes a parked or interrupted task) returns at its end or park. A client that needs the task
  calls `tasks/get` or resubscribes.
- **A request that carries the run on keeps the shared bus**: a reply (3.11), an `interrupt` that preempts an interaction (it
  resumes the run on that request: Task snapshot first, a `working` status whose message metadata holds the result, then the next
  turn's events to its end), and the message that continues an interrupted task. A `steer` or `queue` that reaches a parked task
  on the shared bus re-asserts the stored status (same state, same message id, so the prompt is not replaced and the history gets
  no duplicate) with the result added to that message's metadata, and the stream ends: a blocking caller gets the Task in
  `input-required` with the result in `status.message.metadata`.
- **`RunRegistry.deliver(taskId, message, by, request)`** is the non-A2A entry point (`execute` routes to the same code for a live
  task). Order: unknown `delivery` word is `rejected` / `unsupported-delivery` (never guessed); `authorize(by, intent, task)` (a
  denial or a throwing authorizer is `rejected` / `denied`); de-duplication by message id and `idempotencyKey` (a promise per run,
  decided synchronously, so concurrent duplicates agree, plus a look at the store for a message id already held, after a restart);
  then the intent. A rejection that changed nothing (`denied`, `task-ended`, a definitive provider rejection) is not remembered, so
  a retry tries again; the ambiguous ones (`steer-failed`, `steer-invalid`) are.
- **Intents.**
  - `queue`: core's lane. `enqueue` writes a `QueuedMessageRecord` (`holder: "core"`, `state: "queued"`) and the next turn claims it
    `queued -> running` before `provider.run`. The result's `position` is the live 1-based index; the record's `position` is a
    monotonic ordering key per run (a message that starts does not renumber the others; a new handle starts above the stored
    keys), so they differ after the first one starts.
  - `steer`: `queued` by core when there is no handler (`steer-unsupported`), when an interaction is presented
    (`interaction-presented`: it does not answer or withdraw it) or when no turn is running (`no-active-turn`); otherwise the
    handler gets the running turn's view and decides (`inserted`, `queued{handle}` registered through `registerHeld` so the
    task stays open until `beginHeldTurn` / `dropHeld`, `rejected`). Bounded by `steerTimeoutMs`.
  - `interrupt`: no `abort` handler is a queue (`interrupt-unsupported`); no live turn is a queue (`no-active-turn`). Otherwise
    pending interactions settle `canceled`, the turns' signals abort with reason `interrupt`, `abort(info, "interrupt")` runs, and
    the message (if it has content) is the next turn once the abort settled. Content means a non-blank text part, a file, a data
    part or an unmodeled part (`messageHasContent`).
  - Interrupt with NO content: after the abort the task parks as `input-required` with `interrupted: true` on the status
    (A2A proposal #2125), `RunRecord.state` is `input-required`, the run stays live and HOLDS ITS CONTEXT LANE. The next message,
    whatever its `delivery`, continues the task (`queued` / `continues-interrupted-task`, a `working` status with
    `interrupted: false`); that request carries the stream on when it can. Spec problem: nothing bounded the wait, so a task nobody
    continues now fails with `timeout` after `interruptedTimeoutMs` (default 10 minutes, `0` waits forever) and releases the lane.
    After a restart such a task has no pending interaction and is failed by the sweep ("server restarted"), like any interrupted run.
- **The turn sequence.** A turn that ends while more work is pending (core-queued messages or provider-held handles) publishes its
  result as non-terminal output (its artifacts, parts, text as a `working` status, usage), a failed or rejected one as "The previous
  turn failed: ...", and marks the outcome published so the terminal status of the LAST turn does not repeat it. Before this, the
  text and artifacts of every turn but the last were dropped. The task goes terminal only when the last turn ended with nothing
  queued, held or awaited; the last turn's outcome decides its state.
- **Cancel** flushes core-queued and provider-held messages (records `dropped`, reason `task canceled`) and sends `abort(info,
  "cancel")` after an in-flight interrupt abort, as in 3.10; a view obtained from `beginHeldTurn` after the task ended is dead.
- **Restart** is unchanged (3.6, 3.10) and now exercised through records written by `deliver`: only `queued` core records replay,
  after the atomic claim; a `running` one never; provider-held ones become `dropped` on a confirmed orphan abort, else `unknown`.
- **`RunStore` contract.** `__tests__/runtime/run-store-contract.ts` exports `runStoreContractTests(name, factory)`, a suite over
  every `RunStore` method (runs, bindings, queued messages with the atomic `claimQueued`, pending interactions). `InMemoryRunStore`
  runs it; a SQLite or Postgres store is verified by the same call with its own factory (the factory must return an empty store).

**Round 2 (review of #119).**

- **A steer that races turn end.** `RunHandle.steering` counts in-flight `steer` handlers; while any is in flight the task cannot
  go terminal (`advance`), and the turn that ended under it publishes its result as output. When the handler answers `inserted`
  but the turn it was given is no longer live, the message may never have been seen: core queues it as the next turn and reports
  `queued` with `reason: "turn-ended-during-steer"` (it errs toward delivering, so the rare duplicate is accepted over a lost
  message). A `rejected` after the turn ended is reported as is and the task then finishes. A steer answered after the task was
  canceled is `rejected` / `task-ended`.
- **Reply claim.** `beginReply` returns a token, `endReply(taskId, token)` releases only that claim, and the holder refreshes it
  (`touchReply`, every third of `replyClaimTtlMs`, default 15 s) from when its `execute()` is entered for as long as it lives, so a
  slow `authorize` cannot let a second reply take the claim and break the first reply's stream. The TTL is only a wedge breaker. If
  the SDK fails between creating the bus and calling `execute()` (the push-notification config save of `message/stream` throws),
  core cannot see it: the park stays claimed until the TTL passes, then the next reply takes over.
- **`steerTimeoutMs`** defaults to 30 s. A steer that times out is ambiguous (the provider may have taken the message), is answered
  `rejected` / `steer-failed` and remembered by message id: to resend deliberately a caller must use a NEW message id.
- **Telling the ack from an answer.** The Message that answers a message to a working task has role `agent` and carries the task and
  context ids and readable text, so a client could mistake it for the agent's answer. It is recognisable by its metadata
  `urn:a2a-wrapper:delivery-result:v1` (a client that knows the key checks it first), it arrives as the ONLY event of the request,
  and it never appears in the task's own stream, artifacts or history. A client that ignores the key should treat a bare Message
  answering a message it sent to a running task as an acknowledgement.
- **A non-final turn's failure** is reported as a `working` status ("The previous turn failed: ..."); if a later turn succeeds the
  final task state is `completed` and the earlier failure survives only in that status message and the history.
- **History.** The SDK appends every user message to `task.history` before `execute()`, so a deduplicated or rejected message is
  still in the history, and a duplicate message id may be appended twice.
- **Process-local state.** `deliveries` (dedupe) and `queueSeq` live on the run handle: after a restart the handle is new, the
  ordering key restarts above the stored records (`listQueued`), and a message id already stored is recognised from the store
  (`reason: "duplicate"`).

**Known limits, documented not coded.**

- The ack Message of a message to a working task is not in the task's history and no task event says "a message was queued":
  a client that did not send it learns of the queued turn only from its output.
- `position` is core's queue only; a provider-held message ahead of it (the provider's own queue) is not counted.
- A stream whose client disconnected stops updating the task store (SDK behaviour: only the consumed events are applied); core's
  detached publisher covers a parked run, not a run whose stream is merely gone.
- A message the SDK rejects itself (the task is terminal, the context id does not match) never reaches core.

**Spec problems found.**

1. Decision 4 (a blocking caller gets the Task with the result in its status message) cannot be done safely on a private bus (see
   above); the Message replaces it for a message to a working task and the Task form is kept where the shared bus is safe.
2. `QueuedMessageRecord.position` as a 1-based live position cannot be stored (it changes as turns start); it is an ordering key.
3. The #107 `interrupt` primitive left the task waiting for a next turn forever; it now parks in `input-required` (decision 2) and
   expires.
4. A non-final turn's result was dropped; it is published as output.

What was left for #110 is done (3.13). What is left for #111: the wrappers (providers) implement `steer` (Copilot `mode: immediate` with the `delivery` event,
Claude streaming input with `priority`, OpenCode v2 `delivery`, Antigravity cancel and re-run) and `abort`, pass `handle`s and call
`beginHeldTurn` / `dropHeld`; none of that is in core. Wiring `authorize` to a real identity and declaring the delivery extensions
on the agent card stay open (the card does not declare them yet, so every client gets the Message form).

### 3.13 Context binding runtime (implemented, #110; enables Codex thread resume, #100)

Code: `runtime/bindings.ts` (`ContextBindings`, SDK-free, owned by `RunRegistry`), `RunStore` (`listBindings`, `touchBinding`,
`deleteBinding(contextId, ifRef?)`), `RunRegistry.runTurn` (resolve and the `session-not-found` retry), `sweepBindings()`,
`validateBindings()`. SDK only in `a2a/core-executor.ts`, which now passes the call's tenant (`ExecuteInit.tenant`); the
session reaches the provider through the existing `RequestIds.session` / `coreRequestFromContext`.

**Bind (`run.bind`).** Persists a `ContextBinding` through the `RunStore`: `owner` and `tenant` = the caller (and tenant) of the
turn that bound, `createdAt`, `updatedAt` and `lastUsedAt` = now, `session = {ref, meta, issuer}` with `issuer =
"<ProviderInfo.id>@<ProviderInfo.sessionFormat ?? '1'>"` (or `RunRegistryOptions.issuer`). A rebind replaces the session and keeps the owner
(`createdAt` restarts only when the ref differs, see `bindingMaxAgeMs`). A bind after a cancel (or from a stopped or retried-away turn) is a silent drop (the `live()` gate). A bind
from a stale turn cannot overwrite a newer one: every turn has a process-wide start order, writes of one context are applied
through one promise chain in call order (a slow store cannot reorder them), and a bind from a turn older than the last turn
that bound is dropped (the real case: a provider-held message started a newer turn through `beginHeldTurn` while the older
turn's view is still live). A bind over a binding another caller owns is dropped with a warning, never applied.

**Resolve at turn start.** In `runTurn`, AFTER the context's lane slot is held, so the previous turn of the context has ended
and its bind was written (it reads through the same per-context chain): load the binding and, in this order:

1. none (or a header with no session): fresh;
2. **owner**: `owner.id`, `owner.kind` and `tenant` must equal the turn's caller and tenant. Otherwise the turn is REJECTED
   (task `rejected`, `CoreError.code: "forbidden"`, `detail.reason: "context-owner-mismatch"`) and the provider is never called.
   Choice (spec 13.1, "scoped per caller"): reject, never silently give B a fresh session on A's contextId. The binding is left
   alone (B cannot delete A's session by sending its contextId), and this check comes before issuer and TTL for the same
   reason. Today every caller is `anonymous` (`UserBuilder.noAuthentication`), so nothing changes until authentication is
   wired; the tenant comes from the SDK call context;
3. **issuer**: `binding.session.issuer` must equal the current issuer, compared for equality only. The issuer is the provider
   id plus its declared session FORMAT (`ProviderInfo.sessionFormat`, default `"1"`), NOT the package version: a deploy that
   bumps `ProviderInfo.version` keeps every conversation (Claude, Copilot, Codex and OpenCode sessions survive SDK upgrades).
   A binding with a different issuer (another provider, another session format, another configured issuer) is never replayed:
   it is deleted and the turn starts fresh, and `provider.release` is NEVER called for it (the new format may not understand
   the ref, and releasing could kill a session the old format still owns). `RunRegistryOptions.issuer`, when given, replaces the
   derived string as the issuer (equality only, same rules). In the derived string `%` and `@` in the id and the format are
   escaped (`%25`, `%40`), so `(id "a@b", format "1")` and `(id "a", format "b@1")` can never produce the same issuer. If
   `info()` throws or the id is empty the issuer is UNKNOWN and matches nothing: no binding is handed over, written or
   released (a stale one may be deleted), so two broken providers never share a binding. A provider changes `sessionFormat` only when a stored
   ref or meta of the old shape cannot be resumed by the new code. `release` is called only for a binding whose issuer EQUALS
   the current one: TTL expiry, `discard` and `sweepBindings`;
4. **TTL** (`RunRegistryOptions.bindingTtlMs`, default none): `now - (lastUsedAt ?? updatedAt) > ttl` deletes and releases it,
   the turn starts fresh;
5. `authorize(by, "resume", {taskId, contextId, ownerId})`: false or a throwing authorizer rejects the turn (`forbidden`,
   `detail.reason: "denied"`). `authorize` stays allow-all by default and stays the single choke point; it can only ADD
   restrictions: it cannot override the owner check (with the allow-all default an override would make the check vanish). A
   future "an admin may resume anyone's context" needs its own decision;
6. touch (`lastUsedAt`, compare-and-set on the ref so a concurrent rebind is not marked) and hand `{ref, meta}` to the provider
   as `request.session`. A turn that ends touches it again, so a long turn does not look idle to the TTL.

A store failure while reading is logged and the turn starts fresh. Logs never contain a session `ref` or `meta`.

**Restart.** The bindings are in the store, so a new registry over the same store resumes them: request 2 on a context gets
what request 1 bound, also across a process restart (test: two requests on one contextId through the real
`DefaultRequestHandler`, with a new registry, bus manager, executor and handler in between). With `validateBindingsOnStart`
(default `false`) `RunRegistry.sweep()` ends by calling `probeSession` (up to 4 at a time) for each binding this provider wrote
and deleting the `gone` ones; `SweepReport.bindings` reports `alive`, `gone`, `unknown`, `skipped` (another issuer, or the
context has a run). The orphan sweep runs first, so the sessions of orphaned runs are handled by `abortOrphan` before.

**Hard maximum age: `bindingMaxAgeMs`.** A binding older than this (measured from `createdAt`, the start of the bound session, and never
extended by use) is deleted and released when its context next resumes, exactly like an idle-TTL expiry, and removed by
`sweepBindings`; the turn starts fresh and its `bind` creates a new binding with a new age. It is independent of `bindingTtlMs` and
both may be set. A rebind that names a DIFFERENT session ref resets `createdAt` (the owner is kept), so the age is always the age
of the session the binding names, also when a provider replaces a context's session without deleting the binding first (the
Claude provider does: it binds the new session id of a fresh `query`); binding the same ref again (to refresh `meta`) keeps it.

**Binding GC: `sweepBindings({olderThanMs?})`.** Removes bindings whose `lastUsedAt` is older than `olderThanMs` (default
`bindingTtlMs`; with neither nothing is removed) and whose context has no non-terminal run: no run in this process (live,
parked, adopted or waiting in the lane) AND no `active`, `interrupted` (parked) or unknown-state run record in the store (an
orphan still needs its session for `abortOrphan`). Each removal re-checks inside the context's queue (a resume that touched
it meanwhile wins) and calls `release` for the sessions this provider wrote. Core never schedules it: call it from the
operator's own timer (a store with native TTLs would do this itself).

**`RunStore` additions** (all in `runStoreContractTests`, so a future SQLite or Postgres store is verified by the same suite):
`listBindings()`, `touchBinding(contextId, at, ifRef?)` (sets `lastUsedAt` only, `false` for a missing or other-session
binding, never creates one) and `deleteBinding(contextId, ifRef?)` now returns `boolean` and is a compare-and-delete with
`ifRef`. `ContextBinding.lastUsedAt` is optional and additive (`v` stays 1; `updatedAt` stands in for an old record).

**The retry never overlaps the first call.** The first call's view is dead from the moment it reports `session-not-found`, but its
`provider.run` may still be running. Core waits for it to settle (bounded by `abortTimeoutMs`) before starting the second call, so
one provider session never sees overlapping prompts. If it does not settle in time the turn ends `failed` with the
`session-not-found` code (the binding is still forgotten), no retry is made, and core makes a best-effort bounded
`provider.abort(info, "cancel")` on the abandoned call so the backend stops (a failure is logged, never thrown). A stale or dead view's `bind` is dropped
silently, even with bad arguments (only a live view gets the `TypeError`).

**Process-local versus stored state.** Stored: the binding (session, issuer, owner, tenant, `lastUsedAt`). Process-local on
purpose: the per-context promise chain and the last bind order (`lastBindSeq`, dropped when the context goes idle), the
`attempt` / `retried` / `observable` flags of a turn (a retry never outlives the turn), and the turn order counter. A store
shared by several core instances still needs its own compare-and-set for a bind race between instances; the chain only
orders writes inside one process. A SQL store (#69) should add a compare-and-set on `putBinding` (for example `ifUnchanged:
updatedAt`) so two core processes cannot both pass the owner check and overwrite each other's binding (documented on
`RunStore.putBinding`; not implemented, the in-memory store cannot race across processes).

**Spec problems found.**

1. `bind(ref, meta?)` in the task wording versus `bind(session: {ref, meta?})` in 3.2 and the code: kept as is (`SessionRef`).
2. 3.8 lists `abortOrphan(info)` with a `session?` and `release(session)` but no way to ask "does this session still exist":
   `probeSession` is added (optional).
3. `ContextBinding.owner` was ambiguous (the task owner or the context owner?): it is the caller that created the binding, i.e.
   owns the CONTEXT; every task of a context must come from it. A context id is client-chosen and global, so a stranger who
   learns it can see that it is taken (the rejection is an oracle for "this contextId exists") and can claim an unused or
   garbage-collected one. Per-caller namespacing of context ids is the real fix and is left to the authentication work; spec
   13.1 would have a stranger see "not found", which core cannot do without namespacing.
4. A binding that is expired but still owned by A keeps refusing B until it is removed (resume by A, or `sweepBindings`):
   expiry must not turn a context id into a prize for whoever sends it first.
5. The issuer first contained the package version, so every wrapper deploy would have discarded (and released) all bindings.
   It is now `<id>@<sessionFormat ?? "1">`, compared for equality only, and `release` is never called for a mismatched issuer.
   A session-not-found retry used to be able to overlap the first `provider.run` of the turn; it now waits for it (below).
6. The doc said a failed bind write is logged; a non-JSON `meta` therefore lost the binding silently. `bind` now throws.
7. A late `bind` race between turns was only guarded by `live()`; it was also unsound for provider-held turns (two live views
   of one run), see the bind order above.
8. `DeliveryResult`/`abort` docs never said what the lane does with a rejected resolve: a rejected turn ends like any other
   (`rejected`), releases the lane and lets the queue continue.

**Left for #111 (the wrappers; none of it is in core).** Each wrapper stores its provider reference with
`run.bind({ref, meta})` as soon as the backend tells it (before the first output, so a restart mid-turn can resume) and
resumes from `request.session` instead of its own in-memory map:

- Codex (#100): call `resumeThread(request.session.ref)` (the thread id, which lives on disk) instead of always `startThread`, and
  bind the thread id on the first turn once the thread exists, and map "thread not found" to `session-not-found`. This is the fix for #100 (Codex
  never resumes threads).
- Claude: bind the session id (the `session_id` of the init message), resume with `resume: request.session.ref`; an unknown
  session id is `session-not-found`.
- Copilot: bind `session.sessionId`, `resumeSession(ref)` on the next turn; unknown session is `session-not-found`.
- OpenCode: bind the server-side session id; `session.get` failing with not found is `session-not-found`. Optionally
  `probeSession` through the same call.
- Antigravity: bind `conversation_id` (the SDK supports it, the wrapper ignores it).
- **The wrapper contract.** (1) Call `run.bind` before the first output (an event or artifact), so a restart mid-turn can resume.
  (2) Resume from `request.session`. (3) Report `session-not-found` ONLY while opening the session, before any tool call or side
  effect: core cannot see silent work, and the retry re-runs the whole turn. (4) Return from `run()` right after reporting it
  (core waits for the first call to settle before retrying). (5) `progress()` does not count as output, so the retry publishes
  its progress again. (6) Implement `release` only if dropping a backend session is safe. (7) `probeSession` is optional. (8) Bump
  `ProviderInfo.sessionFormat` only when old refs cannot be resumed.
- Every wrapper: drop its own `contextId -> session` map, implement `release` (drop provider-local state) and, where the backend
  can tell cheaply, `probeSession`; report `session-not-found` before emitting anything.
- The `bind` `meta` is the place for what a resume needs besides the id (a working directory, a model); it is persisted
  with the binding and must be JSON.

### 3.14 Provider wrappers on the contract: Copilot first (#111)

`a2a-copilot` is the first wrapper on the contract and has no `@a2a-js/sdk` dependency (the guard test no longer lists it).
Parity with the executor it replaced is proved by a golden test: the same scripted Copilot sessions (11 scenarios, streaming
and not, chunks and buffered, usage tracking, errors, the BYOK raw tool-call guard) were recorded through the old
`AgentExecutor` and the real `DefaultRequestHandler` (`a2a-copilot/src/__tests__/golden/old-executor.golden.json`) and are
replayed through the provider and the same handler. What a client receives (status sequence and text, artifact names, append
and last-chunk flags, extensions, parts, `x-usage`) is identical, except for the documented, asserted differences: the
redundant `submitted` status after the Task snapshot is not published, the completed status also carries
`urn:a2a-wrapper:usage:v1`, a failed status carries `code`, and `agent_started` follows the opening of the session.

**What core gained for this (all additive; the four wrappers still on the bus-based executor are untouched).**

- `RunObservability` (`events/run-observability.ts`): the per-turn sideband a wrapper used to build around a bus. Its
  `AgentEventEmitter` publishes the same trace artifacts through `run.artifact` (`RunTransport`, sharing
  `agentEventToTrace` with `A2ATransport` so the wire shape cannot drift; `http`, `both` and custom transports are the same
  `resolveTransportWith`). It owns usage accumulation (`recordCall`, `setContextWindow`, `trace.usage` and `context_window`
  under `trackUsage`) and the lifecycle (`start`, then exactly one of `finish`, `error`, `canceled`; the terminal event is
  awaited for at most 2 s). `finish()` returns the `x-usage` metadata and the same totals as a `CoreUsage` (per model), which a
  wrapper hands to `run.complete({ usage, meta })`: `x-usage` stays exactly as it is, and core's own usage key rides along.
- `createResponseStream`: the `response-<uuid>` artifact, chunked (appended chunks and a last-chunk marker carrying the full
  text) or buffered, as `publishStreamingChunk` / `publishLastChunkMarker` / `publishFinalArtifact` publish today.
- `CoreArtifact.extensions`, `corePartsText`, `InteractionsConfig` (the config shape of the interaction policy),
  `createProviderServer` (`createA2AServer` over a provider) and a test harness (`createProviderTestServer`,
  `summarizeEvent`, `summarizeTask`) so a wrapper's tests need no SDK import.

Text deltas deliberately do not use `run.event({type: "text"})`: that renders as an artifact with another name and chunking, which
would change what clients see. A wrapper that wants today's `response` artifacts uses `createResponseStream`.

**How the Copilot provider uses the contract (all wrapper-side).**

- **Session and binding.** `run` opens the session first (live handle, else `resumeSession(request.session.ref)`, else
  `createSession`), calls `run.bind` before anything is published, and only then emits the lifecycle bookend. Order matters:
  a lifecycle or trace artifact is output, and after output core cannot retry a turn with `session-not-found`. The runtime's
  "Session not found" on resume is reported with `run.fail({code: SESSION_NOT_FOUND})` and `run` returns. `release` drops the
  in-process handle (the session stays on disk), `probeSession` asks the runtime's session list, `abortOrphan` is a no-op for a
  runtime this process spawned (it died with it) and resumes-and-aborts for an external `cliUrl`. `session.ttl`
  becomes `bindingMaxAgeMs` (the age of the session, never extended by use, exactly as before), the optional `session.idleTtl`
  becomes `bindingTtlMs`, `ttl <= 0` and `reuseByContext: false` mean no binding.
- **Steering.** `steer` sends `mode: "immediate"` with a `clientTurnId`. Copilot says how it delivered a message with a
  `user.message` event that echoes the id, but only when the message is consumed, which can be long after the send. `steer`
  waits `timeouts.steerAck` (5 s) for it: `steering` is `inserted`; `queued` or `idle`, or no echo yet, is `queued{handle}`.
  When a held message's `user.message` arrives the turn splits there: the segment so far completes and `beginHeldTurn(handle)`
  hands the output to the message's own turn. A late `steering` echo (after the window) means the message went into the
  turn in flight: `run.settleSteer(handle, "inserted")` and no split. A held message never consumed (the session went idle
  first) is settled `dropped`.
- **Abort.** `session.abort()`, then wait (3 s) for `session.idle`: `confirmed` or `unconfirmed`, always `reusable`; a rejected
  abort makes core discard (and `release`) the session. `cancel` also clears Copilot's native queue and drops held handles;
  `interrupt` keeps it.
- **Interactions.** The session's `onPermissionRequest` asks through the running turn (`run.ask`), `onUserInputRequest`
  (`ask_user`) is registered only under `mode: "ask"`, and the pre-tool hook stops answering `allow` under `ask` (it would
  bypass the handler). `unavailable` is read by its `code`: `policy-auto` (nobody is asked, no rule answered) approves
  (`approveAll`, as it always did) only while the wrapper itself is `auto`; every other code denies, and the model is told a
  fixed message rather than core's reason text. Under `ask` only an explicit allow approves. The prompt timer is paused while a person decides.

**Settled after review (round 2).** `run.settleSteer(handle, "inserted" | "dropped")` (3.4) lets a provider that had to answer a
steer `queued` say later that Copilot folded the message into the running turn (record `done`, handle released, no turn);
`bindingMaxAgeMs` (3.13) keeps `session.ttl` a hard maximum age (a Copilot context is resumed only while its session is younger
than `ttl`), with the idle expiry (`bindingTtlMs`) left as a separate optional `session.idleTtl`; `unavailable` carries a typed
`code` (3.3), so the provider's own mode no longer decides approve versus deny (problems 2 and 4 below are resolved by these).
Still open: 1 (stated plainly below), 3, 5, 6 and 7 as known limitations.

**Spec problems found.**

1. Output counts: the contract says `session-not-found` is only retried before the turn publishes anything, but it never says
   that trace and lifecycle artifacts are output: `run.artifact` marks the turn observable, and an observable turn cannot be
   retried. A wrapper that emits `agent_started` (or any `trace.*` artifact) before it has opened the resumed session silently
   loses the retry, which is why the Copilot provider publishes `agent_started` AFTER the session opens.
2. `SteerOutcome` is returned before the truth is known. Copilot reports `steering` / `queued` only when it consumes the message.
   The contract has no "accepted, outcome pending"; the provider answers `queued{handle}` and turns the late echo into a turn
   boundary, so a message that was in fact folded into the running turn is reported as held and its output is attributed to a
   new turn. A `run.settleSteer(handle, "inserted")` (core drops the handle and records the message `done`) would be exact.
3. (Known limitation.) `interrupt` with a provider-held message outstanding: the contract says keep the native queue, but the held message then
   starts inside the NEXT turn's run, whose view does not know the handle. Output is attributed to the held turn from the
   moment its `user.message` arrives. Documented limitation.
4. `interaction` `unavailable` does not say why. In `auto` mode it means "nobody is asked", under `ask` it can mean "malformed";
   the provider has to know the policy itself (it reads its own config) to choose approve versus deny. A typed reason would let
   core own the distinction.
5. A non-last turn's `complete({meta})` publishes `meta` (so `x-usage`) on a `working` status. A task with a held turn therefore
   has `x-usage` on a non-terminal status, which "only the completed status carries x-usage" did not allow. Known limitation:
   clients that read usage only from terminal metadata should read it from the completed status.
6. Persisting bindings needs a durable `RunStore`, which only exists as a test double (#69). Until it exists a restart loses
   every binding with the default in-memory store. The wrapper exposes `createA2AServer(config, { runStore })` and says so
   prominently in its README.
7. (Known limitation.) In chunk mode the stored task holds the response twice (the chunks, then the last-chunk marker with the full text, both
   appended). That is today's behaviour and is kept for parity; fixing it is an A2A-visible change.

### 3.15 Claude on the contract (#111)

`a2a-claude` is the second wrapper on the contract and has no `@a2a-js/sdk` dependency (the guard test lists it no more). Parity
with the executor it replaced is proved the same way as for Copilot: 24 scripted Claude sessions (the messages a `query()` yields:
buffered and chunked responses, every trace event kind, structured output, error results, a refusal, held-open background rounds
and the three ways a held task ends, rate limits, prompt timeout, a failing iterator) were recorded through the old
`AgentExecutor` and the real `DefaultRequestHandler` (`a2a-claude/src/__tests__/golden/old-executor.golden.json`) and are replayed
through `ClaudeProvider`: 46 streams and tasks, identical except the asserted differences (the redundant `submitted` status; the
core usage key on the completed status; `code` / `retryable` on a failed status; `x-usage` cost, below). What the live CLI does
(measured with the real binary, not read from the types) is what the provider is built on.

**What core gained for this** (all additive, listed in the changeset): a rebind to a DIFFERENT session ref resets
`ContextBinding.createdAt` (3.13; the one behaviour change, with its test updated), `CoreError.meta` (rendered on the failed status;
Claude keeps the rate limit's reset details with it), `createResponseStream({ id })` (the `response-<taskId>-<round>` ids of held-open
rounds are part of the wrapper's contract).

**How the Claude provider uses the contract (all wrapper-side).**

- **One streaming-input `query()` per turn** (not per context): the prompt is the first message of an input queue the turn owns. The
  query is created per `run` and resumed with `options.resume = request.session.ref`; the process ends with the turn. The `init`
  message gives the session id: `run.bind({ ref })` happens there, before any output (the lifecycle event, which is output, follows).
  The CLI re-emits `init` on every SDK turn of a query; a repeat of the bound id binds nothing. `session.ttl` is `bindingMaxAgeMs`
  (`<= 0`, the default, means no limit, as before), `session.idleTtl` is `bindingTtlMs`, `reuseByContext: false` never binds, and the
  old idle sweep (`cleanupInterval`) is a timer in `createA2AServer` calling `sweepBindings({ olderThanMs: ttl })`.
- **Session not found.** Resuming an unknown id ends with an `error_during_execution` result carrying "No conversation found with session
  ID" and no `init` (and the iterator then throws the same text). Both become `run.fail({ code: SESSION_NOT_FOUND })` before anything
  was published, so core's single retry runs the turn fresh. A retry publishes `Processing request...` again (progress is not output).
- **Steering.** `steer` pushes `{ uuid, priority: "next" }` into the input queue. Measured: `now` interrupts the running turn (it ends
  with a result and `terminal_reason: aborted_tools`) and runs the message as the next turn, so it is an interrupt, which core's
  `interrupt` delivery already is; `next` (and no priority) folds the message into the running turn at the next tool boundary;
  `later` runs it as its own turn after the current one. The CLI says what became of a message with `command_lifecycle` frames
  (`queued`, `started`, `completed`, `cancelled`, carrying the uuid) and lists folded messages in the result's `user_message_uuids`.
  `started` before the running turn's result, or the uuid in that result, is `inserted`. No word within `timeouts.steerAck` (or the
  turn ended first) is `queued{handle}`: the message then starts its own turn (`started` after the result, `beginHeldTurn`; the first
  turn is completed non-terminally where it ends) or is folded late (`settleSteer("inserted")`). A queued message that never starts is
  dropped when the CLI reports nothing queued (`queued_turn_count: 0`) after `steerAck`.
- **Abort.** `cancel`/`shutdown`: `abortController.abort()` and `query.interrupt()` (the process dies, the transcript stays; the next
  message resumes it). `interrupt`: `query.interrupt()` first (a clean transcript), then the process is ended; the interrupting message
  resumes the session in a new query. The CLI's queue lives in the process, so a steered message it still held is `dropped` (documented
  limitation, the Copilot problem 3 in another shape). The outcome is always `reusable`, `confirmed` when the iterator ended within 3 s.
- **Interactions.** `canUseTool` is installed only when something can answer (`interactions.mode: "ask"` or `autoAnswer` rules), so the
  default changes nothing (the CLI's headless handling decides, `permissionMode: "default"` stays rejected). `AskUserQuestion` is the
  same callback: it becomes a `question` interaction (one core question per SDK question) and is answered with
  `updatedInput.answers` by question text. The SDK's per-request `signal` is `AskOptions.signal` (measured: `interrupt()` aborts it), so
  a stuck request is withdrawn, not leaked. Only an explicit allow approves; every `unavailable` code denies (in `auto` with rules
  the unmatched request is denied, as the headless CLI would). "Always allow" is not offered (it writes the project's settings files).
  The prompt timer pauses while a person decides.
- **Usage.** Measured: `usage` is per turn (main loop only); `total_cost_usd` and `modelUsage` are cumulative for the session across
  turns of a query and across resumes. The old executor stored the running total as the cost of every result, so `x-usage` overstated
  later tasks and double counted held-open rounds. The provider reports the cost of the turn: `usageDelta` over two cumulative readings
  of the same `series` (the Claude session id), with the last reading kept in the binding's `meta` (`usageTotals`), so it is exact after
  a restart; a total that drops (`/clear`) starts a new epoch. Core's usage key carries the per-model breakdown of the turn.

**Spec problems found.**

1. `CoreTaskRun.bind` writes the binding's `meta` only at the call, but a provider often learns what belongs in it later (the usage
   total after the turn). Rebinding the SAME ref to refresh `meta` works and keeps `createdAt`, which is what made the "different ref
   resets the age" rule (3.13) possible without breaking it; it should be written down as the contract for updating `meta`.
2. A provider cannot tell that a bind was dropped (stale or canceled view), so it cannot know its usage total was not stored. Harmless
   here (the next turn computes a larger difference for one turn), but a `bind` that reports whether it was stored would make it exact.
3. Provider-owned usage that spans several results of one turn (held-open rounds) is summed by the accumulator; there is no way to
   hand core a `cumulative` reading and let it apply `usageDelta` against the previous turn's reading of the same series. The wrapper
   computes the delta itself and sends `delta` scope, so core's `usageDelta` is exercised only by the wrapper. If more wrappers need it,
   `complete({ usage })` with `scope: "cumulative"` plus a stored previous reading should be core's.
4. `run.progress(text, meta)` is the only way to publish a non-terminal status with metadata, and a held-open task needs exactly that
   (`backgroundTasks`); it works, but the text and the metadata are one status, so a round's response text appears in the status
   message and as the artifact (today's behaviour, kept).
5. `CoreError` had no field for machine-readable details; `meta` was added (a rate limit's reset time and type are what orchestrators
   schedule retries from).
6. A turn of a task that is not its first (a queued message, an interrupt) starts a new `run()` for the same `taskId` and `runId`: a
   wrapper that names artifacts after the task (Claude's `response-<taskId>-<round>`) collides with the earlier turn's ids and the later
   answer REPLACES the earlier one in the stored task. `CoreRequest` has no turn ordinal; the provider counts them per task. A
   `turnIndex` on the request would remove the counter.

Problems 2, 3, 4 and 6 above, and the dropped steer at an interrupt, are resolved in 3.16.

### 3.16 Core follow-ups from the Copilot and Claude migrations (#124)

Everything below is additive (a wrapper that does not call it behaves as before) and closes the contract gaps 3.14 and 3.15 listed
before the OpenCode, Codex and Antigravity migrations.

**Cumulative usage readings (3.15 problem 3).** `run.reportUsage(reading): Promise<CoreUsage>` takes a `cumulative` reading (with
`series`, optionally `byModel`) and returns the DELTA of this turn: core applies `usageDelta` (3.7: per series and per model, a
counter that went down starts a new epoch, never negative) against the previous reading of the same series and stores the new
reading as the baseline. `RunObservability.recordCumulative(call, reading)` wraps it for the usual wrapper: it records the call
with the delta as its cost, accumulates the per-model deltas, and `finish()` / the new `usageNow()` (the same summary without
closing the lifecycle) put them in `x-usage` and in the core usage key (`urn:a2a-wrapper:usage:v1`).

- **Where the baseline lives.** `ContextBinding.usageBaseline` (a `CoreUsage`, no `contextWindow`), written through the `RunStore`
  with the binding, so a new registry over the same store (a restart) continues exactly. It is gone when the binding is deleted
  and reset when a DIFFERENT session ref is bound (a new session is a new total); rebinding the same ref keeps it. Readings of one
  context are applied inside the context's serial queue (the same one binds use) and turns of a context are serialized by the lane,
  so two turns never interleave.
- **A series change** (the baseline is for another series) is a new total: the reading is the delta, as `usageDelta` always said.
- **A lost baseline** (no previous reading: the process died between the session being bound and its first reading, the binding
  was replaced or deleted, no session is bound) cannot be told apart from a resumed total that includes turns this process never
  saw. Decision: core reports the whole reading ONLY when the provider says `CoreUsage.fresh` (the total started inside this turn,
  a brand-new provider session); otherwise the delta is EMPTY (no tokens, no cost, `cost: null` in `x-usage`) and the reading is
  still stored, so the next turn is exact. Never negative and never over-reported; the price is that one turn's usage is not claimed.
- **Degenerate readings never become the baseline.** A crash or a startup error may report zeroed or missing totals. Per value (a
  counter, the cost, a model's entry): a value that is absent, `null`, not finite, or `0` while the baseline's value is greater than 0
  is IGNORED and the baseline's value stands (a model the reading does not list keeps its entry). A reading with no value left reports
  nothing and does not replace the baseline, so the next real reading is the plain difference. A drop to a smaller NON-ZERO value is
  not degenerate: it is a genuine reset (`/clear`) and starts a new epoch on its first real reading (a rounding-level decrease
  restarts the epoch too, harmless for monotonic totals); a reset that restarts from exactly zero is only seen once a reading is
  below the old total. A degenerate reading with no baseline stores nothing either.
- **A view that is not live** (canceled, interrupted) reports nothing and stores nothing (its spend is part of the next reading and
  lands on the next turn); a stale reading could otherwise look like a decrease and over-report. Consequence: the session total stays
  correct, but the spend of an interrupted, canceled or stale turn is attributed to the NEXT turn of the session, so per-task cost
  moves between neighbouring tasks.
- A `delta` reading is returned as it is. A provider with no binding at all (it never calls `bind`) gets no baseline from core:
  `fresh` readings are whole, anything else is not claimed, so such a provider diffs its own readings with `usageDelta` (the pure
  function) and reports `delta`.

**Compatibility.** `CoreRequest.turn` is a new REQUIRED field and `run.bind` returns a promise: a hand-built `CoreRequest` or a fake
`CoreTaskRun` in a wrapper's test harness must add `turn` (and `bind` returning `Promise<"stored" | "dropped">`, plus `reportUsage`,
`status` and the `"requeue"` outcome). In this repository the only hand-built requests were core's test harness builders, which spread
the ids core passes (so `turn` arrives with them); no wrapper harness needed a change. Source compatibility for `void`-style callers of
`bind` is unchanged.

**Turn ordinal.** `CoreRequest.turn` is the 1-based ordinal of the turn within its TASK (a queued message, an interrupt and a held
message each start the next one; the `session-not-found` retry of a turn keeps its ordinal). It is persisted as
`RunRecord.turnCount`, so it keeps counting after a restart (an adopted run continues from the record, a task that continues under a
new run continues from the unfinished record of the earlier one). `turnArtifactId(kind, taskId, turn)` builds
`<kind>-<taskId>-<turn>`. This replaces the provider's process-local counter (3.15 problem 6).

**`settleSteer(handle, "requeue")` (3.15, Claude's dropped steers).** A provider that holds a steer and learns it cannot deliver it
(an `interrupt` ends the backend process and its native queue with it) hands it to core. The held record becomes `queued` with holder
`core`, and the task runs it through the provider's `run` like any queued message; it survives a restart as a core-queued record.
Idempotent by handle and message id, ignored for a handle that is not held, silent after a cancel.

**Order after an interrupt.** The queue has a front block: `[the interrupting message(s), requeued steers in the order the provider
requeued them (arrival order), then everything that was core-queued, in arrival order]`. The interrupting message runs NEXT (design
doc 3.4: it becomes the next turn; before this change it was appended behind earlier queued messages, which is what #109 did). A steer
the provider held was sent before the interrupt, so it follows the interrupting message and precedes messages queued earlier or later
by `queue`. The persisted `QueuedMessageRecord.position` values are the same order (the block is renumbered just below the first
entry outside it; positions are only an ordering key and may be zero or negative), so a restart replays the live order.

**`bind` result (3.15 problem 2).** `run.bind(...)` returns `Promise<"stored" | "dropped">` (a stale or canceled view, a bind from a
turn older than the one that bound last, a context another caller owns, a store failure; never rejects). A live view still throws a
`TypeError` for an unstorable argument; a view that is not live never throws. A caller that ignores the promise keeps working.

**Metadata without text (3.15 problem 4).** `run.status({ meta })` publishes a non-terminal `working` status carrying the metadata and
NO text, so a provider holding a task open can attach `backgroundTasks` or usage without the round's text appearing a second time
(`progress(text, meta)` is one status, so text and metadata arrive together). Nothing is published for an empty `meta`.

**`CoreRequest.interactionMode` (Copilot).** The mode of the runtime's interaction policy, reported on every request when the
interaction handler declares one, so a provider decides from the runtime and not from its own configuration whether a person can be
asked (Copilot's pre-tool hook approves a call itself only when nobody could answer).

**Adoption.** Claude removes its own `usageDelta` and `usageTotals` bookkeeping (the cumulative reading is core's, with `fresh` for
a session the turn created), records usage from `error_*` results (the failed status carries `x-usage` and the core usage key), takes
artifact ids from `CoreRequest.turn`, and requeues the steers the CLI still held at an interrupt. Copilot derives its hook mode from
`CoreRequest.interactionMode`. Still open: held-open rounds keep `progress(text, meta)` in the Claude wrapper (switching to
`run.status` would change what a client sees: the round text would no longer be a status message), and a pending permission after
a restart still fails as `server restarted` (no defer hook).

### 3.17 OpenCode on the contract (#111)

`a2a-opencode` is the third wrapper on the contract and has no `@a2a-js/sdk` dependency (the guard test lists it no more). Parity with the
executor it replaced is proved as for Copilot and Claude: 22 scripted OpenCode sessions (buffered and chunked responses, intermediate text
flushed as status, tool traces with sensitive and oversized data, repeated and incomplete usage messages, session errors, failing prompts,
the transcript fallback, a prompt timeout, disabled events, the system prompt) were recorded through the old `AgentExecutor` and the real
`DefaultRequestHandler` (`a2a-opencode/src/__tests__/golden/old-executor.golden.json`) and are replayed through `OpenCodeProvider` on a 1.x
and on a 2.x fake server: 88 comparisons, identical except the asserted differences (the redundant `submitted` status; `x-usage` and core's usage
key on the completed status, which the old executor never published although its `agent_finished` event carried the same summary; `code` on a
failed status). What a real 2.3.2 server does (measured, not read from the types) is what the provider is built on. Nothing was added to core.

**How the OpenCode provider uses the contract (all wrapper-side).**

- **Session and binding.** `run` opens the context's server session first (`request.session.ref` checked with `GET`, else a new one with the
  title, model, agent and permission ruleset it always had), calls `run.bind` before anything is published, and only then emits the
  lifecycle bookend. A `GET` that answers not found (1.x a 404 `NotFoundError`, 2.x a tagged `SessionNotFoundError`, both mapped to a 404 by
  the backend) is reported with `run.fail({code: SESSION_NOT_FOUND})` and `run` returns; any other failure is an ordinary failure and keeps
  the binding. The bind `meta` carries what a resume needs: the API generation, the model and whether the system prompt was sent (a resumed
  session is not given it twice; a session that never got it gets it once, with a rebind of the same ref that refreshes the meta).
  `release` only forgets: the wrapper has never deleted server sessions (the history is the user's), so there is nothing to undo.
  `probeSession` is the same `GET` (`gone` only for a session the server says it does not know).
- **`session.ttl` stays an idle expiry.** The Copilot and Claude `ttl` was a maximum age and became `bindingMaxAgeMs`; OpenCode's was always idle
  based (each message renewed the context), so it becomes `bindingTtlMs`, and the new optional `session.maxAge` is the hard maximum. Mapping
  it like the others would have reset every context that is in use after an hour. `ttl <= 0` means no expiry, the sweep timer is the wrapper's
  (`sweepBindings({olderThanMs: ttl})`), as in Claude.
- **Abort and orphans.** `abort` stops the session's work (1.x `POST /session/:id/abort`, 2.x `POST /api/session/:id/interrupt?resume=false`: a
  parked inbox item must not start by itself) and is `confirmed` only when the server says the session is idle (the stream's idle event, else the
  server's own status, within 3 s), always `reusable`; a rejected abort makes core discard the binding. `abortOrphan` is real here, unlike
  Copilot and Claude: the session outlives the wrapper process and keeps working, so it is `GET`, abort, empty the inbox on a cancel (all
  pending items of the session: after a restart no handles are known), poll idle: `confirmed`, or `confirmed` / `discard` for a session the server
  does not have, or `unconfirmed` (no reference, or the server never went idle), or the failed outcome when the server refuses. Measured
  with a wrapper killed mid-run: the server session kept running until the restarted wrapper's start-up sweep stopped it.
- **Steering exists only where the server has it.** A 2.x server admits every prompt to a durable per-session inbox and delivers an item at a step
  boundary (`steer`) or when the work in hand is done (`queue`). `steer` sends the message with `delivery: "steer"` and waits
  `timeouts.steerAck` for `session.inbox.delivered` of its inbox id: delivered is `inserted`; otherwise `queued{handle: inbox id}`. The stream then
  settles it: delivered while the execution runs is `settleSteer(handle, "inserted")` (measured: the step that follows is part of the same
  execution and its text is the same turn's output); delivered after the execution ended is a held turn (`beginHeldTurn`; the server announces
  `session.execution.started` BEFORE the delivery that started it, so the turn tracks "an execution started after the idle"); never delivered is
  cancelled in the inbox and handed back with `settleSteer(handle, "requeue")`. On an `interrupt` the held items are requeued the same way (not
  "kept": left in the inbox they could only run inside the NEXT turn's execution, after its own prompt, where the held turn's output cannot be
  attributed; measured), on a `cancel` they are cancelled and dropped. OpenCode `queue` delivery is not used: a core `queue` message is core's
  (the next `run`); on a 1.x server `provider.steer` is absent (a getter that answers `undefined` once the backend is known to be 1.x, which core
  reads at call time) and core's fallback says so.
- **Interactions.** `permission.asked` and `question.asked` (2.x `form.created`) become `permission` and `question` interactions through `run.ask`,
  decided by the runtime's mode (`CoreRequest.interactionMode`), not by the wrapper's own config. Under `auto` an `unavailable` with code
  `policy-auto` / `interactions-disabled` is answered as the wrapper always did (`always`, first option of every question; the two feature flags
  can turn them into rejects); under `ask` only an explicit allow approves. Options are allow once / always allow (OpenCode saves the proposed
  patterns as project rules, so the label says what) / deny with feedback. The server rejects every other pending request of a session when one is
  rejected; the ask of a request answered elsewhere is withdrawn from the `replied` event (`AskOptions.signal`). The session ruleset under `ask`
  keeps reads allowed and asks for what the old allow-all list covered (edit, bash/shell, task, mcp, fetch). The prompt timer pauses while a person
  decides. No `handle` is passed and there is no `reattach`: after a restart the pending request is stopped by `abortOrphan`.
- **Usage.** OpenCode reports a completed assistant message per LLM call with its own tokens and cost (never a running total), so every call is
  `recordCall` and no cumulative bookkeeping or baseline is needed. `agent_finished` keeps `usage: null` when no call was observed (it is the
  `finish({usage})` override), `x-usage` is the same summary.

**Spec problems found.**

1. `OrphanInfo` has no provider-held handles, so an orphaned provider-held message can only be handled by flushing the whole inbox of the session. That
   is right for a wrapper that owns its sessions, wrong for one that shares them with a person.
2. `steer` is a handler whose presence is capability, but the capability of this provider depends on the server generation, known only after
   `initialize`. A getter works because core reads `provider.steer` per call; the contract should say a handler may be absent until `initialize`
   has resolved (or the registry should ask once after `initialize`).
3. "Interrupt keeps the provider's native queue" cannot hold for a durable queue that is shared with the next turn's prompt: the held item's output
   lands in the next turn. `settleSteer(handle, "requeue")` (3.16) is the right tool and should be the stated rule for any queue the next prompt
   would also drain.
4. The runtime's `ttl` family is described as a maximum age (3.13), but a provider's pre-migration `ttl` may be an idle expiry; the contract should
   say that mapping `session.ttl` is the wrapper's decision and keep both `bindingTtlMs` and `bindingMaxAgeMs` first class.
5. `reject` of one OpenCode permission rejects the session's other pending permissions: the contract's one-interaction-at-a-time model hides it from
   the client; the option description says so.

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
  `queue` by default, `steer`, or `interrupt`), on a private bus, and answered with one Message carrying the `DeliveryResult`
  (3.12). Core never lets the SDK start a second provider call for a live run, and never lets the second `execute()` publish on
  the shared bus.
- **`auth-required` (S1 re-run on SDK 1.3, section 3.10.1).** The SDK keeps the bus alive and the stream OPEN at
  `auth-required` (it expects the executor to resume on the same bus). Core does not rely on that: it closes the attachment
  at the park exactly as at `input-required`, and the reply (the "done" message after the out-of-band sign-in) is a new
  request on the same task whose `execute()` resolves the ask and continues the SAME run.
- **Bus lifetime.** Core owns it through `ExecutionEventBusManager.settleByTaskId` (see 3.5), including the orphan
  case: a `tasks/cancel` with no bus never calls the executor in SDK 1.3.

| Core | A2A |
|---|---|
| `ask` (parks the run) | task state `input-required`; status message = text rendering; data part with the interaction (extension `urn:a2a-wrapper:interaction:v1`) |
| `auth` interaction | task state `auth-required`; message carries `url`/`userCode`; no credential collection |
| reply `selected` / `answered` / `submitted` | a message on the same task: structured data part `{interactionId, ...}` first, text fallback second ("approve", option label, number) |
| client that did not activate the extension | text rendering only, options numbered, with the reply code ("Reply with `1 K7`"); core still parses the text reply, and selects an `allow_*` option only when the code is present |
| duplicate or late reply | idempotent on (task, interaction id); unknown or answered ids are ignored with no side effect |
| `expired` | task `failed` with the reason (`onTimeout: "fail"`, default), or the provider sees the denial and the run goes on (`"deny"`) |
| cancel while pending | `outcome: "canceled"` delivered to the provider, then the normal cancel path |
| `CoreCaller` | from the A2A call context; permission replies require the task owner or a configured approver |
| core state with no v1 equivalent, or `unknown` | task state `working` (never `TASK_STATE_UNSPECIFIED`), the original string in `urn:a2a-wrapper:core-state:v1` status metadata; restored on read when the wire state is `working` (or the old `UNSPECIFIED`) and the carried state is one core does not model |
| `reject(reason)` | task state `rejected` |
| `interrupt` delivery | the task stays `working` and the message is the next turn; no `canceled`. With no content: `input-required` with `interrupted: true` until the next message |
| message to a running task | a private bus and one agent Message with the `DeliveryResult` (`urn:a2a-wrapper:delivery-result:v1`); a parked task re-asserts its status with the result on the status message |

### 4.1 Wire keys

Every key core writes is versioned and listed in one constant, `WIRE_EXTENSIONS`; `agentExtensionDeclarations()` turns
it into optional (`required: false`) agent card `extensions` entries (not yet wired into the server factory).

| Key | Where | Meaning |
|---|---|---|
| `urn:a2a-wrapper:interaction:v1` | extension, status message | structured permission/question/form/auth data parts |
| `urn:a2a-wrapper:delivery:v1` | message metadata | `queue` / `steer` / `interrupt` |
| `urn:a2a-wrapper:delivery-result:v1` | message metadata | the `DeliveryResult` core answers with (3.12) |
| `urn:a2a-wrapper:usage:v1` | event metadata | usage, including `series` and `byModel` |
| `urn:a2a-wrapper:core-state:v1` | status metadata | original state when it has no v1 equivalent |
| `urn:a2a-wrapper:file-uri:v1` | part metadata | source uri of a file part that also carries bytes |
| `urn:a2a-wrapper:unknown-part:v1` | part metadata | marks a data part that carries an unmodeled part unchanged |

The old unversioned keys (`urn:a2a-wrapper:delivery`, `usage`, `core-state`, `file-uri`, `unknown-part`) are still read
inbound and never written.

**Steering alias (best effort).** The inbound alias `https://a2a-protocol.org/extensions/steering/v1/control` is
accepted for `steer` / `interrupt` / `queue`. The A2A steering proposal (#2125) is not final, so the shape is an
assumption: a message metadata entry under that URI whose value is the string, or an object with one of `action`,
`mode`, `type`, `delivery` holding it. The core key wins when both are present; unrecognised values are ignored.

## 5. Per-provider fit (what lives in each provider)

| Provider | Native fit | Provider-local work |
|---|---|---|
| Claude (done, 3.15) | `canUseTool` to `ask`; `AskUserQuestion` to `questions`; streaming input with `priority: next` to `steer`; `interrupt()` to `abort` (`session: reusable`) | input queue instead of one-shot; deny `message` from `feedback`; session resume via `bind` and `resume`; usage as differences of the cumulative total; `defer` hook for restart durability is not done |
| Copilot | `onPermissionRequest` or pending-RPC to `ask`; `mode: immediate` to `steer` (read the `delivery` event for the outcome); `session.abort()` to `abort` | stop using `approveAll`; wire `ask_user`/elicitation; pass `handle` (requestId) and implement `reattach` via `continuePendingWork` |
| Codex | exec SDK: abort + `resumeThread` only | to get permissions and steering the provider must move to `codex app-server` (experimental): `requestApproval` to `ask`, `turn/steer` to `steer`; call `resumeThread`; fix `cancelTask` using `contextId` as the task id |
| OpenCode | `permission.asked` / `question.asked` / `form.created` to `ask`; v2 `delivery` to `steer`; `interrupt` to `abort` | stop auto-replying `always`; v1/v2 split behind one handler; `handle` plus re-list for `reattach`; note a reject cancels every pending permission in that session |
| Antigravity | SDK has `ask_user` and hooks; abort via `halt_request` | bridge work: expose `ask_user` and an interaction hook; `steer` as cancel + re-run on the same session; fix queued-turn-after-cancel and double `canceled`; persist `conversation_id` via `bind` |

## 6. What this changes versus the first design doc

Revision after the #106 review:

- Turn semantics: a task is a sequence of turns; `queue` and `interrupt` run as the next turn of the same task, which
  goes terminal only when nothing is left. `SteerOutcome.held` becomes `queued`; `DeliveryResult` names task, message and
  holder; `abort` takes a reason; `CoreRequest` gains `turnId`.
- Providers cannot name a state: `status(state)` becomes `progress`, and `reject` is added; unknown states are classified
  with `classifyState` and never put on the wire as `UNSPECIFIED`.
- Records carry a header (version, owner, tenant), are JSON-safe, and round-trip through `encodeRecord` / `decodeRecord`.
- Interactions are a union with a normalizing constructor; withdrawal, per-task FIFO, reply codes, `dismissed`,
  `amendment`, `freeText`; secret answers have a redaction representation.
- Usage has a `series`, a per-model breakdown and a reset-safe `usageDelta`.
- Wire keys are versioned and declared.


- `abortBackend` plus `onAbortFailed` becomes `abort` returning `AbortOutcome`.
- `run.ask` replaces per-wrapper permission handlers, and gains `handle`, expiry, authorization and idempotency.
- `inbox` as an async iterable is dropped: steering is a handler with a typed outcome, and the default is core's.
- New: `bind`/`ContextBinding`, `PendingInteraction`, `RunHandle` attachments, `CoreUsage.scope`, `CoreCaller` in replies.

## 7. Evidence-driven findings to track as issues

- A2A SDK is at 1.0.0 with the concurrent-`execute()` hazard and no bus retention; upstream 1.2 adds
  `keepBusAliveStates`, `settleByTaskId` and an atomic cancel. 1.3 is now the floor (core's peer dependency).
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
   (a `steer` request is `queued` by core; permission requests cannot arise because exec mode cannot prompt).
6. **Auto-answer policy:** see 3.9. Default preserves today's per-wrapper behaviour; asking a client is opt-in.

Spikes before implementation:

- **S1.** DONE on SDK 1.3 (#108): section 3.10.1 and `__tests__/a2a/s1-interrupted-states.test.ts`. Park at
  `input-required` and `auth-required`, blocking and streaming, the reply as a second `execute()`, the Task snapshot rule.
  `settleByTaskId` and the cancel-with-no-bus path are covered by the #107 end-to-end tests (3.5, 3.10).
- **S2 (SDK).** DONE on SDK 1.3 (#109): a second request to a working task, section 3.12 and
  `__tests__/a2a/s2-message-to-working-task.test.ts`. (The provider spikes below keep their numbers.)
- **S2.** Real Copilot: `onPermissionRequest` left pending, answered later by RPC; measure `immediate` steering and the
  `delivery` event.
- **S3.** Real Claude: `canUseTool` pending across an A2A round trip; `defer` hook behaviour on resume.
- **S4.** OpenCode 2: `delivery` steer vs queue; re-list of pending asks after a wrapper restart.
- **S5.** Codex `app-server` approval and `turn/steer` round trip (only if decision 5 is yes).
