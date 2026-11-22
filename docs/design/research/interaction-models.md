# Interaction models in other protocols and SDKs

Research for the core-owned domain model (docs/design/core-owned-a2a-boundary.md, sections 4 to 8).
Researched 2026-11-21 from primary sources. Labels: [verified: URL] means read on that page during this
research; [inferred] means our reasoning; "not found" means we looked and the source does not say.
Short quotes only. Where a fetch tool summarized a page, field names are as reported by that summary.

## 0. Sources

- ACP v1 schema: https://agentclientprotocol.com/protocol/schema
- ACP v1 pages: .../protocol/v1/tool-calls.md, .../v1/elicitation.md, .../v1/authentication.md; prompt turn: https://agentclientprotocol.com/protocol/prompt-turn
- ACP v2 (draft): .../protocol/v2/prompt-lifecycle.md, .../v2/cancellation.md, .../v2/overview.md; RFDs: https://agentclientprotocol.com/rfds/v2/permission-requests.md, https://agentclientprotocol.com/rfds/v2/idempotency-keys.md
- MCP versioning (current = 2026-07-28): https://modelcontextprotocol.io/specification/versioning
- MCP elicitation: https://modelcontextprotocol.io/specification/draft/client/elicitation
- MCP multi round-trip requests (MRTR): https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr
- MCP cancellation / progress / authorization / sampling at 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/cancellation , .../basic/patterns/progress.md , .../basic/authorization.md , .../client/sampling.md
- MCP Tasks extension: https://modelcontextprotocol.io/specification/draft/basic/utilities/tasks ; repo https://github.com/modelcontextprotocol/ext-tasks ; schema https://raw.githubusercontent.com/modelcontextprotocol/ext-tasks/main/schema/2026-07-28/schema.ts
- AG-UI: https://docs.ag-ui.com/concepts/events , https://docs.ag-ui.com/concepts/interrupts , https://docs.ag-ui.com/concepts/capabilities
- OpenAI Agents JS HITL: https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
- LangGraph interrupts: https://docs.langchain.com/oss/python/langgraph/interrupts
- Vercel AI SDK: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling , https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage
- Google ADK: https://adk.dev/tools-custom/confirmation/ , https://adk.dev/tools-custom/function-tools/
- A2A spec: https://a2a-protocol.org/latest/specification/

Not read: OpenAI Responses API raw approval item schema (only the Agents JS SDK guide), AG-UI full resume
semantics beyond the Interrupts page, A2A spec sections after the first ~100k characters.

## 1. Version snapshot (these moved a lot)

