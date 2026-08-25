# a2a-claude

## 0.4.0

### Minor Changes

- f3c7062: Handle Claude rate limit events instead of failing the turn generically.

  Rate-limit signals were previously unrecognised: `rate_limit_event`,
  `system/api_retry`, and assistant `rate_limit` errors all fell through to a
  debug log, and the turn surfaced as `failed` with `"Error during execution."`

  A rejection now ends the turn immediately with an `input-required` status naming
  the limit type and reset time, plus structured metadata (`reason`,
  `rateLimitType`, `resetsAt`, `resetsAtIso`, `utilization`, and `errorCode` /
  `canPurchaseCredits` when the SDK reports them). The task stays non-terminal, so
  the client continues the same conversation on the same task once the limit
  resets. Configurable via `rateLimit.taskState` for clients that require a
  terminal state.

  This does not shorten the SDK's own retry behaviour: a `system/api_retry` is
  deliberately treated as a warning that does not end the turn, so the SDK's
  internal retries still run to exhaustion inside the same `timeouts.prompt`
  window. The turn ends only once the SDK gives up and emits an assistant
  `rate_limit` error. Those retries are at least visible now, as `rate_limit`
  sideband events with `action: "retrying"` carrying the SDK's `attempt`,
  `maxRetries`, and `delayMs`.

  A rejection whose overage window is still open is treated as a warning rather
  than a rejection, since the request may proceed on overage credits; if it does
  not, the assistant `rate_limit` error still ends the turn. Limit details are
  never fabricated — a limit type or reset time is inherited by a later signal
  only from a snapshot that reported pressure, utilization is never inherited, and
  a reset time that is not in the future is dropped.

  Adds a `rate_limit` sideband event type to `@a2a-wrapper/core`, gated by
  `features.emitRateLimitEvents`.

- 41e2d82: Hold the A2A Task open while Claude has background work in flight.

  A Task used to reach a terminal state as soon as Claude's first turn ended —
  even when that turn had just started a background process and said it was
  waiting on the result. A2A gives an agent no way to open a new turn against a
  terminal Task, so the follow-up report had nowhere to land.

  The Task now stays in `working` for as long as Claude reports background work
  running, and completes only once a turn ends with nothing left. Each turn
  publishes its own `response` artifact and a non-final `working` status update
  whose `metadata.backgroundTasks` lists what is still in flight. Chains of any
  length work this way, as rounds of one Task rather than several Tasks.

  Controlled by `features.holdTaskForBackgroundWork` (default `true`; set
  `false` for the old complete-at-first-result behavior) and
  `features.emitBackgroundTaskEvents` (default `true`), which publishes a new
  `background_tasks` sideband event — added to `@a2a-wrapper/core` — each time
  the live set changes.

  Bumps `@anthropic-ai/claude-agent-sdk` from `0.3.202` to `0.3.245`. The
  feature needs at least `0.3.235`, the first version to emit
  `background_tasks_changed`.

  Three changes apply even with `holdTaskForBackgroundWork` off:

  - Queries now use streaming input rather than a string prompt. A string prompt
    makes the SDK close the CLI subprocess's stdin on the first result, which
    ends the process before a second round is possible. This is not switchable.
  - `agent_started` / `agent_finished` are emitted once per A2A Task rather than
    once per SDK turn.
  - A success result with empty text no longer publishes an empty `response`
    artifact.

  See the a2a-claude README for caveats, including how `claude.maxTurns` and
  `timeouts.prompt` now span a held-open Task's rounds.

- ddc0861: Allow `timeouts.prompt` to be disabled by setting it to `0` (or any value `<= 0`). Previously every turn was bounded at ten minutes by default with no way to opt out, which cut off legitimately long-running turns.

  Negative values were also a footgun: `setTimeout` coerces a negative delay to the next tick, so `prompt: -1` — the intuitive spelling for "no timeout" — aborted the turn immediately instead of disabling the bound. The timer is now armed only for positive values, matching the "set to `0` to disable" convention already used for `healthCheck`.

