# Core data model and provider contract

Status: proposal, for discussion. Companion to [core-owned-a2a-boundary.md](core-owned-a2a-boundary.md), which states
the principles. This document is the data model, designed from evidence. Evidence lives in
[research/](research/) (one report per area, every claim labelled verified or inferred, with sources).

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
be dropped. The cancel/abort side of the runtime is implemented (issue #107, section 3.10); the steering and
interaction runtimes that drive `beginHeldTurn` / `dropHeld` / `ask` are #109 and #108.

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
(including after a restart) core passes the stored `session` back in `CoreRequest`.

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
`presentedInteraction`, `nextQueuedInteraction`. The queueing runtime is issue #108.

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
re-publishes the prompt with a hint ("Reply with `1 K7M2`", issue #108). Claude's global `AskUserQuestion` `response`
maps to `declined` with `feedback`.

**Kind spelling.** `normalizeInteraction` refuses a `kind` that equals a known kind after trim and case-folding
("Permission", " confirm"): it is a typo, and treating it as an unknown kind would skip the shape checks. Subject
`detail` and option `meta` must be JSON-safe like `meta`.

**Free-form answers.** When an interaction has questions, "no", "n", "deny" and "decline" are answers like any other;
declining a question is the structured `declined`, never a word.

**Expiry defaults** (core fills `expiresAt` from policy when the provider gives none; `interactions.timeoutMs` in 3.9
overrides): permission, confirm, question and form 10 minutes; auth 30 minutes (a person signs in on another device).
An expired interaction resolves `expired`.

**Secrets.** Secret questions are allowed in v1 by owner decision, which deviates from MCP form-mode elicitation
("MUST NOT request secrets"). The `secret` flag keeps redaction possible: `redactSecretAnswers` drops the text of
secret answers before they are stored and returns the removed paths, which the record keeps in `result.redacted`.

### 3.4 Steering and messages

A task is a sequence of turns (3.2). A message to a task that is running runs as the next turn of that same task, by
the caller's `delivery`:

- `queue` (default): next turn of the task, after the running turn ends.
- `steer`: folded into the running turn.
- `interrupt`: stop the running turn, then run the message as the next turn of the task.

The task stays `working` through all three: an interrupt does **not** end the task with `canceled`. This follows the
open A2A steering proposal (a2aproject #2125), which keeps the task working on a steer and goes `input-required` with
`interrupted: true` when a turn is stopped waiting for direction; the proposal is not final and the inbound alias in
section 4 is best effort. The task goes terminal only when the last turn ends and nothing is queued for it. A message
with only a `contextId` starts a new task in the context lane (3.2). Precisely: the task goes terminal only when the
last turn ends AND no core-queued message AND no provider-held handle remains (3.2).

**Not the #2125 `interrupt`.** In the A2A proposal `interrupt` means "stop and wait": the task goes `input-required` with
`interrupted: true`. Core's `interrupt` aborts the turn and runs the message as the next turn. The inbound alias exists
for best-effort compatibility only and is never advertised in the agent card.

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
`run.beginHeldTurn(handle)` or `run.dropHeld(handle)` (3.2). A `SteerOutcome` with a state this core version does not know
is reported as `rejected` / `unsupported` even though the provider may have accepted the message, so a caller must not
blindly resend: resend only with the same `idempotencyKey` or `messageId`. A provider
without `steer` gets the core default: core holds the message in its own per-context lane (`queued`,
`holder: "core"`) and runs it as the next turn; the response says so, and core never silently changes the caller's
choice.

`interrupt` is composed by core from `abort(run, "interrupt")` plus the message as the next turn of the same task, so it
works for every provider that implements `abort` (all five) and needs no new handler. Its result is
`{ state: "interrupted" }`. The stopped turn ends without a terminal task state.

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
  contextId: string;
  session?: { ref: string; meta?: JsonObject; issuer: string };   // issuer: opaque provider id + version
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
  holder: "provider" | "core"; position?: number; handle?: string;
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
`reattach?(records)` so it can resume waiting (Copilot `continuePendingWork`, OpenCode re-list). The rest become
`expired` and the task is failed with a precise reason instead of hanging.

### 3.7 Static provider info and usage

```ts
interface ProviderInfo {                                 // descriptive only; core never branches on it
  id: string; displayName: string; version?: string;
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
- **A second `execute()` on a live task never starts a provider call.** The reply-to-interaction case is routed to the
  interactions runtime (`InteractionRuntime.handleReply`, #108); otherwise the message is queued as the next turn (default
  delivery, D4) with a `QueuedMessageRecord`, claimed `queued -> running` by compare-and-set before its turn runs.
- **Pending interactions** register `PendingHook`s on the handle; cancel (and expiry) settle them `canceled` inside the
  claim. `ask` answers `unavailable` until the interactions runtime exists. `RunRegistry.expire` is the third claim.
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
- **`RunStore`** (`InMemoryRunStore`) keeps `RunRecord`, `ContextBinding` and `QueuedMessageRecord`, stores the ENCODED form
  (a non-JSON record fails at write time) and has the atomic `claimQueued`. Persistent stores come with #69.
- **Known SDK limits.** `cancelTask(taskId, bus)` receives no call context, so the caller recorded for a cancel is `anonymous`
  until the SDK exposes it. SDK 1.3 has NO guard against a second `execute()` on a live task (a2a-js #632 is the open
  proposal); `sendMessageStream` just does `createOrGetByTaskId`. What happens to a second message on a live task:
  `CoreExecutor.execute` deliberately publishes no Task event for it (the bus is shared with the first stream), so the SDK's
  `_advanceStreamPattern` throws on THAT stream ("Received statusUpdate before initial 'Message'/'Task' event"), while core
  has queued the message and it WILL run as the next turn; the SDK has also already appended it to `task.history`. The client
  therefore gets an error for a message that will execute, and a retry duplicates it. Core guarantees only that no second
  provider call starts. This is an open decision for #109 (see below).
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
- **Open decisions for #108.** What exactly publishes `input-required` and what `signalParked` promises (today the runtime
  publishes through `handle.publisher` and then signals); the expiry policy calling `registry.expire`; the lane is held while
  a run is parked (a second task in the context waits up to the interaction timeout); `handleReply` must never throw (an
  `execute()` rejection on a live task is swallowed by `CoreExecutor`, which hides the error); what a restart does to
  `interrupted` records (the sweep skips them, so a reply later starts a fresh run).
- **Open decisions for #109.** A second message on a live streaming task (reject before queueing without throwing, or make
  the response honest); how a `DeliveryResult` reaches a blocking `sendMessage` caller; `interrupt` with no follow-up
  message (the task waits for a next turn forever today); where steer dispatch happens in `attach`.
- **Trust.** A store-triggered cancel is recorded as `{id: "store", kind: "service"}` and goes through `authorize`; once
  `authorize` is real, decide whether that identity is trusted (the SDK writes `CANCELED` on behalf of any caller).

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
- **`auth-required` (revised for SDK 1.3; spike S1 to re-run).** This document first assumed that the SDK does not
  re-drive streams at `auth-required`, so core would complete the attachment and expect a fresh request after the
  out-of-band step. SDK 1.3 contradicts that: `keepBusAliveStates` defaults to the interrupted states, which include
  `auth-required`, so the bus stays alive and the executor may resume publishing on the same bus after the out-of-band
  auth completes. Which of the two models core uses is decided by re-running S1 on 1.3; until then treat "expects a
  fresh request" as superseded.
- **Bus lifetime.** Core owns it through `ExecutionEventBusManager.settleByTaskId` (see 3.5), including the orphan
  case: a `tasks/cancel` with no bus never calls the executor in SDK 1.3.

| Core | A2A |
|---|---|
| `ask` (parks the run) | task state `input-required`; status message = text rendering; data part with the interaction (extension `urn:a2a-wrapper:interaction:v1`) |
| `auth` interaction | task state `auth-required`; message carries `url`/`userCode`; no credential collection |
| reply `selected` / `answered` / `submitted` | a message on the same task: structured data part `{interactionId, ...}` first, text fallback second ("approve", option label, number) |
| client that did not activate the extension | text rendering only, options numbered, with the reply code ("Reply with `1 K7`"); core still parses the text reply, and selects an `allow_*` option only when the code is present |
| duplicate or late reply | idempotent on (task, interaction id); unknown or answered ids are ignored with no side effect |
| `expired` | task `failed` (or `canceled`) with the reason, per policy |
| cancel while pending | `outcome: "canceled"` delivered to the provider, then the normal cancel path |
| `CoreCaller` | from the A2A call context; permission replies require the task owner or a configured approver |
| core state with no v1 equivalent, or `unknown` | task state `working` (never `TASK_STATE_UNSPECIFIED`), the original string in `urn:a2a-wrapper:core-state:v1` status metadata; restored on read when the wire state is `working` (or the old `UNSPECIFIED`) and the carried state is one core does not model |
| `reject(reason)` | task state `rejected` |
| `interrupt` delivery | the task stays `working` and the message is the next turn; no `canceled` |

### 4.1 Wire keys

Every key core writes is versioned and listed in one constant, `WIRE_EXTENSIONS`; `agentExtensionDeclarations()` turns
it into optional (`required: false`) agent card `extensions` entries (not yet wired into the server factory).

| Key | Where | Meaning |
|---|---|---|
| `urn:a2a-wrapper:interaction:v1` | extension, status message | structured permission/question/form/auth data parts |
| `urn:a2a-wrapper:delivery:v1` | message metadata | `queue` / `steer` / `interrupt` |
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
| Claude | `canUseTool` to `ask`; `AskUserQuestion` to `questions`; streaming input to `steer`; `interrupt()` to `abort` (`session: reusable`) | stream user messages instead of one-shot; return `null` when answered out of band; map `feedback` to deny `message`; spike `defer` hook for restart durability |
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

- **S1.** Validate the run/attachment model (section 4) on SDK 1.0.0 and 1.3: park a run at `input-required`, send the
  reply, confirm the second `execute()` only resolves the ask and streams the rest. **Re-run on 1.3 for
  `auth-required`:** `keepBusAliveStates` keeps the bus alive, so the executor may resume publishing on the same bus
  after out-of-band auth; this contradicts the earlier "expects a fresh request" assumption. Also confirm
  `settleByTaskId` and the cancel-with-no-bus path (3.5).
- **S2.** Real Copilot: `onPermissionRequest` left pending, answered later by RPC; measure `immediate` steering and the
  `delivery` event.
- **S3.** Real Claude: `canUseTool` pending across an A2A round trip; `defer` hook behaviour on resume.
- **S4.** OpenCode 2: `delivery` steer vs queue; re-list of pending asks after a wrapper restart.
- **S5.** Codex `app-server` approval and `turn/steer` round trip (only if decision 5 is yes).