- MCP current revision is **2026-07-28**; it is stateless: every request carries
  `io.modelcontextprotocol/protocolVersion` and `.../clientCapabilities` in `_meta`, and the old
  `initialize` handshake belongs to "2025-11-25 and earlier". [verified: https://modelcontextprotocol.io/specification/versioning]
- MCP 2026-07-28 **replaced server-initiated requests** with multi round-trip requests (MRTR): "Servers MUST
  send server-to-client requests (such as roots/list, sampling/createMessage, or elicitation/create) using the
  MRTR pattern ... This is a breaking change." [verified: https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr]
- MCP **sampling is deprecated** as of 2026-07-28 (SEP-2577). [verified: https://modelcontextprotocol.io/specification/2026-07-28/client/sampling.md]
- MCP **Tasks is now an extension** (`io.modelcontextprotocol/tasks`, repo ext-tasks, schema 2026-07-28 "Stable"),
  not core. [verified: https://github.com/modelcontextprotocol/ext-tasks]
- ACP has **v1 (stable) and v2 (draft)** protocol docs; elicitation, request cancellation, message ids, session
  resume/close are announced as stabilized. [verified: https://agentclientprotocol.com/llms.txt (page index and announcements list)]
- A2A latest released is 1.0.0; states include INPUT_REQUIRED and AUTH_REQUIRED. [verified: https://a2a-protocol.org/latest/specification/]

## 2. Agent Client Protocol (ACP)

### 2.1 Permission request (v1)
- `session/request_permission` request: `sessionId`, `toolCall` (a `ToolCallUpdate`), `options` (`PermissionOption[]`), `_meta`.
  Response: `outcome`, `_meta`. [verified: https://agentclientprotocol.com/protocol/schema]
- `PermissionOption`: `optionId`, `name`, `kind`; kinds `allow_once`, `allow_always`, `reject_once`, `reject_always`. [verified: schema]
- Outcome is a tagged union: `{outcome: "cancelled"}` or `{outcome: "selected", optionId}`. [verified: schema]
- Scoping: "The Agent owns remembered decisions ... decides the scope (such as a tool, command, or directory)";
  `kind` is only a UI hint and "the option `name` should state the scope". Agent should not apply a remembered
  decision beyond its stated scope; auto-approval should not rely only on title or option name. [verified: https://agentclientprotocol.com/protocol/v1/tool-calls.md]
- Clients may auto-allow/reject per user settings. [verified: same]
- `ToolKind`: read, edit, delete, move, search, execute, think, fetch, switch_mode, other. `ToolCallStatus`: pending, in_progress, completed, failed. [verified: same]
- Tool call content variants: `content`, `diff` (`path`, `newText`, `oldText`), `terminal` (`terminalId`), `session`. [verified: schema]

### 2.2 Permission request (v2 draft)
- Top-level `toolCall` replaced by optional `subject` union; common `title` (required), optional `description`,
  `options`. Subject variants `tool_call` (`toolCallId`) and `command` (`command`, `cwd` absolute, optional
  `toolCallId`, `terminalId`). "Unknown future subject types should be preserved by proxying clients." [verified: https://agentclientprotocol.com/rfds/v2/permission-requests.md]
- Rule: agent must match the selected `optionId` against options offered; unoffered ids, unrecognized kinds and
  unknown outcomes "must not be treated as approval". Remembered reject affects later in-scope requests. [verified: same]
- Scoping of `allow_always`, timeouts: not specified in that RFD (not found).
- Motivation worth copying: agents stuffed prompt text into tool-call title, which corrupted the tool display. Keep prompt copy separate from the subject. [verified: same]
- Permission request is idempotent: on retry the client shows it again. [verified: https://agentclientprotocol.com/protocol/v2/overview.md]

### 2.3 Prompt, cancel, stop reasons, mid-turn input
- v1: `session/prompt` (request) returns a `stopReason`: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`. [verified: schema; https://agentclientprotocol.com/protocol/prompt-turn]
- v1 prompt-turn page does **not say** whether a new `session/prompt` may be sent mid-turn ("Once a prompt turn completes, the Client may send another"). [verified: prompt-turn page; the silence is the finding]
- v1 cancel: `session/cancel` notification (`sessionId`). Client must answer all pending permission requests with `cancelled`; agent must return `cancelled` stop reason and "MUST NOT surface [abort errors] as errors"; late updates must arrive before the prompt response. [verified: prompt-turn]
- **v2: mid-turn prompts are explicitly allowed.** "Clients MAY send `session/prompt` in any state"; "Agents MUST NOT reject a prompt only because foreground work is active." Agent inserts immediately or holds; held prompts inserted in receive order. Response (`messageId`) is sent when the message is **inserted**, "not when work finishes". Params `sessionId`, `prompt`, optional `idempotencyKey`. [verified: https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md]
- v2 steering semantics deliberately open: "What inserting during active work means, such as steering the current turn or starting the next one, is up to the Agent." Held prompts cannot be withdrawn (future capability); `session/cancel` drops held prompts with -32800. [verified: same]
- v2 turn end: an `idle` `state_update` with `stopReason` in `end_turn | max_tokens | max_turn_requests | refusal | cancelled | error`; `error` carries `error {code, message, data?}`; custom reasons start with `_`. Idle ends foreground work "even if background activity continues". [verified: v2 prompt-lifecycle, v2 overview]
- v2 cancel: `$/cancel_request` (`requestId`) plus `session/cancel`; on `session/cancel` the agent cancels each pending permission request with `$/cancel_request`; clients answer `cancelled` (permission) or `cancel` (elicitation); "Agents should ignore late answers"; cancelling one request "does not by itself cancel the whole foreground workflow". Error -32800 Request Cancelled. [verified: https://agentclientprotocol.com/protocol/v2/cancellation.md]
- v2 idempotency: `idempotencyKey` on `session/prompt`, 1 to 255 chars, client-generated (UUID), scoped to session, agent returns the original `messageId` on retry, held prompt retry gets same outcome, error leaves key unused, no dedicated conflict error, "does not guarantee the work finishes exactly once". [verified: https://agentclientprotocol.com/rfds/v2/idempotency-keys.md]

### 2.4 Session updates (v1 `sessionUpdate` discriminator)
`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`,
`plan_update`, `plan_removed`, `available_commands_update`, `current_mode_update`, `config_option_update`,
`session_info_update`, `usage_update`, `notice`, `compaction_update`, `compaction_summary_chunk`,
`subagent_update`, `session_message`, `session_message_chunk`. `messageId` appears on chunk updates.
`Plan.entries[]` with `content`, `priority` (high/medium/low), `status` (pending/in_progress/completed);
client replaces the whole checklist each update. [verified: https://agentclientprotocol.com/protocol/schema]

### 2.5 Capabilities and negotiation
- `initialize`: `protocolVersion` (client sends latest it supports; agent echoes or answers its latest). [verified: schema]
- `AgentCapabilities`: `loadSession` (bool), `promptCapabilities`, `mcpCapabilities`, `sessionCapabilities`, `auth`, `_meta`.
  `SessionCapabilities`: `list`, `resume`, `close`, `delete`, `additionalDirectories`, `systemPrompt`; "omitted or null means unsupported"; baseline methods are `session/new`, `session/prompt`, `session/cancel`, `session/update`. [verified: schema]
- `ClientCapabilities`: `fs {readTextFile, writeTextFile}`, `terminal`, `auth {terminal}`, `elicitation`, `plan`, `session`, `subagents`; each optional one omitted/null = unsupported. [verified: schema]
- Pattern: **presence of an object = support; object body carries sub-options**; booleans only for legacy items.
- v2: "The `session/*` methods require `capabilities.session`"; a non-empty `authMethods` implies the agent must implement `auth/login` and `auth/logout`; custom capabilities may be advertised. [verified: v2 overview]

### 2.6 Elicitation and auth
- `elicitation/create` sent agent to client, modes `form` and `url`; scope is `sessionId` (+ optional `toolCallId`) or `requestId`; `mode` required (no default); url mode has `url`, `elicitationId`, `message`; completion notification `elicitation/complete` with `elicitationId`. Based on the MCP 2026-07-28 RC elicitation spec. Actions accept/decline/cancel; `content` optional on accept. Must bind to connection and verified user, "A `sessionId` alone is not sufficient". [verified: https://agentclientprotocol.com/protocol/v1/elicitation.md]
- Capability: `clientCapabilities.elicitation.{form,url}` each by presence; "an empty capability does not imply form support" (stricter than MCP). If URL unsupported, must not fall back to form for sensitive flows. [verified: same]
- Auth: `authMethods[]` in initialize response with `id`, `name`, `description`, optional `type` (`agent` default, `terminal` with `args`, `env`); `authenticate {methodId}`; `logout`; `auth_required` error exists with no numeric code given. [verified: https://agentclientprotocol.com/protocol/v1/authentication.md]
- Client methods: `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release`. [verified: schema]
- Resume: `session/load` (needs `loadSession`; agent replays history via notifications) vs `session/resume` (needs `sessionCapabilities.resume`; no history replay). [verified: schema]

## 3. MCP (revision 2026-07-28, draft pages)

### 3.1 Elicitation
- Request params: `mode` (`form`|`url`), `message`; form adds `requestedSchema` (flat object, primitives only: string with `format` email/uri/date/date-time, number/integer, boolean, enums single/multi with `oneOf`/`anyOf` of `{const,title}`, `default`); url adds `url`. [verified: https://modelcontextprotocol.io/specification/draft/client/elicitation]
- Result `action`: `accept` (with `content` for form), `decline` (explicit no), `cancel` (dismissed without choice). [verified: same]
- Capability per request in `_meta."io.modelcontextprotocol/clientCapabilities".elicitation {form, url}`; empty object = form only; "Servers MUST NOT send elicitation requests with modes that are not supported". [verified: same]
- Security: no secrets via form mode; use URL mode (no prefetch, show full URL, consent first, credentials never transit the client); bind elicitation to user identity. [verified: same]
- In this revision elicitation is delivered **inside** `InputRequiredResult.inputRequests` of a pending client request, not as a free-standing server request. [verified: same + MRTR page]

### 3.2 MRTR (the core mechanism)
- `InputRequiredResult { resultType: "input_required", inputRequests?: map<key, request>, requestState?: string }`; client retries the original request with `inputResponses` (same keys) and echoes `requestState` verbatim, with a **new JSON-RPC id**. Keys are "server assigned identifiers ... unique within the scope of the request". At least one of the two fields must be present. [verified: https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr]
- `requestState` is attacker-controlled: protect with HMAC/AEAD, bind principal, short expiry, originating request digest; "do not by themselves guarantee single-use" so one-time redemptions must be enforced server-side. [verified: same]
- Missing answers: server "SHOULD respond with a new `InputRequiredResult`" rather than error; unknown extra keys ignored. Declined sampling needs no error replay "as the server is not waiting". [verified: MRTR; sampling page]
- Applies to `tools/call`, `prompts/get`, `resources/read` only. [verified: MRTR]

### 3.3 Tasks extension (long-running + input_required)
- Statuses: `working`, `input_required`, `completed`, `failed`, `cancelled`; last three terminal. `Task { taskId, status, statusMessage?, createdAt, lastUpdatedAt, ttlMs|null, pollIntervalMs? }`. `CreateTaskResult` has `resultType: "task"`. [verified: ext-tasks schema.ts]
- `tasks/get` returns a discriminated `DetailedTask`: `InputRequiredTask` carries `inputRequests`, `CompletedTask` carries `result`, `FailedTask` carries `error` (JSON-RPC error object). `tasks/update {taskId, inputResponses}` answers; "Ignore responses for unknown or already-satisfied keys"; `tasks/cancel {taskId}` is "cooperative"; `notifications/tasks` pushes full task state; polling is default. [verified: schema.ts; https://modelcontextprotocol.io/specification/draft/basic/utilities/tasks]
- Crash resilience: "A task ID is a durable handle ... Store task IDs durably". Task "durably created before the response is sent". [verified: tasks page]
- Capability: extension key `io.modelcontextprotocol/tasks` in per-request client capabilities and server `server/discover`; server "Never return a task to a client that did not declare support"; server decides per request whether to create a task. [verified: tasks page]
- Steering / mid-run caller input other than answers to inputRequests: not found.

### 3.4 Cancel, progress, timeouts
- `notifications/cancelled {requestId, reason?}`; on Streamable HTTP closing the stream is cancellation; servers "SHOULD stop processing ... Not send a response"; may ignore unknown/completed; race conditions must be handled. [verified: https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/cancellation]
- Timeouts: senders SHOULD set per-request timeouts; may reset clock on progress but "SHOULD always enforce a maximum timeout". [verified: same]
- Progress: `notifications/progress {progressToken, progress, total?, message?}`; progress must increase. [verified: .../progress.md]

### 3.5 Authorization
- Transport-level OAuth 2.1 for HTTP only; stdio "SHOULD NOT follow this specification, and instead retrieve credentials from the environment". 401 + `WWW-Authenticate` with `resource_metadata` and `scope`; 403 `insufficient_scope` with required `scope` drives step-up; PRM (RFC 9728), Client ID Metadata Documents preferred, DCR deprecated, `resource` param RFC 8707. [verified: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md]
- Third-party (server-to-service) auth is done via **URL-mode elicitation**, kept separate from MCP auth. [verified: elicitation page]

### 3.6 Sampling
- `sampling/createMessage` (messages, modelPreferences, systemPrompt, maxTokens, tools, toolChoice); capability `sampling {tools?, context?}`; **deprecated** in 2026-07-28. Not relevant to our model beyond noting the churn. [verified: sampling page]

## 4. AG-UI

- Events (PascalCase): RunStarted, RunFinished, RunError, StepStarted/Finished, TextMessageStart/Content/End/Chunk, ToolCallStart/Args/End/Result/Chunk, StateSnapshot, StateDelta (RFC 6902), MessagesSnapshot, ActivitySnapshot/Delta, Reasoning*, Custom, Raw, Subagent*; all accept `timestamp`, `rawEvent`, `metadata`. [verified: https://docs.ag-ui.com/concepts/events]
- `RunStarted {threadId, runId, parentRunId?, input?}`. `RunFinished {outcome?, result?}` where `outcome` is `{type:"success"}` or `{type:"interrupt", interrupts:[...]}`; omitted outcome = legacy success. [verified: same]
- `Interrupt {id, reason, message?, toolCallId?, responseSchema?, expiresAt?, metadata?, subagentRunId?}`; `reason` core values `tool_call`, `input_required`, `confirmation`, custom `<framework>:<name>`. [verified: https://docs.ag-ui.com/concepts/interrupts]
- Resume = **a new run** on the same `threadId` whose input has `resume: [{interruptId, status: "resolved"|"cancelled", payload?, metadata?}]`. Denials go in the payload ("approved: false"), not in `status`. One resume array must cover **all** open interrupts; pending interrupts without a resume produce `RunError`; identical resume `(threadId, interruptId, status, payload)` "must be safe to replay"; stale past `expiresAt` produces `RunError`. [verified: same]
- Persistence: before the interrupting `RunFinished` the agent must emit `StateSnapshot` and `MessagesSnapshot`, making resume independent of framework checkpointing ("an optimization, not a protocol requirement"). [verified: same]
- Capabilities: `getCapabilities()` returns categories (identity, transport, tools, output, state, multiAgent, reasoning, multimodal, execution, humanInTheLoop, custom); `humanInTheLoop {supported, approvals, interventions, feedback, interrupts, approveWithEdits}`; transport has `resumable`; **omitted means undeclared, `false` means explicitly disabled**; "Clients should gate on an explicit `true`". [verified: https://docs.ag-ui.com/concepts/capabilities]
- Steering mid-run: not found as a distinct concept (new input is a new run; pending interrupts must be resolved first).

## 5. OpenAI Agents SDK (JS) human-in-the-loop

- Tool `needsApproval: true | async (input) => boolean`; run pauses, returns `interruptions`; `result.state.approve(interruption)` / `.reject(interruption, {message})`; `{alwaysApprove: true}` / `{alwaysReject: true}` makes the decision sticky "for that tool for the rest of the run"; an exact per-call decision overrides sticky; partial resolution re-pauses. Interruption items are `RunToolApprovalItem` (class name from API index). [verified: https://openai.github.io/openai-agents-js/guides/human-in-the-loop/]
- Resume: `run(agent, state)`. Persist with `state.toString()` and `RunState.fromString(agent, saved)` (also `fromStringWithContext` with `contextStrategy` merge/replace), so a process restart is supported by serializing the whole run state. `fromString()` "does not authenticate the snapshot"; keep server-side. [verified: same]
- Mid-run/while-paused input: `state.addInput(...)` stages input before the next model call; `pendingInput`, `clearPendingInput()`; throws if the state cannot safely reach another model call. [verified: same] This is the closest published shape to our "steer while waiting".
- Streaming: after a streamed pause wait for `stream.completed`, read `stream.interruptions`, resolve, call `run()` again with `{stream: true}`. [verified: same]
- Responses API raw approval item shape: not found (not read).

## 6. LangGraph interrupts

- `interrupt(value)` pauses; `Command(resume=value)` becomes the return value of `interrupt()`; needs a checkpointer and `thread_id`; durable checkpointer required in production. [verified: https://docs.langchain.com/oss/python/langgraph/interrupts]
- Parallel interrupts: each `Interrupt` has `id`; resume with a map `{interrupt.id: value}` in one call. Pending ones visible at `result["__interrupt__"]` / `stream.interrupts`. `Interrupt` fields `value`, `id`, optional `response_schema` (langgraph>=1.2.12). [verified: same]
- **Re-execution rule**: on resume the node restarts from its beginning, code before `interrupt()` runs again; matching is index-based; side effects must be idempotent. [verified: same]
- Steering mid-run: not found (resume is the only input).

## 7. Vercel AI SDK tool approval

- `toolApproval` on `generateText`/`streamText`/`ToolLoopAgent`: statuses `not-applicable`, `approved`, `denied`, `user-approval`, object form `{type, reason}`; older `needsApproval` deprecated. The call **does not pause**: it returns `tool-approval-request` parts (`approvalId`, `toolCall`, `reason`, `isAutomatic`); caller appends a `tool-approval-response {approvalId, approved, reason?}` as a `tool` message and calls again. Denial reason goes to the model via `execution-denied`; approval reason is audit-only. [verified: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling]
- UI part states: `input-streaming`, `input-available`, `approval-requested`, `approval-responded`, `output-available`, `output-denied`, `output-error`; `addToolApprovalResponse({id, approved})`. Automatic decisions are recorded as request+response with `isAutomatic: true` (good audit trail). [verified: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage]
- Resume after restart: stateless, because the full message history carries the approval state; server-side verification via `experimental_toolApprovalSecret`. Reload behavior of pending approvals: not found. [verified: same + not found]
- Steering: not found.

## 8. Google ADK

- Confirmation: `require_confirmation` on `FunctionTool`, or `tool_context.request_confirmation(hint, payload)`; response read from `tool_context.tool_confirmation` with `confirmed` and `payload`. Remote path: an `adk_request_confirmation` FunctionCall event with `function_call_id`; the client replies with a `function_response` (`name: adk_request_confirmation`, `id` = that call id, `response: {confirmed, payload}`). [verified: https://adk.dev/tools-custom/confirmation/]
- Resume: with the Resume feature include the `invocation_id` of the original invocation, otherwise "the system starts a new invocation". Limitations: not supported with `DatabaseSessionService` or `VertexAiSessionService`; experimental in TypeScript, Go, Kotlin. [verified: same] Surprise: persistence-backed sessions are the ones that cannot do confirmation.
- Long-running tools: `LongRunningFunctionTool` returns an initial pending result (ticket/job id), the run pauses, and the client later sends an intermediate or final `FunctionResponse` with the original function call id (plus `invocation_id`). [verified: https://adk.dev/tools-custom/function-tools/]
- Steering: not found.

## 9. A2A (our target) facts that constrain the model

- States: SUBMITTED, WORKING, COMPLETED, FAILED, CANCELED, INPUT_REQUIRED, REJECTED, AUTH_REQUIRED; terminal = COMPLETED/FAILED/CANCELED/REJECTED; interrupted = INPUT_REQUIRED/AUTH_REQUIRED. [verified: https://a2a-protocol.org/latest/specification/ (4.1.3)]
- Message to a non-terminal task: "Agents MAY accept additional messages for tasks in non-terminal states to enable multi-turn interactions" (3.3.3); terminal tasks reject with UnsupportedOperationError; INPUT_REQUIRED continues with a new message carrying the same taskId/contextId. Behavior for a WORKING task is left optional by the text read. [verified: same]
- CancelTask: success not guaranteed; errors TaskNotCancelableError / TaskNotFoundError; idempotent. [verified: same]
- Extensions negotiated via `A2A-Extensions` service parameter; `ExtensionSupportRequiredError`. [verified: same]

## 10. Comparison table

| Protocol | Permission shape | Question / form shape | Auth | Steering / mid-run input | Cancel | Resume / persistence | Capability negotiation |
|---|---|---|---|---|---|---|---|
| ACP v1/v2 | `session/request_permission`; options `{optionId,name,kind}` kinds allow/reject x once/always; outcome `selected{optionId}` or `cancelled`; v2 adds `title`, `description`, `subject` union | `elicitation/create` form (flat schema) / url; accept/decline/cancel | `authMethods[]`, `authenticate{methodId}`, terminal auth, `logout`; `auth_required` error; url elicitation for third parties | v1 silent; **v2 allows `session/prompt` in any state, agent inserts or holds, `messageId` returned on insertion, meaning agent-defined** | `session/cancel` (turn), `$/cancel_request` (one request); stop reason `cancelled`; pending permissions auto-cancelled | `session/load` (replay), `session/resume` (no replay); `idempotencyKey` on prompt (v2) | `initialize` + presence-of-object capabilities (`sessionCapabilities.resume`, `clientCapabilities.elicitation.form`) |
| MCP 2026-07-28 | none (sampling/tool approval is client UX) | `elicitation/create` inside `InputRequiredResult.inputRequests`; form schema flat primitives + enums; accept/decline/cancel | transport OAuth 2.1 (401/403 + WWW-Authenticate); third-party via URL elicitation | not found; Tasks `tasks/update` only answers `inputRequests` | `notifications/cancelled{requestId}` / stream close; Tasks `tasks/cancel` cooperative | MRTR `requestState` (stateless, signed) ; Tasks durable `taskId` + `tasks/get` | per-request `_meta` capabilities; extensions map; `server/discover` |
| AG-UI | `Interrupt{reason:"tool_call",toolCallId,...}`; denial in payload | `Interrupt{reason:"input_required", responseSchema}` | not found (reason `input_required`/custom) | not found; new run, pending interrupts must be resumed first | `status:"cancelled"` per interrupt; RunError | resume = new run with `resume[]`, replay-safe, `expiresAt`, snapshots before interrupt | `getCapabilities()` categories; omitted vs false; `humanInTheLoop.interrupts/approveWithEdits` |
| OpenAI Agents JS | `needsApproval`, `approve/reject(+alwaysApprove/Reject, message)` | not found (approval only) | not found | `state.addInput()` while paused | not found | `RunState.toString/fromString` | not found |
| LangGraph | `interrupt(value)` (free-form) | same; `response_schema` | not found | not found | not found | checkpointer + `thread_id`; `Command(resume)`; node re-runs | not found |
| Vercel AI SDK | `tool-approval-request/response {approvalId, approved, reason}`, `isAutomatic` | tool without `execute`, client supplies result | not found | not found | not found | stateless via message history | not found |
| Google ADK | `require_confirmation`, `ToolConfirmation{confirmed,payload}` via `adk_request_confirmation` | `request_confirmation(hint,payload)` | not found | not found | not found | `invocation_id` match; unsupported with DB/Vertex sessions | not found |
| A2A 1.0 (target) | none; state INPUT_REQUIRED + message | same | AUTH_REQUIRED | optional extra messages for non-terminal tasks | CancelTask, not guaranteed | task store; push configs | agent card capabilities + extensions |

## 11. Cross-cutting patterns

- **Capability negotiation without boolean sprawl.** Three proven styles: (a) presence-of-object (ACP `sessionCapabilities.resume = {}`, `elicitation.form = {}`; omitted/null = unsupported); (b) extension keys (MCP `io.modelcontextprotocol/tasks`, A2A `A2A-Extensions`); (c) AG-UI tri-state (omitted = undeclared, `false` = disabled, gate on `=== true`). Common rule: the sender must not use what the peer did not declare (MCP: "MUST NOT send ... modes that are not supported"; ACP: request returns -32602). Our design (handler implemented = supported) matches (a) in spirit. [verified: sections 2.5, 3.1, 4]
- **Option schemas for approvals.** ACP's `kind` x `once|always` is the only one with explicit scope semantics, and it puts scope in the human text, not a field (`name` should state it). OpenAI adds sticky per-run scope (`alwaysApprove` "for that tool for the rest of the run"). Nobody defines a machine-readable scope object (not found). Safety rule worth copying: never treat unknown option ids, unknown kinds or unknown outcomes as approval (ACP v2 RFD). [verified: 2.1, 2.2, 5]
- **Pending-interaction persistence.** Four strategies: signed opaque state echoed by the client (MCP `requestState`), durable server-side id (MCP Tasks `taskId`, AG-UI `threadId` + snapshots, LangGraph checkpointer), whole-state serialization (OpenAI `RunState`), message-history-as-state (Vercel). Each has a replay hazard: LangGraph re-executes the node from the start, so side effects must be idempotent. [verified: 3.2, 3.3, 4, 5, 6, 7]
- **Timeouts/defaults when nobody answers.** Explicit protocol rules are thin: AG-UI `expiresAt` (stale resume = error); MCP says set request timeouts and keep a max timeout regardless of progress; ACP v2 permission RFD says nothing on timeouts. Nobody specifies "default answer on timeout". Treat as our policy, not borrowed. [verified: 3.4, 4, 2.2]
- **Idempotent replies.** AG-UI: identical `(threadId, interruptId, status, payload)` safe to replay. MCP Tasks: responses for "unknown or already-satisfied keys" ignored. ACP: `idempotencyKey` for prompts, late answers after cancel ignored, retried permission request is just re-shown. [verified: 4, 3.3, 2.3]
- **Correlation ids.** Server-assigned keys unique within the request (MCP `inputRequests`), `interruptId` (AG-UI), `approvalId` (Vercel), `function_call_id` (ADK), `toolCallId` (ACP, binds permission to the tool call), `elicitationId` (ACP/MCP url completion), `messageId` (ACP). [verified: sections above]
- **Streaming + interruption.** ACP: permission request is a request issued mid-stream; cancel resolves it as `cancelled` and remaining updates still precede the prompt response. AG-UI: stream ends with `RunFinished(outcome=interrupt)` and resume starts a fresh run. OpenAI: wait for `stream.completed`, then re-run. MCP: the request terminates with `input_required` and is retried. Two models: **in-band pending request** (ACP) vs **end the run and start a new one** (AG-UI, OpenAI, MCP MRTR, LangGraph). [verified: 2.3, 4, 5, 3.2]

## 12. Gaps and surprises

1. MCP removed server-initiated requests in 2026-07-28; elicitation now only happens as a retry of a pending client request (MRTR), and MCP Tasks `input_required` is answered by `tasks/update`. A2A's INPUT_REQUIRED + follow-up message is structurally the same as MRTR/Tasks, which supports our design. [verified: MRTR page, tasks page]
2. ACP v2 explicitly rejects "reject mid-turn prompts" and leaves steering semantics to the agent ("up to the Agent"). That is exactly our "implemented handler decides" stance. ACP v1 is silent. [verified: v2 prompt-lifecycle]
3. No protocol offers a typed steering outcome like `accepted | queued | rejected`. ACP v2 returns only `messageId` at insertion; "inserted" is the acceptance point and held vs immediate is not reported. Our outcome enum is new design; borrow ACP's "acceptance = insertion" and `messageId` instead. [verified: v2 prompt-lifecycle; "no steering outcome type" = not found]
4. Machine-readable scope for `allow_always`: not found anywhere. ACP leaves it to agent and option name.
5. Auth is modeled three different ways: ACP method list + terminal flow, MCP HTTP-layer OAuth (not in-protocol; stdio uses env), MCP/ACP URL-mode elicitation for third-party. None puts auth in a permission-like option list. A2A's AUTH_REQUIRED has no schema for the data part (not found in the portion read).
6. ADK confirmation does not work with persistent session services; durable resume for ADK would need our own persistence. [verified: ADK page]
7. MCP sampling is deprecated; do not model "agent asks caller's LLM" as a first-class interaction.
8. Timeout defaults: not found in any protocol.
9. ACP `decline` vs `cancel` (MCP/ACP elicitation) is a deliberate distinction: explicit no vs dismissed. ACP permission only has reject kinds vs `cancelled`. AG-UI collapses denial into payload and keeps `status` for resolved/cancelled.

## 13. Recommended shapes for our core vocabulary

1. **Permission options: copy ACP's `{optionId, name, kind}` with kinds `allow_once | allow_always | reject_once | reject_always`**, and ACP's outcome union `selected{optionId} | cancelled`. Reason: only proven permission option shape; `kind` is a UI hint, `optionId` is the correlation. Add an optional machine-readable `scope` field (ours; not found elsewhere) so core can implement "always" itself, and keep the human `name` stating the scope as ACP advises. Enforce ACP v2's rule: unknown option id/kind/outcome is never approval. [inferred from 2.1, 2.2]
2. **CoreInteraction: replace our `kind` list with a common envelope plus subject, as ACP v2 did.** `{id, title, description?, subject?, options?, responseSchema?, expiresAt?}` where `id` is the correlation key (AG-UI `Interrupt.id`, MCP `inputRequests` key). Reason: ACP found that coupling prompt text to the tool call corrupted display; AG-UI `reason` (`tool_call | input_required | confirmation`) is a small routing enum we can keep as `kind`. Preserve unknown subjects/kinds losslessly (ACP v2: proxying clients preserve unknown subjects; matches our `unknown` escape hatch). [inferred]
3. **Questions/forms: adopt MCP's elicitation schema subset** (flat object, primitives, enums via `oneOf` of `{const,title}`, `default`) as `responseSchema`, and **MCP/ACP result actions `accept | decline | cancel`** with `content`, instead of our `answered/declined/timeout/canceled`. Reason: widely implemented, and `decline` (explicit no) vs `cancel` (dismissed) matters for provider fallbacks. Add `timeout` and `expired` as core-originated outcomes (not in any spec; they are policy). Secrets and auth credentials must never use form mode; use a URL-style `auth` interaction with `url` plus `elicitationId`-like completion, per MCP/ACP. [verified rationale: 3.1, 2.6; timeout = inferred]
4. **Pending interactions and replies: model on MCP Tasks + AG-UI.** Persist `{interactionId, taskId, kind, payload, expiresAt, status}` in the TaskStore; core state `input-required`/`auth-required` is the A2A projection of MCP `input_required`. Replies are idempotent on `(taskId, interactionId, outcome, payload)` (AG-UI rule 5) and ignore unknown or already-satisfied ids (MCP Tasks). Support multiple concurrent open interactions keyed by id (AG-UI/LangGraph map-by-id), but decide whether partial answers are allowed (AG-UI says no; MCP says re-ask for the missing ones, which is friendlier). Resume = new `run`/`resume` call keyed by task id, never a replay of side-effecting code (LangGraph hazard). [inferred from 3.3, 4, 6]
5. **Steering: borrow ACP v2's contract and add our outcome.** Steering input gets a core `messageId` (ACP) and an optional client `idempotencyKey` (ACP v2: 1 to 255 chars, per task scope, same id returned on retry). Outcome enum stays ours but should be defined as "when is it inserted": `inserted` (accepted into the running turn), `held` (ordered queue, inserted later, ACP "held prompts inserted in receive order"), `rejected(reason)`. Cancel drops held messages (ACP). While paused for an interaction, an OpenAI-style staged input (`addInput`) is the shape for "message arrives during input-required that is not the answer". [verified rationale: 2.3, 5; enum naming = inferred]
6. **Cancel and stop reasons: ACP cancel semantics plus MCP's cooperative framing.** On cancel, core resolves every pending interaction as `cancelled` (ACP: pending permissions answered `cancelled`; late answers ignored), ends with stop reason `cancelled` rather than an error, and treats `TaskNotCancelable` as the A2A default when no `abortBackend` exists. Use ACP v2 stop reasons as the run-end vocabulary `end_turn | max_tokens | max_turn_requests | refusal | cancelled | error` (with `_`-prefixed custom values) inside `CoreResult.meta`. [verified rationale: 2.3, 9]
7. **Capability declaration: stay with handler-presence internally, but export it as presence-of-object/tri-state like ACP and AG-UI.** Core derives a `CoreCapabilities` document from which handlers exist, e.g. `{interactions: {form: {}, url: {}, permission: {}}, steering: {}, resume: {}, cancel: {}}`: object present = supported, absent = unsupported, plus AG-UI's rule "omitted = undeclared, false = disabled" if we ever need an explicit off. Callers gate on presence; core never sends an interaction kind or mode the connected caller did not declare (MCP/ACP rule; ACP returns -32602). Extension URIs go through A2A's `A2A-Extensions` negotiation, not our own flags. [inferred from 2.5, 3.1, 4]
8. **Auth interaction: do not invent a credentials-in-form path.** Keep `kind:"auth"` as `{service, url, instructions?, elicitationId}` (MCP/ACP URL mode: user consent, full URL shown, no credentials through the client), map it to A2A `AUTH_REQUIRED`, and follow the MCP rule that the person completing the URL is the same authenticated principal that started the task. For transport auth use HTTP 401/403 `WWW-Authenticate` + `scope` step-up semantics. [verified rationale: 2.6, 3.1, 3.5]
9. **Timeouts/defaults are our policy, not borrowed.** Put `expiresAt` on the interaction (AG-UI) and a core-configured default outcome (`reject_once`-equivalent for permissions, `cancel` for forms); record automatic decisions as ordinary request+response with `isAutomatic: true` (Vercel AI SDK) so audit and UI treat them the same. [inferred from 7, 4]
10. **Correlation: one id family.** `interactionId` (opaque, unique within task), `toolCallId` on the subject (ACP/AG-UI), `messageId` for steering (ACP), `taskId`/`contextId` as in A2A; any signed echo-back token (MCP `requestState`) must carry principal, expiry and request digest and still be single-use enforced server-side. [verified rationale: 3.2]
