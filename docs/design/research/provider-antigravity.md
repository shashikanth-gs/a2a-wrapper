# Provider research: Google Antigravity (a2a-antigravity)

Date: 2026-11-21. Scope: evidence for the core-owned domain model in `docs/design/core-owned-a2a-boundary.md`.
Method: read the wrapper source (ground truth for what is reachable today) and the upstream Python SDK docs/source on GitHub and PyPI (read-only, no code run, no install; `google.antigravity` is not installed on this machine).

Labels: [verified: source] = read directly; [inferred] = my deduction; "not found" = searched, absent.

## Sources

Wrapper (all under `C:\Users\shash\Views\a2a-wrapper\a2a-antigravity\`):
- W1 `src/antigravity/python/bridge.py` (443 lines; the Python side)
- W2 `src/antigravity/bridge-protocol.ts` (JSONL command/event types)
- W3 `src/antigravity/bridge-client.ts` (spawn, request/ack, run/cancel plumbing)
- W4 `src/antigravity/executor.ts` (A2A executor, turn queue, cancel, timeouts)
- W5 `src/antigravity/session-manager.ts`, W6 `src/antigravity/event-mapper.ts`, W7 `src/config/types.ts`, `src/config/defaults.ts`, W8 `README.md`, `CHANGELOG.md`, `package.json`, `requirements.txt`, `src/antigravity/python-setup.ts`

Upstream (fetched 2026-11-21):
- U1 PyPI JSON https://pypi.org/pypi/google-antigravity/json and https://pypi.org/project/google-antigravity/#files
- U2 https://github.com/google-antigravity/antigravity-sdk-python (README, tree via GitHub API)
- U3 SDK CHANGELOG https://raw.githubusercontent.com/google-antigravity/antigravity-sdk-python/main/google/antigravity/CHANGELOG.md
- U4 hooks: `.../google/antigravity/hooks/README.md`, `hooks/hooks.py`, `hooks/policy.py`
- U5 `.../google/antigravity/utils/interactive.py`
- U6 `.../google/antigravity/conversation/README.md`, `conversation/conversation.py`
- U7 `.../google/antigravity/connections/local/local_connection.py`, `local_connection_config.py`, `event_processor.py`
- U8 protos: `.../google/antigravity/proto/localharness.proto`, `elicitation.proto`
- U9 examples: `.../examples/getting_started/cancellation.py`, `persistence.py`, `human_in_the_loop.py`
- U10 skills refs: `.../skills/google-antigravity-sdk/references/{architecture,safety_policies,agent_configuration,error_handling}.md`
- U11 https://antigravity.google/docs/sdk/overview
- U12 triggers README `.../google/antigravity/triggers/README.md`

Not found: any official statement that the SDK is "preview" in prose (only the PyPI classifier `Development Status :: 3 - Alpha`, and a `beta` namespace inside the SDK). No GitHub Releases entries were returned by the API (empty list), so the SDK CHANGELOG (U3) is the only change record. Some SDK facts were summarized by a fetch tool from the raw files, not read by me line by line; treat them as [verified: URL] at that granularity.

## Architecture in one paragraph

Node runs the A2A server. It spawns ONE private Python process (`python3 bridge.py`, JSONL over stdio) [verified: bridge-client.ts:57]. That process imports `google-antigravity` and creates one SDK `Agent` per A2A contextId ("session") [verified: bridge.py:202-213, session-manager.ts:41-71]. Each SDK `Agent` (local connection) in turn spawns a compiled `localharness` binary shipped inside the wheel and talks to it over a localhost WebSocket after a length-prefixed stdio handshake [verified: U7 local_connection.py summary; U2 README "ships a compiled runtime binary"]. So the chain is Node -> Python bridge -> (Python SDK) -> localharness binary per session -> Gemini/Vertex.

## Summary table

| # | Dimension | Support | Mechanism & names | Evidence |
|---|---|---|---|---|
| D1 | Run lifecycle & event stream | partial (bridge) / native (SDK richer) | Bridge events: `session_opened`, `text_delta`, `thought_delta`, `tool_call_start`, `usage`, `structured_output`, `completed`, `canceled`, `failed`, `log`. SDK: `Agent.chat()` -> `ChatResponse` (async text iterator, `.thoughts`, `.tool_calls`, `.usage_metadata`, `.structured_output()`), plus step stream (`receive_steps`) and harness `OutputEvent` protos | bridge-protocol.ts:86-143; bridge.py:239-312; U6; U8 |
| D2 | Abort / interrupt | partial | Bridge `cancel` -> `ChatResponse.cancel()` (sends harness `halt_request`) then `asyncio.Task.cancel()`; terminal `canceled` event. SDK raises `AntigravityCancelledError` (subclass of `asyncio.CancelledError`). Does not stop host-side work reliably (tool subprocess, queued turns) | bridge.py:332-340; U9 cancellation.py; U7 cancel() |
| D3 | Steering (message mid-turn) | none native; workaround-possible | SDK `Conversation.send()` during an active turn BLOCKS and drains the active turn first; no steer event in harness proto. Workaround: cancel + `send` merged prompt on same session | U6 conversation.py `send()`; U8 localharness.proto (no steer field); bridge.py:230-236 |
| D4 | Permission/approval requests | native in SDK; none via bridge | SDK: `policy.ask_user(tool, handler=...)` (handler gets `ToolCall`, returns bool), `ToolConfirmationHook` (stdin), harness `policy_decision_request`/`PolicyDecisionResponse`. Bridge exposes only `sdkDefault`/`allowAll`/`denyAll`/`custom` allow+deny; NO ask_user, no hooks passed; denials are silent to the caller | bridge.py:99-119; U4 policy.py; U7 event_processor.py |
| D5 | Questions / user input | native in SDK (opt-in); none via bridge | Harness `questions_request` (`UserQuestionsRequest`, multiple-choice) -> `OnInteractionHook` / `AskQuestionHook` (`AskQuestionInteractionSpec` -> `QuestionHookResult` of `QuestionResponse`). Needs `AgentBehavior.INTERACTIVE` and the `ASK_QUESTION` tool (removed from defaults in 0.1.21). Bridge: not enabled, no hook | U5; U9 human_in_the_loop.py; U3 0.1.11/0.1.21; bridge.py (absent) |
| D6 | Auth-required flows | none | Static: `apiKey` (GEMINI_API_KEY), `adc` (`vertex=True`+project+location), `sdkDefault`. No interactive/OAuth flow; wrapper states Pro/Ultra login is not exposed. Auth failures become generic `failed` with code `AUTH_ERROR` | bridge.py:181-193, 359-369; W8 README "Model Access"; U11 |
| D7 | Persistence / resume after restart | partial (SDK native; wrapper not wired) | SDK: `LocalAgentConfig(save_dir=, conversation_id=, session_continuation_mode=RESUME/CREATE_OR_RESUME/CREATE_ONLY)`; harness `cascade_id`. Wrapper: `conversationId`/`saveDir` are single static config values; `contextId -> session` map is in-memory; `agent.conversation_id` is returned in `session_opened` but ignored | U9 persistence.py; U7; bridge.py:173-176,215-219; bridge-client/session-manager (no use) |
| D8 | Concurrency | partial | One bridge process; N Agents (one per contextId), each with its own harness subprocess; per-session `asyncio.Lock` and Node `executionQueue` serialize turns within a context; different contexts run in parallel. No cap | bridge.py:209-213,255; session-manager.ts; executor.ts:249 |
| D9 | Tool / MCP / thinking / plan events | partial | Bridge forwards thinking (`Thought` chunk), tool call START only, MCP via `mcp_servers`. No tool result/end, no plan, no subagent events. SDK has per-tool pre/post hooks, `INVOKE_SUBAGENT`, `manage_task`, compaction events | bridge.py:259-277; README "Sideband Events"; U4; U3 |
| D10 | Input modalities & outputs | partial | SDK: text + `Image`/`Document`/audio in prompt, structured output (`response_schema`), image-gen model. Bridge: prompt is `extractUserText` string only; output = text artifact + trace artifacts | executor.ts:135; bridge.py:256; U2; U3 |
| D11 | Usage / cost / context | partial | Bridge emits ONE `usage` at end (`inputTokens`,`outputTokens`,`cacheReadTokens`,`reasoningTokens`,`totalTokens`,`durationMs`); cost always `null`; model falls back to config. SDK has live `UsageUpdate` (0.1.10), `conversation.total_usage`, `BudgetConfig`, `CompactionConfig` | bridge.py:315-329; event-mapper.ts:40-58; U3 |
| D12 | Policy configuration | native (SDK) / partial (wrapper) | `capabilities.enabledTools|disabledTools` (mutually exclusive, hide tool from model) and `policies.mode` + `rules[{decision,tool}]` (allow/deny only). Default SDK policy `confirm_run_command()` denies `run_command`; `workspace_only` auto-added when `workspaces` set | types.ts:50-77; bridge.py:87-119; executor.ts:301-312; U4; U10 |
| D13 | Hooks / lifecycle callbacks | native (SDK) / none (wrapper) | SDK hook classes: `OnSessionStartHook`, `OnSessionEndHook`, `PreTurnHook`, `PostTurnHook`, `PreToolCallDecideHook`, `PostToolCallHook`, `OnToolErrorHook`, `OnInteractionHook`, `OnCompactionHook`, `StopHook`. Wrapper registers none | U4 hooks.py; bridge.py (no `hooks=`) |
| D14 | Stability / versioning | weak | SDK `google-antigravity` 0.1.24 (2026-11-19) is Alpha, Apache-2.0, Python >=3.10, wheels only (win x64/arm64, macOS 11+ x64/arm64, manylinux/musllinux x64/aarch64), ~40 MB each; wrapper pins 0.1.5 (2026-06-25), 19 releases behind with several breaking changes | U1; requirements.txt; U3 |

## Details per dimension

### D1 Run lifecycle & event stream

Wrapper (ground truth). Node sends `run {taskId, sessionId, prompt}`; Python acks immediately then runs `_run_task` in an `asyncio.Task` [bridge.py:230-236]. Inside the session lock it does `response = await agent.chat(prompt)` and iterates `response.chunks`. Chunk classes are dispatched by class name: `Text` -> `text_delta`, `Thought` -> `thought_delta`, anything with `.name` and `.args` -> `tool_call_start` [bridge.py:259-277]. After the loop it emits `usage`, optionally `structured_output`, then `completed {text, usage, structuredOutput}` [bridge.py:279-300]. `canceled` on `asyncio.CancelledError`, `failed {code,message,details}` on any exception [bridge.py:301-310]. Terminal events are matched by `taskId` and resolve the Node promise [bridge-client.ts:340-348]. Untyped failures with no `taskId` (e.g. a malformed line) are emitted but have no consumer.

Executor behavior: A2A `submitted` (if new task) -> `working` -> streamed artifact chunks (only when `features.streamArtifactChunks`) or a single final artifact -> `completed`/`failed`/`canceled` [executor.ts:126-247]. Tool and thought events are not A2A messages; they go to the "sideband" emitter as `trace.*` artifacts [event-mapper.ts:70-105]. Event ordering is the SDK's; there are no sequence numbers on the bridge protocol (the harness proto has `seq_num`, `timestamp_micros` on `OutputEvent` [U8] but the bridge does not use them).

SDK has more than the bridge exposes: step stream (`receive_steps`), `StepUpdate` states, `trajectory_state_update` with `stop_reason`, `usage_update`, subagent trajectories (ignored by the SDK processor except failure logging) [U7 event_processor.py]. `StopReason` is exposed internally as `_last_turn_stop_reason` (private) [U7]. The bridge does not surface stop reason (e.g. budget exhausted), so core would see `completed` even if a budget cut the turn [inferred].

Version-drift risk: the bridge detects chunk types by class name and attribute presence (`cls_name == "Text"`), which is brittle across SDK releases [inferred from bridge.py:260-270 + U3].

### D2 Abort / interrupt

Chain: Node `cancel` -> Python `handle_cancel` -> `await response.cancel()` if the `ChatResponse` is already set, then `task.cancel()` [bridge.py:332-340]. SDK `cancel()` sends `InputEvent.halt_request=True` over the WebSocket and flags `_client_cancelled` so the step stream raises `AntigravityCancelledError` (subclass of `CancelledError`) [U7; U9]. The harness then emits `STATE_CANCELLED` -> "Turn cancelled" error -> idle [U7 event_processor]. The bridge maps the resulting `CancelledError` to a `canceled` event.

What it really stops:
- The model turn: yes, via harness `halt_request` [verified: U7].
- In-flight built-in tools such as a `run_command` subprocess: not documented. README warns that detached grandchildren survive and recommends process supervision [README "Python Subprocess Lifecycle"]. SDK 0.1.24 says subprocess/pipe/WebSocket cleanup became deterministic on `CancelledError` (that is SDK-side cleanup, not necessarily tool children) [U3 0.1.24].
- Race: `response` is stored only after `await agent.chat()` returns [bridge.py:256-257]. A cancel arriving before that falls through to `task.cancel()` only, which cancels the Python task but never sends `halt_request`; the harness may keep generating while the client has stopped reading [inferred]. Also the bridge `except CancelledError` branch has no way to distinguish programmatic from native cancel (the SDK example distinguishes them [U9]).
- Queued turns (same contextId): Node serializes turns via `session.executionQueue` and tracks the execution BEFORE the turn starts [executor.ts:141,249]. `cancelTask` calls `bridge.cancel(taskId)` (a no-op in Python, which has no active task yet) and publishes `canceled`, but the queued `turnFn` later still runs the prompt [verified: executor.ts:271-279 vs 143-261]. This is an existing bug the core `abortOrphan`/`abortBackend` split should fix.
- Double terminal: `cancelTask` publishes `canceled` + `bus.finished()` itself, and the later bridge `canceled` terminal makes `turnFn` publish `canceled` again [executor.ts:232-236, 275-278]. Matches the "ordering bug" the design doc names.
- Prompt timeout: `timeouts.prompt` (default 600 s) calls `bridge.cancel(taskId)` and rejects with a timeout [executor.ts:145-152], so the A2A task becomes `failed` while the Python side cancels.
- Abort of a task with no live run after restart: nothing to abort (no persisted state); see D7.

### D3 Steering

SDK: `Conversation.send()` does not queue or inject; it first awaits the active response ("drains all remaining steps into history") or waits for idle, then sends the new message [verified: U6 conversation.py summary]. `chat()` while active therefore resolves the old response first. The harness proto has no steer message in `InputEvent` (`user_input`, `halt_request`, `tool_confirmation`, `tool_response`, `question_response`, `call_hook_response`, `policy_decision_response`, `session_end_request`, `automated_trigger`) [U8]. `local_connection.send()` itself does not check idle, so what the harness does with a `user_input` mid-turn is undocumented [U7 summary; not found]. Triggers can `send()` from background tasks with "no ordering guarantees" and docs do not say whether mid-turn delivery interleaves [U12]; treat as unknown, not as native steering.

Bridge: a second `run` for the same session waits on `session["lock"]` and Node also serializes via `executionQueue`, so a mid-task A2A message becomes a queued next turn de facto [verified: bridge.py:255, executor.ts:249]. Core does not need to do anything for that; but it is by accident, not by contract.

Workaround (provider-local, feasible): `onMessage` = `cancel(taskId)` (halt_request), wait for `canceled`, then issue a new `run` on the SAME session with prompt = original goal + partial output + steering text. Same session keeps `Conversation.history`, including steps up to the cancel point [inferred: U6 says every received step is recorded; whether the cancelled turn's partial text is in history is not documented]. Cost: the current turn's partial tool work is abandoned; text emitted so far must be re-supplied by the provider. Another possible variant: PreToolCallDecideHook that injects a user-visible denial message with `HookResult(allow=False, message=...)` at the next tool boundary, which returns the steering text to the model as the tool error [inferred; the hook can deny with a message, U4]. Neither is in the bridge.

### D4 Permission / approval

SDK model (richest on this axis):
- Policies: `policy.allow(tool)`, `deny(tool, when=, reason=)`, `ask_user(tool, handler=, when=, reason=)`, `auto(handler=, model=)`, `allow_all()`, `deny_all()`, `safe_defaults(handler)`, `confirm_run_command(handler=None)`, `workspace_only(workspaces)`; `enforce(policies)` returns a `PreToolCallDecideHook`. 9-level precedence (specific deny > ask > allow, then server wildcard, then `*`) [U4 policy.py].
- `ask_user` handler is called with the `ToolCall` (and optionally `reason`), returns bool (sync or async); exception = deny (fail closed); no handler on an ASK_USER policy = DENY [U4; U7 "ASK_USER decision with no handler: DENY"].
- Harness-originated flow: `policy_decision_request {request_id, rule_id, tool_args, reason}` -> client replies `PolicyDecisionResponse {request_id, outcome, deny_reason}` [U8]. This is a protocol-level request/response, so an async out-of-band answer is structurally possible (the handler is just an awaitable) [inferred]. `tool_confirmation_request` is auto-accepted by the SDK unconditionally; gating is done by `PreToolCallDecideHook` [U7].
- No timeout is implemented in the event processor; an unanswered handler waits forever [U7].

Bridge: `_build_policies` returns `None` (SDK default: `confirm_run_command()` deny), `[allow_all()]`, `[deny_all()]`, or custom allow/deny list; `ask_user` is never constructed and `hooks` is never passed to `LocalAgentConfig` [verified: bridge.py:99-119,167-179]. Consequently a denied `run_command` is a silent tool error visible only to the model (README documents the agent replying "blocked by policy" [README "Command Policy"]). No `input-required` is possible today. To add it, Python must create `policy.ask_user("*", handler=h)` where `h` emits a `permission_request {requestId, taskId, tool, args, reason}` event to Node and awaits a Future resolved by a new `permission_response` command; this is a small extension [inferred; fits `bridge-protocol.ts` shape].

Natural mapping to `CoreInteraction.permission`: `action = tool name`, `target = args (e.g. command_line, path)`, `detail = ToolCall`, `options = approve/deny` (binary only; SDK returns bool, no "always allow" and no reason on approve) [inferred].

### D5 Questions / user input

SDK: harness emits `StepUpdate.questions_request` (`UserQuestionsRequest`: `questions[]` -> `MultipleChoice {question, choices, is_multi_select}`) only when the step is `STATE_WAITING_FOR_USER`; only multiple-choice is routed, other kinds are skipped with a warning [U7, U8]. Client answers `UserQuestionsResponse {trajectory_id, step_index, cancelled | answers[]}` where each answer is `unanswered` or `multiple_choice_answer {selected_choice_indices, freeform_response}` [U8]. In Python, `OnInteractionHook.run(context, AskQuestionInteractionSpec) -> QuestionHookResult` with `QuestionResponse(selected_option_ids=[...] | freeform_response=... | skipped=True)` and `cancelled=True` [U4, U5]. The stock `AskQuestionHook` reads stdin (`async_input`); a subclass overriding `run()` can answer out-of-band [U5, partly inferred]. Without any hook registered, the processor replies "unanswered" for every question so the harness never hangs [U7].

Enablement: `CapabilitiesConfig(agent_behavior=AgentBehavior.INTERACTIVE)` + system instruction telling the model to use `ask_question` + a hook [U9]. Since 0.1.11 the default is AUTONOMOUS (the agent does not ask), and since 0.1.21 `ASK_QUESTION` was removed from default tools [U3]. The bridge sets neither, so the agent never asks today [verified: bridge.py:87-96]. The `AgentBehavior` value is not in the wrapper's `capabilities` schema either [verified: types.ts:50-59]. Whether the pinned 0.1.5 even has `AgentBehavior` is not found (it is described as new in 0.1.11).

### D6 Auth-required

Config is static: `authMode` sdkDefault | apiKey | adc. `apiKey` -> `api_key`; `adc` -> `vertex=True, project, location` [bridge.py:181-193]. Executor fails fast if adc lacks project or location [executor.ts:294-299]. No interactive sign-in, token refresh prompt, or device-code flow exists in the SDK (not found); README states Google AI Pro/Ultra login is not exposed [README "Model Access"]. Auth errors: the SDK stops the stream on HTTP 400/401/403 step errors [U7]; the bridge classifies by substring ("API key", "Unauthenticated", "401") as `AUTH_ERROR` [bridge.py:359-369], which the executor reports as generic `failed` with sanitized text [executor.ts:238-243]. So today an auth problem is a task failure, not `auth-required`. Note: this is a server-side credential problem (the operator, not the A2A caller, owns the credential), so mapping to A2A `auth-required` would be semantically off; `failed` with a precise reason is arguably correct [inferred]. Env vars `GOOGLE_GENAI_USE_VERTEXAI`/`GOOGLE_GENAI_USE_ENTERPRISE` flip `vertex` implicitly in the SDK [U7 config].

### D7 Persistence / resume

SDK: `save_dir` + `conversation_id` (+ `session_continuation_mode`) restore history, usage and trajectory in a new process; `Agent.conversation_id` reads the id back; if `save_dir` is unset a temp dir `antigravity_*` is created, so history is lost [U9 persistence.py; U7 config]. File layout is undocumented. The example runs both sessions in one process, so cross-process restore is claimed but not demonstrated [U9].

Wrapper: nothing durable. `SessionManager.sessions` is an in-memory `contextId -> sessionId` map with TTL 1 h (`defaults.ts`) [session-manager.ts:32,41-71]. The bridge does emit `conversationId` in `session_opened` [bridge.py:215-219] but the Node side ignores it (`BridgeClient` only waits for the ack; `handleLine` drops `session_opened` events with no taskId [bridge-client.ts:340-357]). `antigravity.conversationId` is one global value applied to every session, which would make all contexts share one conversation if set [verified: bridge.py:173, types.ts:95]. `saveDir` is optional and defaults to a temp dir. A restart therefore loses all contexts; an in-flight turn on restart simply dies with the process.

To support core `resume(state)`: persist `{contextId -> conversationId, saveDir}` in the core task store (provider metadata), pass per-session `conversation_id` + shared `save_dir` + `session_continuation_mode=RESUME` on `open_session`. An in-flight turn cannot be resumed (the harness binary dies with the bridge); only completed history can [inferred].

### D8 Concurrency

- Bridge process: single, long-lived, serves all contexts [bridge-client.ts:57]. If it dies, every active run is rejected and later calls restart it lazily on `start()` (`markExited` resets `started`) [bridge-client.ts:372-377, 50-52]; all Python sessions are lost, but Node's `SessionManager` still holds stale `sessionId`s, which makes the next `run` fail with `SESSION_NOT_FOUND` [bridge.py:242-247; inferred stale-map consequence].
- Sessions: one SDK `Agent` (hence one `localharness` process + WebSocket) per contextId; each is created with `Agent.__aenter__` [bridge.py:206-208; U7 spawn]. Resource cost is a ~40 MB binary process per context for up to 1 h TTL; no max-sessions limit [inferred].
- Turns: serialized per session by `asyncio.Lock` (Python) and `executionQueue` (Node); parallel across contexts. Multiple concurrent tasks on the same context are possible at A2A level (task per message) and just queue.
- The Python stdin loop awaits `dispatch` per line, but `run` returns after ack, so commands are processed while turns run [bridge.py:419-434, 230-236]. `emit` is serialized by an `asyncio.Lock` created at import time (fine on 3.10+).
- Timeouts: `bridgeStartup` (30 s) is used for every request/ack, including `open_session`, which spawns a harness and may take longer under load [bridge-client.ts:299]; a slow open could fail spuriously [inferred].

### D9 Tool / MCP / thinking / plan events

- Thinking: `Thought` chunk -> `thought_delta` -> sideband `thinking` event if `features.emitReasoning` [bridge.py:266-269, event-mapper.ts:71-74]. README notes no thinking was observed with `gemini-3.1-flash-lite` [README].
- Tools: only `tool_call_start {toolName, toolId, args}`; deduped by `toolId` or name+args [event-mapper.ts:76-88]. No tool result/end/error event: README states command output was not a separate sideband artifact [README "Sideband Events"]. The SDK has `PostToolCallHook` (`ToolResult.result` string), `OnToolErrorHook`, and `call_id`/`step_id` on hooks (0.1.10/0.1.11/0.1.22) [U3, U4], so tool-end events are obtainable.
- Built-in tools named in sources: `run_command`, `view_file`, `edit_file`, `create_file`, `grep_search`, `INVOKE_SUBAGENT`, `SEARCH_WEB`, `read_url_content`, `manage_task`, `schedule`, `RUN_WORKFLOW`, `ASK_QUESTION` [U3, U4, U10]. Full list not found; check `built_in_tools.md` in upstream (not read).
- MCP: `McpStdioServer`, `McpStreamableHttpServer` (SSE removed in 0.1.2) built from `mcp` config; per-server `enabled_tools`/`disabled_tools`; MCP tool identity changed from `mcp_{server}_{tool}` to explicit server names in 0.1.6 [bridge.py:122-154; U3]. Core's sub-agent bridge reuses this path (`bootstrapSubAgents`, executor.ts:71-83).
- Plan/todo: not found as an event. Subagents appear as `INVOKE_SUBAGENT` tool calls; parent hooks fire for subagent tool calls [U4]. Subagent trajectories are ignored by the SDK processor except failure logs [U7].
- Compaction: `OnCompactionHook` and `compaction_indices`; not surfaced by the bridge.

### D10 Input modalities & outputs

SDK prompts accept text plus `Image`/`Document` (and audio, per `sample_audio.wav` example and 0.1.9 fix) as `types.Content`; `from_file`/`from_bytes` helpers [U6, U2, U3]. Bridge `run` carries `prompt: string` only; the executor uses `extractUserText(userMessage)` so file/data parts are dropped [bridge-protocol.ts:35-41, executor.ts:135]. Output: streamed or final text artifact, `trace.structured_output` artifact when `response_schema` is set (not the primary artifact unless text is empty) [executor.ts:186-190,208-210]. Generated images/files (image model exists, 0.1.7) are not surfaced. For core: input `CorePart` `file`/`data` would need a bridge extension (write bytes to a temp file or send base64 and build `types.Content`).

### D11 Usage / cost / context

`_usage_payload` maps `prompt_token_count`, `candidates_token_count`, `cached_content_token_count`, `thoughts_token_count`, `total_token_count`, plus wall duration; `cacheWriteTokens` hard-coded 0 [bridge.py:315-329]. Emitted once after the stream. `model` is never set by Python, so Node falls back to configured model (or "") [event-mapper.ts:46]. `cost: null`, `timeToFirstTokenMs: null`. Published as an `x-usage` status extension and `trace.usage` [executor.ts:177-185,219-227]. SDK has more: live `UsageUpdate` events (0.1.10), cumulative `conversation.total_usage`, per-trajectory usage, `service_tier` in `UsageMetadata`, `BudgetConfig` (model calls/tool calls/tokens) with `StopReason`, `BudgetScope.FORWARD_LOOKING` for resumed turns, `CompactionConfig.token_threshold` [U3]. Context window size/remaining: not found. `compactionThreshold` in the wrapper config is deprecated upstream since 0.1.17 [U3 vs types.ts:57].

### D12 Policy configuration

Wrapper config: `capabilities {enableSubagents, enabledTools, disabledTools (mutually exclusive), compactionThreshold}` and `policies {mode: sdkDefault|allowAll|denyAll|custom, rules[{decision: allow|deny, tool}]}` [types.ts:50-77]. Executor validates: both enabled+disabled lists rejected; `custom` requires rules [executor.ts:301-312]. Bridge: rules whose `tool` is empty or decision unknown are silently skipped [bridge.py:109-117]. `enabledTools`/`disabledTools` hide the tool from the model entirely, while a `deny` policy leaves it visible so the model can burn tokens retrying [U4 hooks README]. No `when` predicates, no `ask_user`, no `auto` policy, no `workspace_only` override, no `RunCommandConfig` (sandbox, timeout) in the config schema. `workspaces` set => SDK prepends `workspace_only()` (file tools confined) [U10 safety_policies]; the README example uses workingDirectory so this applies.

Mapping to a core-owned operator policy: core's "operator auto-answer rules" (design doc section 6.4) can be implemented ABOVE this: provider emits `run.ask` for every non-hidden tool and core auto-answers by rule; the SDK `policies` stay as a coarse backstop.

### D13 Hooks / lifecycle callbacks

SDK hook taxonomy: Inspect (read-only), Decide (`HookResult(allow, message, modified_args)`), Transform (return modified data). Classes and decorator names: `OnSessionStartHook` (`on_session_start`), `OnSessionEndHook` (`on_session_end`), `PreTurnHook` (`pre_turn`, data = `types.Content`, user `send()` only), `PostTurnHook` (`post_turn`, data = str), `PreToolCallDecideHook` (`pre_tool_call_decide`), `PostToolCallHook` (`post_tool_call`), `OnToolErrorHook` (`on_tool_error`), `OnInteractionHook` (`on_interaction`), `OnCompactionHook` (`on_compaction`), `StopHook` (`stop`, `StopDecision.CONTINUE|ALLOW_STOP`) [U4 hooks.py]. Hooks run in the Python process (host side); built-in tool hooks round-trip through harness `call_hook_request`/`CallHookResponse` keyed by `request_id` [U7, U8]. Hook failures fail closed for Decide/Transform [U4]. Known limit: pre-turn hooks do not intercept connection-initiated turns (background tasks, cron) [U4].

Wrapper: no hooks are passed (`hooks=` absent from the `LocalAgentConfig` payload [bridge.py:167-179]). Nothing else in the wrapper (TypeScript) exposes lifecycle callbacks beyond core's sideband `agent_started`/`agent_finished`/`agent_error`.

Useful for the core model: `StopHook` with `CONTINUE` is a native way to implement "inject a follow-up before the agent finishes" (a form of late steering) [inferred from the docstring "StopDecision.CONTINUE"].

### D14 Stability, versioning, license, spawn, platforms

- SDK: `google-antigravity`, latest 0.1.24 uploaded 2026-11-19; 19+ releases in 6 months (0.1.0 on 2026-05-19) [U1]. PyPI classifier `Development Status :: 3 - Alpha`; in-SDK `beta` namespaces for experimental APIs (0.1.21) [U1, U3]. License Apache-2.0 [U1]; the wheel ships a compiled `localharness` binary whose source is not in the repo ("Cloning this repository alone is not sufficient") [U2], so the runtime itself is a closed binary [inferred; license of the binary not found].
- Breaking changes in the SDK changelog since the pinned 0.1.5: MCP SSE removed (0.1.2, before), `AgentBehavior` default flipped to autonomous (0.1.11), relative workspace path resolution and `TriggerDelivery` removed (0.1.15), `CompactionConfig` single threshold and `ASK_QUESTION` out of defaults (0.1.18, 0.1.21), `modified_arguments_json` -> `modified_args` (0.1.21), `ThinkingLevel.EXTRA_HIGH` value changed (0.1.24), default model changed repeatedly (3.6 -> 3.7 -> 3.8 flash -> `gemini-4-hydrogen` in 0.1.24) [U3]. Hook/policy API moved: new top-level `policy` package (0.1.4) while the bridge imports `google.antigravity.hooks.policy` (still exists in main per the tree [U2]).
- Wrapper version: a2a-antigravity 0.2.2, MIT, Node >=20, Python >=3.10, tested with SDK 0.1.5 and `gemini-3.1-flash-lite` [package.json; README "Tested With"]. The wrapper never exercised any SDK newer than 0.1.5 (not found).
- Process spawn: `spawn(pythonPath, [bridge.py], {stdio: pipe})`, preceded by a `python -c "import google.antigravity"` probe [bridge-client.ts:57,117-120]. Python path resolution: explicit config/env > managed venv (`a2a-antigravity setup`, in `%LOCALAPPDATA%\a2a-antigravity\venv` on Windows, `~/Library/Caches/...` on macOS, `$XDG_CACHE_HOME`/`~/.cache` on Linux) > `python3` [bridge-client.ts:97-112; python-setup.ts:39-62]. Default `pythonPath` is `"python3"` which is commonly absent on Windows (only `python`/`py`), so Windows users must run `setup` or set `ANTIGRAVITY_PYTHON` [inferred from defaults.ts:32 + standard Windows Python installs; not tested here].
- Platforms: SDK wheels cover Windows x64/ARM64, macOS 11+ x64/ARM64, Linux glibc/musl x64/aarch64 (wheel list [U1]); Windows support since 0.1.2 [U3]. No sdist, so unsupported platforms cannot install [U1]. Wrapper's shutdown uses `SIGTERM`/`SIGKILL` on the bridge, which Node maps to hard terminate on Windows [bridge-client.ts:270-276; inferred]; grandchild processes (harness, tool commands) may leak, as the README itself notes [README].
- Env: the bridge inherits `process.env` entirely (`env: process.env`), so `GEMINI_API_KEY` and other secrets reach tool subprocesses unless the SDK `env` option (0.1.7) is used; wrapper does not set it [bridge-client.ts:59; U3].

## Gaps & surprises

1. The wrapper pins SDK 0.1.5 while 0.1.24 is current. Every capability below (questions, budget stop reasons, `modified_args`, `StopHook`, live `UsageUpdate`, `AgentBehavior`) postdates or changed after 0.1.5; evidence of which exist in 0.1.5 is not found. Any design must be validated against the pin or the pin must move.
2. The bridge is a thin "chat and stream" adapter. Permission, question, steering, hooks, multimodal, persistence, and budget are all native SDK features that the bridge simply does not wire. So "provider capability = handlers it implements" is accurate here: today this provider would implement `run` + `abortBackend` only.
3. Silent denial: the default `run_command` deny and any `custom` deny are invisible to the A2A caller. The agent can only tell the user in prose. Surfacing `run.ask` is the real fix.
4. Cancel of a queued (not yet started) turn does not prevent it from running (executor.ts:141-279); cancel can also double-publish `canceled`; cancel before `chat()` returns skips `halt_request`.
5. The bridge returns `conversationId` on `session_opened` but the Node client drops it, and the config `conversationId` is global; resume is therefore effectively unwired.
6. One compiled binary process per context; per-context cost is non-trivial and there is no concurrency cap.
7. `tool_confirmation_request` is auto-accepted by the SDK; real gating is via policies/PreToolCallDecideHook, so "approval" is a policy concept, not a harness UI prompt.
8. `bridgeStartup` timeout (30 s) is reused for every request ack including `open_session` and `cancel`.
9. Error/auth classification is string-matching in Python (`_error_code`), so `AUTH_ERROR` detection is fragile.
10. Unanswered questions/approvals have no SDK timeout; a never-resolved handler hangs the turn until the wrapper's `timeouts.prompt` (600 s) cancels it.

## Implications for a provider-neutral contract

Provider handlers Antigravity can offer (and what each needs):

- `run`: already shaped right. Stream text/thought/tool-start/usage/structured output and a terminal event keyed by `taskId`; wrapper maps these to `run.status`/`run.artifact`/trace parts.
- `abortBackend(run)`: send `cancel{taskId}`; should return only after the bridge reports a terminal (`canceled`/`failed`) so core can bound it with its timeout; the provider must stop emitting its own `canceled` status to avoid the double publish. Needs a fix so that cancel-before-`chat()` still sends `halt_request`, and so a queued turn is dequeued instead of started.
- `abortOrphan({taskId, contextId})`: needs a bridge command `close_session` on the contextId's session (already exists) and, after restart, nothing to abort (harness died with the bridge). Cheap: always succeed.
- `onMessage(run, message)` (steering): no native mid-turn injection. Provider-local workaround: `abortBackend` then re-`run` on the same session with merged prompt (outcome `accepted` if the abort-and-resume succeeds; `queued` if the turn already ended). A lighter option that preserves tool work is a Python `PreToolCallDecideHook` that returns `HookResult(allow=False, message=<steering text>)` at the next tool boundary (outcome `accepted`, latency = next tool call) [inferred]. A third is `StopHook` returning `CONTINUE` with the steering text before the turn ends. Core's inbox must let the provider return `queued` cheaply because the Python side already serializes turns.
- Permission: provider supplies `policy.ask_user("*", handler)` in Python, and the handler emits `permission_request{requestId, taskId, tool, args, reason}` to Node; Node calls `run.ask({kind:"permission", action: tool, target: args, detail})`, then answers with a new `permission_response{requestId, approved}` bridge command. The `CoreInteractionResult` needs only `answered|declined|timeout|canceled`; map `canceled`/`timeout` to deny (SDK has no "abort turn" return, so core should also cancel the run when the interaction is canceled). Core needs to tolerate `ask` being called from a nested provider callback while the turn is blocked, and apply its own timeout (SDK has none). Options model should allow only approve/deny (no "always allow" in SDK; a persistent allow would live in core's operator rules).
- Question: provider registers a custom `OnInteractionHook`, sets `AgentBehavior.INTERACTIVE`, and includes `ASK_QUESTION` in tools; maps `AskQuestionInteractionSpec` (multiple choice, `is_multi_select`, freeform allowed) to `CoreInteraction.question {prompt, choices, multi}` and returns `QuestionResponse(selected_option_ids | freeform_response | skipped)`; `QuestionHookResult(cancelled=True)` for `canceled`. Core's `question` shape needs `choices[].id`, `multi`, and `allowFreeform`; multiple questions per request are possible in the harness proto (`questions[]`), so either the provider asks sequentially or core's interaction needs a list.
- `resume(state)`: provider persists `{conversationId, saveDir}` per contextId (core store holds opaque provider meta), reopens with `session_continuation_mode=RESUME`. A pending permission/question cannot survive a restart (the Python Future and harness are gone); core should fail the task with a precise reason, which matches design doc 6.5 when the provider offers no `resume` for interactions. So here `resume` would cover only "context history", not "pending interaction".
- Auth: core does not need `auth` interactions for this provider (credentials are operator-side). If asked, a provider could map `AUTH_ERROR` to `failed` with a stable error code; core vocabulary should let a provider tag `fail(error)` with a machine code (the bridge already carries `code`).
- Usage: core's usage record should allow nullable cost/model and `reasoningTokens`, `cacheReadTokens`; fields line up with `UsageCallRecord` now. Live updates are available upstream (`UsageUpdate`).
- Input parts: core should hand providers `CorePart[]` with file/data parts; Antigravity can take images/documents, so a `run` implementation should be allowed to accept or reject unsupported parts explicitly rather than silently dropping them (as executor.ts:135 does today).
- Capabilities-by-implementation works well here: this provider would implement `run`, `abortBackend`, `abortOrphan`, `onMessage` (workaround), and later interactions; it would not implement `resume` for pending interactions. Core must not infer anything from provider identity; the Python-side SDK version gating (what the pinned SDK supports) must stay in the provider.
- Version risk to the contract: the provider contract should be insulated from SDK churn by keeping the bridge protocol versioned (it already has `protocolVersion: 1`); raise it when adding `permission_request`, `question_request`, `permission_response`, `question_response`, `steer`.