- a9101a1: **Breaking:** a rate limit now always fails the task. The `rateLimit.taskState`
  config option is removed.

  It previously defaulted to `input-required`, on the reasoning that leaving the
  task open let the client continue the same conversation. That reasoning does not
  hold:

  - **The interrupted turn cannot resume.** `ctx.task` only suppresses the initial
    `Task` record; the prompt sent is always the new user message, and there is no
    replay or continue-previous-turn logic. A follow-up on the open task is just a
    new prompt appended to the conversation — exactly what a new task would send.
  - **Continuity never depended on the task state.** It comes from the
    `contextId` → Claude session mapping in `SessionManager`, which is indifferent
    to how a task ended. A new task on the same `contextId` resumes the identical
    Claude session.
  - **`input-required` means the agent lacks information.** A rate limit lacks
    quota; nothing the client sends unblocks it, only elapsed time. Clients with
    generic `input-required` handling would prompt a human for input nobody wants.
  - Publishing a non-terminal state alongside `final: true` was also internally
    inconsistent.

  The status message now always points at the `contextId` rather than the closed
  task, and still carries the structured metadata (`reason`, `rateLimitType`,
  `resetsAt`, `resetsAtIso`, `utilization`) that an orchestrator needs to schedule
  its own retry. `features.emitRateLimitEvents` is unchanged.

  Migration: remove any `rateLimit` block from your config. If your orchestrator
  alerts on failed tasks, key the suppression on `metadata.reason === "rate_limit"`.

- 3ec9e49: **Breaking:** session expiry is now disabled by default (`session.ttl` defaults
  to `0`), and the background cleanup sweep with it (`session.cleanupInterval`
  also defaults to `0`). Set `"session.ttl": 3600000` and
  `"session.cleanupInterval": 300000` to restore the previous behaviour.

  Previously sessions expired one hour after their **first** message regardless of
  activity, which silently dropped the `contextId` → Claude session mapping and
  made a conversation lose all of its context with no error and only an
  `info`-level log line. Evicting the record reclaimed no disk either — the wrapper
  never deletes SDK session files, so eviction orphaned the transcript rather than
  removing it.

  `session.ttl <= 0` now disables expiry in both eviction paths. A positive `ttl`
  behaves as before.

  `cleanupInterval` is only ever consulted when `ttl > 0` — with expiry off there
  is nothing to sweep — so leaving it at `300000` alongside `ttl: 0` was dead
  configuration that read as if it did something. It now defaults to `0` to match,
  and both example configs drop it entirely. If you set `ttl` on its own you get
  expiry via the lazy check in `getOrCreate`, but a context that is never used
  again holds its record until the process exits; set `cleanupInterval` too if you
  want that reclaimed. Both disabled states are now logged at startup, so neither
  can be lost silently.

  Known consequence: if a Claude session's on-disk transcript is removed while the
  server is running, the stored `contextId` → `sessionId` mapping is now pinned for
  the life of the process instead of being evicted within the hour, so turns on
  that context keep failing to resume until the server restarts. Previously the
  one-hour expiry masked this by self-healing.

### Patch Changes

- Updated dependencies [f3c7062]
- Updated dependencies [41e2d82]
  - @a2a-wrapper/core@2.1.0

## 0.3.0

### Minor Changes

- b3673aa: Add marketplace plugin support: `claude.marketplaces` and `claude.enabledPlugins` map to the SDK's flag-tier `settings` (`extraKnownMarketplaces` / `enabledPlugins`), so the SDK fetches and installs plugins itself — no pre-baked plugin directories, and no dependence on `settingSources` (marketplace plugins load even under full isolation).

  Because the SDK installs marketplace plugins asynchronously by default — installing nothing, reporting no error, and loading zero plugins on every subsequent run — the wrapper sets `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` for those sessions and runs a startup preflight that verifies every enabled plugin actually loaded, failing `initialize()` with the missing plugin names if not. The preflight diffs the session init message's plugin list rather than the `plugin_install` events, which report per-marketplace status and so read as successful even when the named plugin does not exist. The probe costs no tokens (init precedes any model call) and warms the plugin cache.

