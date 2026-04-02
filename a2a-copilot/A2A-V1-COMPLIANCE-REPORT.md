# A2A Protocol v1.0 Compliance Report — `a2a-copilot`

**Generated:** 2 April 2026  
**Spec Version:** [A2A Protocol v1.0.0](https://a2a-protocol.org/latest/whats-new-v1/) (released 12 March 2026)  
**SDK Version in Use:** `@a2a-js/sdk ^0.3.9` → resolves to `0.3.13` (latest on npm as of 16 March 2026)  
**Project Version:** `a2a-copilot` v1.0.1  

---

## Executive Summary

| Category | Count |
|---|---|
| **Critical gaps (breaking, cannot ship as-is for v1.0 clients)** | 4 |
| **High-impact gaps (required for spec compliance)** | 5 |
| **Medium-impact gaps (important but not client-blocking)** | 3 |
| **Low-impact gaps / Nice-to-have v1.0 features** | 4 |
| **Blocked pending SDK v1.0 release** | 6 |
| **Already compliant / Not applicable** | 5 |

> **Key caveat:** The JS SDK (`@a2a-js/sdk`) has NOT yet shipped a v1.0-compatible release. Several breaking changes are technically impossible to implement today because the SDK's TypeScript types still reflect v0.3.x semantics. These are marked **SDK-BLOCKED** below. Once the SDK publishes its v1.0 release, the remaining items become directly actionable.

---

## Findings by Impact Level

---

### 🔴 CRITICAL — Must Fix Before Claiming v1.0 Compliance

---

#### C-1 · AgentCard `url` + `protocolVersion` structure

**Status:** Out of compliance  
**Spec reference:** [AgentCard Object changes](https://a2a-protocol.org/latest/whats-new-v1/#agentcard-object), Breaking Change #3  
**Files:** `src/server/agent-card.ts`, `src/config/types.ts`, `agents/*/config.json`

**What changed in v1.0:**
The `url` top-level field on `AgentCard` is removed. `protocolVersion` is no longer a top-level `AgentCard` field. Both are replaced by a `supportedInterfaces[]` array where each entry has `{ url, protocolBinding, protocolVersion }`.

**Current code (`src/server/agent-card.ts` lines 29–47):**
```typescript
const card: AgentCard = {
  url: `${baseUrl}/a2a/jsonrpc`,           // ❌ removed in v1.0
  protocolVersion: agentCard.protocolVersion ?? "0.3.0",  // ❌ removed in v1.0
  capabilities: {
    stateTransitionHistory: ...,            // ❌ removed in v1.0
  },
  ...
};
```

**Required v1.0 structure:**
```typescript
const card: AgentCard = {
  supportedInterfaces: [
    {
      url: `${baseUrl}/a2a/jsonrpc`,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    }
  ],
  capabilities: {
    streaming: ...,
    pushNotifications: ...,
    extendedAgentCard: false,    // replaces supportsAuthenticatedExtendedCard
    // stateTransitionHistory removed
  },
  ...
};
```

**Work items:**
1. Update `buildAgentCard()` in `agent-card.ts` — replace `url` + `protocolVersion` with `supportedInterfaces[]`
2. Remove `stateTransitionHistory` from `capabilities`
3. Rename `supportsAuthenticatedExtendedCard` usage (if any) → `capabilities.extendedAgentCard`
4. Update `AgentCardConfig` interface in `config/types.ts` — deprecate `protocolVersion`, `stateTransitionHistory`; add `supportedInterfaces` support
5. Update all `agents/*/config.json` files: remove `protocolVersion: "0.3.0"`, `stateTransitionHistory`

> **SDK-BLOCKED:** The `AgentCard` TypeScript type from `@a2a-js/sdk` currently still exposes `url` and `protocolVersion` as top-level fields. Once the SDK ships v1.0 types, update the import and card builder together.

---

#### C-2 · `Part` objects use `kind` discriminator (removed in v1.0)

**Status:** Out of compliance  
**Spec reference:** [Part Object — BREAKING CHANGE — Complete Redesign](https://a2a-protocol.org/latest/whats-new-v1/#part-object)  
**Files:** `src/copilot/event-publisher.ts`

**What changed in v1.0:**
`TextPart`, `FilePart`, and `DataPart` with a `kind` discriminator field are completely removed. A single unified `Part` type uses member-presence discrimination (`"text" in part`, `"url" in part`, `"raw" in part`, `"data" in part`). The `mimeType` field is renamed to `mediaType`.

**Current code (`src/copilot/event-publisher.ts`):**
```typescript
parts: [{ kind: "text", text: messageText }]   // ❌ kind is removed
parts: [{ kind: "text", text }]                 // ❌ everywhere
```

**Required v1.0:**
```typescript
parts: [{ text: messageText, mediaType: "text/plain" }]  // ✅ no kind field
```

**Work items:**
1. Replace all `{ kind: "text", text: "..." }` → `{ text: "...", mediaType: "text/plain" }` in `event-publisher.ts`
2. Replace any `{ kind: "file", file: { fileWithUri, mimeType } }` → `{ url: "...", mediaType: "...", filename: "..." }`
3. Update part-type discriminator logic in executor (any `part.kind === "text"` checks) → `"text" in part`

> **SDK-BLOCKED:** Part types exported from `@a2a-js/sdk` still use `kind` + separate `TextPart`/`FilePart`/`DataPart`. This change requires SDK v1.0 types first.

---

#### C-3 · `Message` objects carry `kind: "message"` field (removed in v1.0)

**Status:** Out of compliance  
**Spec reference:** [Message Object changes](https://a2a-protocol.org/latest/whats-new-v1/#message-object)  
**Files:** `src/copilot/event-publisher.ts`

**What changed in v1.0:**
Messages no longer have a top-level `kind` discriminator. The `role` enum changed from `"user"` / `"agent"` → `"ROLE_USER"` / `"ROLE_AGENT"` (SCREAMING_SNAKE_CASE with prefix).

**Current code (`src/copilot/event-publisher.ts` ~line 37):**
```typescript
message: {
  kind: "message",          // ❌ kind removed in v1.0
  messageId: uuidv4(),
  role: "agent",            // ❌ must be "ROLE_AGENT" in v1.0
  parts: [{ kind: "text", text: messageText }],
  contextId,
},
```

**Required v1.0:**
```typescript
message: {
  messageId: uuidv4(),
  role: "ROLE_AGENT",        // ✅
  parts: [{ text: messageText, mediaType: "text/plain" }],  // ✅
  contextId,
},
```

**Work items:**
1. Remove `kind: "message"` from all message literals in `event-publisher.ts`
2. Change `role: "agent"` → `role: "ROLE_AGENT"` everywhere
3. If user messages are constructed anywhere, change `role: "user"` → `role: "ROLE_USER"`

> **SDK-BLOCKED:** `Message` TypeScript type from SDK still uses the `kind` field and lowercase role enum. Fix alongside SDK upgrade.

---

#### C-4 · `TaskState` enum values use lowercase (changed to SCREAMING_SNAKE_CASE)

**Status:** Out of compliance  
**Spec reference:** [Enum Value Changes (HIGH IMPACT)](https://a2a-protocol.org/latest/whats-new-v1/#5-enum-value-changes-high-impact)  
**Files:** `src/copilot/event-publisher.ts`, `src/copilot/executor.ts`

**What changed in v1.0:**
All `TaskState` enum values changed from lowercase → `TASK_STATE_` prefixed SCREAMING_SNAKE_CASE.

**Mapping:**
| v0.3.0 | v1.0 |
|---|---|
| `"submitted"` | `"TASK_STATE_SUBMITTED"` |
| `"working"` | `"TASK_STATE_WORKING"` |
| `"completed"` | `"TASK_STATE_COMPLETED"` |
| `"failed"` | `"TASK_STATE_FAILED"` |
| `"canceled"` | `"TASK_STATE_CANCELED"` |
| `"rejected"` | `"TASK_STATE_REJECTED"` |
| `"input-required"` | `"TASK_STATE_INPUT_REQUIRED"` |
| `"auth-required"` | `"TASK_STATE_AUTH_REQUIRED"` |

**Current code (in `event-publisher.ts` and `executor.ts`):**
```typescript
publishStatus(bus, taskId, contextId, "working", ...)   // ❌ -> TASK_STATE_WORKING
publishStatus(bus, taskId, contextId, "completed", ...)  // ❌ -> TASK_STATE_COMPLETED
publishStatus(bus, taskId, contextId, "failed", ...)     // ❌ -> TASK_STATE_FAILED
status: { state: "submitted", ... }                      // ❌ -> TASK_STATE_SUBMITTED
```

**Work items:**
1. Update the `state` parameter type in `publishStatus()` from the union of lowercase strings → `"TASK_STATE_WORKING" | "TASK_STATE_FAILED" | "TASK_STATE_COMPLETED" | "TASK_STATE_CANCELED"`
2. Update all call sites in `executor.ts` to use the new enum values
3. Update `executor.ts` line ~222 Task publish: `state: "TASK_STATE_SUBMITTED"`

> **SDK-BLOCKED:** `TaskState` type in SDK still uses lowercase. Once SDK exports new enum, use that instead of raw strings.

---

### 🟠 HIGH IMPACT — Required for Proper v1.0 Server Behavior

---

#### H-1 · `final` field in `TaskStatusUpdateEvent` (removed in v1.0)

**Status:** Out of compliance  
**Spec reference:** [Send Streaming Message changes](https://a2a-protocol.org/latest/whats-new-v1/#send-streaming-message-messagestream-sendstreamingmessage)  
**Files:** `src/copilot/event-publisher.ts`

**What changed in v1.0:**
The `final` boolean field is removed from `TaskStatusUpdateEvent`. Stream termination is now signaled by the SSE stream being closed (protocol-level mechanism), not by a field on the event.

**Current code (`src/copilot/event-publisher.ts` ~line 23):**
```typescript
export function publishStatus(
  bus: ExecutionEventBus,
  ...
  final = false,        // ❌ field removed in v1.0
): void {
  const event: TaskStatusUpdateEvent = {
    kind: "status-update",
    ...
    final,              // ❌ should not be sent
  };
```

**Work items:**
1. Remove `final` parameter from `publishStatus()`
2. Remove `final` field from the `TaskStatusUpdateEvent` literal
3. Audit all call sites — `publishStatus(..., true)` calls relied on this; the stream closure now signals finality automatically via the SDK's bus behavior

> **SDK-BLOCKED:** SDK type must remove `final` first for TypeScript to accept this.

---

#### H-2 · `kind` discriminator in `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent` (removed)

**Status:** Out of compliance  
**Spec reference:** [Stream Event Objects changes](https://a2a-protocol.org/latest/whats-new-v1/#stream-event-objects)  
**Files:** `src/copilot/event-publisher.ts`

**What changed in v1.0:**
Stream events no longer have a `kind` field. Discrimination uses the wrapper JSON member name: `{ "taskStatusUpdate": { ... } }` vs `{ "taskArtifactUpdate": { ... } }`.

**Current code:**
```typescript
const event: TaskStatusUpdateEvent = {
  kind: "status-update",   // ❌ removed
  taskId, contextId, status, final,
};

const event: TaskArtifactUpdateEvent = {
  kind: "artifact-update", // ❌ removed
  taskId, contextId, ...
};
```

**Required v1.0 (wire format sent by SDK):**
```json
{ "taskStatusUpdate": { "taskId": "...", "contextId": "...", "status": { ... } } }
{ "taskArtifactUpdate": { "taskId": "...", "contextId": "...", "artifact": { ... }, "index": 0 } }
```

**Work items:**
1. Remove `kind` field from all event literals in `event-publisher.ts`
2. Note the new `index` field on `TaskArtifactUpdateEvent` — must be set to indicate artifact position

> **SDK-BLOCKED:** The SDK's `ExecutionEventBus.publish()` accepts the SDK's typed events. The `kind` field removal must come from the SDK types. The wire serialization (wrapping in `taskStatusUpdate`/`taskArtifactUpdate`) is handled by the SDK's transport layer.

---

#### H-3 · `http://` hardcoded in AgentCard URL

**Status:** Bug — security issue  
**Spec reference:** A2A spec [Section 7.1](https://a2a-protocol.org/latest/specification/) requires HTTPS in production  
**Files:** `src/server/agent-card.ts` line 29  

**Current code:**
```typescript
const baseUrl = `http://${host}:${port}`;  // ❌ always HTTP
```

**Impact:** Every agent card served by this bridge advertises an HTTP endpoint even when deployed behind TLS. A2A clients following the spec reject insecure endpoints, and reverse proxies (nginx, Caddy, cloud load balancers) will forward HTTPS to the backend but the agent card will incorrectly advertise HTTP.

**Work items:**
1. Add `advertiseProtocol?: "http" | "https"` to `ServerConfig` in `config/types.ts`
2. In `buildAgentCard()`, use `server.advertiseProtocol ?? "https"` for public deployments
3. Alternatively, check `x-forwarded-proto` header at runtime (already done in `server/index.ts` for the dynamic card handler — apply same logic to the static card built at startup, or make the card URL lazy)
4. Update `agents/*/config.json` examples to show `"advertiseProtocol": "https"` for production

---

#### H-4 · Illegal `Task` cast in executor bypasses type safety

**Status:** Bug — code quality  
**Files:** `src/copilot/executor.ts` ~line 222  

**Current code:**
```typescript
bus.publish({
  kind: "task",
  id: taskId,
  contextId,
  status: { state: "submitted", timestamp: new Date().toISOString() },
  history: [userMessage],
} as unknown as Task);   // ❌ double cast — bypasses type checker
```

**Why this is a problem:**
- The `as unknown as Task` pattern is a TypeScript escape hatch that hides real type errors
- The SDK's `ExecutionEventBus.publish()` does NOT accept `Task` objects — it only accepts `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`, etc.
- This call will either fail at runtime or be silently ignored, depending on the SDK implementation

**Work items:**
1. Remove this unsafe `bus.publish()` call entirely — the SDK's `DefaultRequestHandler` creates and stores the initial task automatically
2. If explicit "submitted" status is needed, use `publishStatus(bus, taskId, contextId, "TASK_STATE_SUBMITTED")` instead
3. Follow the official SDK `AgentExecutor` pattern where the first `publish()` call should be a `TaskStatusUpdateEvent` with `state: SUBMITTED`

---

#### H-5 · `stateTransitionHistory` capability is removed in v1.0

**Status:** Out of compliance  
**Spec reference:** GitHub issue [#1396](https://github.com/a2aproject/A2A/issues/1396) — removed as unimplemented  
**Files:** `src/server/agent-card.ts`, `src/config/types.ts`, `agents/*/config.json`

**Current code:**
```typescript
capabilities: {
  streaming: ...,
  pushNotifications: ...,
  stateTransitionHistory: agentCard.stateTransitionHistory ?? true,  // ❌ removed
},
```

**Work items:**
1. Remove `stateTransitionHistory` from `buildAgentCard()` capabilities object
2. Remove `stateTransitionHistory?: boolean` from `AgentCardConfig` interface
3. Remove `stateTransitionHistory` from `agents/*/config.json` files

---

### 🟡 MEDIUM IMPACT — Should Be Addressed Within 1–3 Months

---

#### M-1 · No `A2A-Version` header handling

**Status:** Missing v1.0 feature  
**Spec reference:** [Improved Developer Experience — version negotiation](https://a2a-protocol.org/latest/whats-new-v1/#3-improved-developer-experience)  
**Files:** `src/server/index.ts`

**What changed in v1.0:**
Clients send an `A2A-Version: 1.0` request header. Servers SHOULD validate and MAY reject unsupported versions with a `VersionNotSupported` error.

**Work items:**
1. In `src/server/index.ts`, add middleware to read the `A2A-Version` header
2. Log the version for observability
3. Optionally: reject requests with version > what the server implements (future-proofing)
4. Once SDK v1.0 is available: respond with `A2A-Version: 1.0` header in all responses

---

#### M-2 · `ListTasks` operation not implemented

**Status:** New v1.0 feature — missing  
**Spec reference:** [List Tasks (new operation)](https://a2a-protocol.org/latest/whats-new-v1/#list-tasks-taskslist-listtasks)  
**Files:** `src/copilot/executor.ts`, `src/server/index.ts`

**What changed in v1.0:**
New `ListTasks` (JSON-RPC) / `GET /tasks` (HTTP+JSON) operation added. Returns paginated tasks with cursor-based pagination. Tasks are scoped to the authenticated caller.

**Work items:**
1. Implement a `listTasks()` handler that queries `InMemoryTaskStore`
2. Support cursor-based pagination (`cursor`, `limit` params)
3. Scope results to `contextId` if authentication/multi-tenancy is in use
4. Register the handler on the SDK's `DefaultRequestHandler`

> **SDK-BLOCKED:** `DefaultRequestHandler` must expose `ListTasks` routing for the SDK to wire it into the JSON-RPC dispatcher.

---

#### M-3 · `session: unknown` cast to `any` in session manager

**Status:** Code quality bug  
**Files:** `src/copilot/session-manager.ts`, `src/copilot/executor.ts`

**Current code (executor.ts):**
```typescript
const copilotSession = session as any;   // ❌ loses all type safety
copilotSession.on("assistant.message_delta", ...)
```

**Work items:**
1. Create a typed interface `CopilotSession` mirroring the Copilot SDK session API (event names, return types)
2. Update `SessionManager` to use the typed interface
3. Remove `session as any` casts in `executor.ts`

---

### ⚪ LOW IMPACT — Nice to Have / Future v1.x Features

---

#### L-1 · No `createdAt` / `lastModified` timestamps on Task

**Status:** New v1.0 fields — not implemented  
**Spec reference:** [GetTask changes](https://a2a-protocol.org/latest/whats-new-v1/#get-task-tasksget-gettask)

`createdAt` and `lastModified` ISO 8601 timestamps are new required fields on `Task`. Currently, task metadata stored in `InMemoryTaskStore` (managed by SDK) does not include these. Blocked by SDK until its `Task` type is updated.

---

#### L-2 · Agent Card signature verification not implemented

**Status:** New v1.0 enterprise feature — not implemented  
**Spec reference:** [Agent Card Signature Verification](https://a2a-protocol.org/latest/whats-new-v1/#2-agent-card-signature-verification)

v1.0 supports JWS (RFC 7515) + JSON Canonicalization (RFC 8785) for cryptographic signing of Agent Cards. This is optional but required for enterprise trust scenarios.

**Work items (future):**
1. Generate a JWK signing key on startup
2. Sign agent card JSON using JWS detached signature
3. Expose public key endpoint via `jku` or static file
4. Expose `AgentCard.signatures[]` array with the JWS

---

#### L-3 · Multi-tenancy (`tenant` field) not implemented

**Status:** New v1.0 enterprise feature — not implemented  
**Spec reference:** [Multi-Tenancy Support](https://a2a-protocol.org/latest/whats-new-v1/#new-multi-tenancy-support)

v1.0 adds a `tenant` field to all request messages and `AgentInterface` for multi-tenant routing from a single endpoint.

**Work items (future):**
1. Add `tenant` field parsing to the request handler
2. Optionally: scope sessions/tasks by tenant in `SessionManager`

---

#### L-4 · OAuth: no PKCE support or Device Code flow declared in AgentCard

**Status:** New v1.0 security improvement — not declared  
**Spec reference:** [OAuth 2.0 Security Updates](https://a2a-protocol.org/latest/whats-new-v1/#oauth-20-security-updates-1303)

v1.0 removes deprecated `ImplicitOAuthFlow` and `PasswordOAuthFlow` and adds `DeviceCodeOAuthFlow` + `pkce_required` on Authorization Code flow. The project does not currently declare any `securitySchemes` in the Agent Card, so there's nothing to remove. If OAuth is added in future, use only Authorization Code + PKCE or Device Code flows.

---

## SDK Upgrade Path

The JS SDK has not yet shipped v1.0 support. The npm latest (`0.3.13`, published 16 March 2026) predates the A2A spec v1.0 changes being fully reflected in the SDK types.

**Once `@a2a-js/sdk` releases a v1.0-compatible version:**

1. Upgrade `package.json`: `"@a2a-js/sdk": "^1.0.0"` (or whatever the SDK version is)
2. Fix TypeScript compilation errors caused by removed/changed types — the compiler will guide you to every affected file
3. Key SDK type changes that will surface:
   - `AgentCard.url` removed → fix `agent-card.ts` (C-1)
   - `AgentCard.protocolVersion` removed → fix `agent-card.ts` (C-1)
   - `AgentCapabilities.stateTransitionHistory` removed → fix `agent-card.ts` (H-5)
   - `Part` kind-discriminated types removed → fix `event-publisher.ts` (C-2)
   - `Message.kind` removed → fix `event-publisher.ts` (C-3)
   - `TaskStatusUpdateEvent.final` removed → fix `event-publisher.ts` (H-1)
   - `TaskStatusUpdateEvent.kind` removed → fix `event-publisher.ts` (H-2)
   - `TaskArtifactUpdateEvent.kind` removed → fix `event-publisher.ts` (H-2)
   - `TaskState` enum values → fix `event-publisher.ts` and `executor.ts` (C-4)
   - `Message.role` enum values → fix `event-publisher.ts` (C-3)

---

## What Is Already Compliant

| Feature | Status |
|---|---|
| Agent Card served at `/.well-known/agent.json` + `/.well-known/agent-json` + SDK path | ✅ Compliant |
| JSON-RPC 2.0 transport via `@a2a-js/sdk` `jsonRpcHandler` | ✅ Compliant |
| Task lifecycle: `submitted → working → completed/failed/canceled` | ✅ Compliant (value format issues only) |
| Artifacts (`TaskArtifactUpdateEvent`) instead of raw text output | ✅ Compliant (kind discriminator issue only) |
| Streaming SSE via SDK's `DefaultRequestHandler` + `InMemoryTaskStore` | ✅ Compliant |
| `contextId`-based multi-turn session management | ✅ Compliant |
| Tools via MCP (`mcp-hooks.ts`) — complementary to A2A, not conflicting | ✅ Compliant |

---

## Prioritized Work Backlog

### Sprint 1 — SDK Upgrade & Breaking Changes (do as a single PR when SDK v1.0 ships)

| ID | Task | File(s) | Effort |
|---|---|---|---|
| C-1 | Replace AgentCard `url`+`protocolVersion` → `supportedInterfaces[]` | `agent-card.ts`, `config/types.ts`, `agents/*/config.json` | M |
| C-2 | Remove `kind` from all Part literals; use member-presence discrimination | `event-publisher.ts` | S |
| C-3 | Remove `kind` from Message; change `role` to `ROLE_AGENT`/`ROLE_USER` | `event-publisher.ts` | S |
| C-4 | Update all `TaskState` values to `TASK_STATE_*` | `event-publisher.ts`, `executor.ts` | S |
| H-1 | Remove `final` field from `TaskStatusUpdateEvent` | `event-publisher.ts` | S |
| H-2 | Remove `kind` from stream event objects | `event-publisher.ts` | S |
| H-5 | Remove `stateTransitionHistory` from capabilities | `agent-card.ts`, `config/types.ts` | XS |

### Sprint 2 — Code Health (can be done now, independent of SDK)

| ID | Task | File(s) | Effort |
|---|---|---|---|
| H-3 | Fix `http://` hardcode → `https://` with configurable protocol | `agent-card.ts`, `config/types.ts` | S |
| H-4 | Remove illegal `as unknown as Task` cast in executor | `executor.ts` | S |
| M-3 | Type the Copilot session properly, remove `as any` casts | `session-manager.ts`, `executor.ts` | M |

### Sprint 3 — New v1.0 Features (after SDK v1.0)

| ID | Task | File(s) | Effort |
|---|---|---|---|
| M-1 | Add `A2A-Version` header middleware | `server/index.ts` | S |
| M-2 | Implement `ListTasks` with cursor pagination | `executor.ts`, `server/index.ts` | M |

### Sprint 4 — Enterprise Features (optional / future)

| ID | Task | Effort |
|---|---|---|
| L-1 | `createdAt`/`lastModified` timestamps on Task | S |
| L-2 | Agent Card JWS signature verification | L |
| L-3 | Multi-tenancy `tenant` field | M |
| L-4 | Declare OAuth security schemes (if auth is added) | M |

---

## References

- [A2A v1.0.0 Release on GitHub](https://github.com/a2aproject/A2A/releases/tag/v1.0.0) — official changelog
- [What's New in A2A v1.0](https://a2a-protocol.org/latest/whats-new-v1/) — full migration guide
- [A2A Protocol v1.0 Spec Overview](https://a2a-protocol.org/latest/specification/)
- [a2a-js SDK on npm](https://www.npmjs.com/package/@a2a-js/sdk) — watch for v1.0 release
- [A2A Protocol Announcement](https://a2a-protocol.org/latest/announcing-1.0/)