- 9e47b08: Add `claude.effort` and `claude.thinking`, mapping onto the Claude Agent SDK's `Options.effort` and `Options.thinking`. `effort` accepts `low`/`medium`/`high`/`xhigh`/`max` and is also settable via the `CLAUDE_EFFORT` environment variable; `thinking` accepts `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens?, display? }`, or `{ type: "disabled" }`.

  Both are additive and optional — `claude.model` remains a plain string and `claude.fallbackModel` is unchanged. Values are validated at `initialize()`, so an unsupported effort level or a malformed `thinking` object fails at startup with a message naming the allowed values rather than surfacing as an SDK error mid-task.

  Also fixes `features.emitThinkingEvents` producing no events at all. The SDK leaves `thinking.display` at `"omitted"`, so thinking blocks arrive with an empty string and the mapper's non-empty guard drops every one of them. When thinking events are enabled the wrapper now requests `display: "summarized"` — supplying a full `{ type: "adaptive", display: "summarized" }` when no thinking config is set, and filling in `display` on an explicit `adaptive`/`enabled` config that omits it. An explicit `display` (including `"omitted"`) and `{ type: "disabled" }` are both left untouched. Note that with thinking events on and no `claude.thinking` of your own, this turns adaptive thinking on and it costs thinking tokens.

- d6c2701: Add native A2A protocol v1.0 support, built on `@a2a-js/sdk@1.0.0`, while preserving full backward compatibility with A2A v0.3.x clients.

  **`@a2a-wrapper/core` (breaking):**

  - `buildAgentCard()` now produces the native v1.0 `AgentCard` shape (`supportedInterfaces[]` instead of `url`/`additionalInterfaces`/`protocolVersion`; `capabilities.extendedAgentCard` instead of `supportsAuthenticatedExtendedCard`; `stateTransitionHistory` removed). Callers reading the old v0.3 fields directly off the return value must update — the server itself still serves a fully v0.3-shaped card to legacy clients (see below).
  - `createA2AServer()`'s JSON-RPC/REST transports and the `/.well-known/agent-card.json` route now negotiate protocol version per-request via the `A2A-Version` header: `1.0`/absent-with-recent-header gets the native v1.0 card and wire shapes, while `0.3`/no-header-at-all (matching the SDK's own default) gets a fully v0.3-shaped card and JSON-RPC/REST translation via `@a2a-js/sdk`'s `compat/v0_3` layer.
  - `ServerOptions.protocolVersion` default changed from `"0.3"` to `"1.0"`.
  - New `ServerOptions.onListening` hook and `ServerOptions.agentCardSigning` option (Signed Agent Cards, RFC 7515 JWS, opt-in via `AgentCardConfig.signing` or the programmatic option).
  - New `extractUserText(message)` export centralizing inbound `Part` parsing for the v1.0 proto-oneof `Part` shape.
  - `TaskState` is now re-exported as a value (real numeric enum in v1.0, was a string-literal type in v0.3).
  - `@a2a-js/sdk` peer/dev dependency bumped to `^1.0.0`.

  **Wrapper packages (`a2a-claude`, `a2a-codex`, `a2a-copilot`, `a2a-opencode`, `a2a-antigravity`):**

  - Each wrapper's `createA2AServer()` public API is unchanged, but is now a thin delegate to `@a2a-wrapper/core`'s `createA2AServer` instead of duplicating Express/SDK server wiring — restoring the "A2A protocol code lives only in core" design.
  - `a2a-copilot` and `a2a-opencode` no longer ship their own local `event-publisher.ts`; both now use `@a2a-wrapper/core`'s (v1.0-aware) event publisher.
  - `@a2a-js/sdk` dependency bumped to `^1.0.0` (previously an inconsistent mix of `^0.3.9`/`^0.3.13`).

### Patch Changes

- Updated dependencies [d6c2701]
  - @a2a-wrapper/core@2.0.0

## Unreleased

### Minor Changes

- Native A2A v1.0 protocol support, fully backward compatible with v0.3.x clients — negotiated automatically per request via the `A2A-Version` header, no config changes needed. `createA2AServer()` is now a thin delegate to `@a2a-wrapper/core`'s server factory (upgraded to `@a2a-js/sdk@^1.0.0`) instead of duplicating Express/SDK wiring.

## 0.2.0

### Minor Changes

- 219f014: New wrapper: a2a-claude exposes Claude Code (via @anthropic-ai/claude-agent-sdk) as a spec-compliant A2A server — codex-parity feature set: streaming, per-context session resume, cancellation, permission-mode guardrails, MCP servers, A2A sub-agent delegation, memory materialization, and sideband observability events.
