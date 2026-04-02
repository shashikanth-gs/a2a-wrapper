/**
 * @module events/event-publisher
 *
 * A2A Event Publisher — helper functions for constructing and publishing
 * spec-compliant {@link TaskStatusUpdateEvent} and {@link TaskArtifactUpdateEvent}
 * through the A2A {@link ExecutionEventBus}.
 *
 * This module centralises all event construction logic so that wrapper projects
 * never need to manually assemble A2A event payloads. Every published artifact
 * receives a globally unique ID (UUID v4), and every status update carries an
 * ISO 8601 timestamp.
 *
 * ### Supported event categories
 *
 * | Category | Functions |
 * |---|---|
 * | Status updates | {@link publishStatus} |
 * | Buffered artifacts | {@link publishFinalArtifact} |
 * | Streaming artifacts | {@link publishStreamingChunk}, {@link publishLastChunkMarker} |
 * | Trace / observability | {@link publishTraceArtifact}, {@link publishThoughtArtifact} |
 *
 * ### Trace artifact conventions
 *
 * Sideband trace artifacts are observability-only data carried within
 * `TaskArtifactUpdateEvent`. The orchestrator reads `trace.*` artifacts for
 * evidence storage but does **not** forward them to the LLM — only `response`
 * and `final_answer` artifacts are forwarded to the model.
 *
 * | Trace key | Purpose | Part type |
 * |---|---|---|
 * | `trace.mcp` | MCP tool call (request + response) | DataPart |
 * | `trace.thought` | Agent reasoning / chain of thought | TextPart |
 * | `trace.delegation` | Sub-agent call (child task link) | DataPart |
 *
 * @packageDocumentation
 */

import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  TaskState,
} from "@a2a-js/sdk";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";

// ─── Status Updates ─────────────────────────────────────────────────────────

/**
 * Publish a task status-update event with an optional agent message.
 *
 * Constructs a {@link TaskStatusUpdateEvent} containing the new task state,
 * an ISO 8601 timestamp, and — when `messageText` is provided — an agent
 * message with a unique `messageId` (UUID v4) and a single `TextPart`.
 *
 * @param bus         - The {@link ExecutionEventBus} for the current task execution.
 * @param taskId      - The A2A task identifier.
 * @param contextId   - The A2A context identifier for the conversation.
 * @param state       - The new {@link TaskState} to transition to
 *                      (e.g. `"working"`, `"completed"`, `"failed"`).
 * @param messageText - Optional human-readable message to attach as an agent
 *                      message. When omitted, no message is included.
 * @param final       - Whether this is the final status event for the task.
 *                      Defaults to `false`.
 *
 * @example
 * ```ts
 * // Signal that the agent is working
 * publishStatus(bus, taskId, contextId, "working");
 *
 * // Signal completion with a summary message
 * publishStatus(bus, taskId, contextId, "completed", "Done!", true);
 * ```
 *
 * @see {@link TaskStatusUpdateEvent}
 * @see {@link TaskState}
 */
export function publishStatus(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  state: TaskState,
  messageText?: string,
  final = false,
): void {
  const event: TaskStatusUpdateEvent = {
    kind: "status-update",
    taskId,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      ...(messageText
        ? {
            message: {
              kind: "message",
              messageId: uuidv4(),
              role: "agent",
              parts: [{ kind: "text", text: messageText }],
              contextId,
            },
          }
        : {}),
    },
    final,
  };
  bus.publish(event);
}

// ─── Artifact Updates ───────────────────────────────────────────────────────

/**
 * Publish a single, complete artifact in buffered (non-appending) mode.
 *
 * Constructs a {@link TaskArtifactUpdateEvent} with `append: false` and
 * `lastChunk: true`, wrapping the provided text in a `TextPart`. The artifact
 * receives a unique ID prefixed with `response-` followed by a UUID v4.
 *
 * This is the preferred method for publishing a complete response when
 * streaming is disabled — one artifact-update equals one chat bubble in
 * the A2A Inspector.
 *
 * @param bus       - The {@link ExecutionEventBus} for the current task execution.
 * @param taskId    - The A2A task identifier.
 * @param contextId - The A2A context identifier for the conversation.
 * @param text      - The complete response text to publish.
 *
 * @example
 * ```ts
 * publishFinalArtifact(bus, taskId, contextId, "Here is the full answer.");
 * ```
 *
 * @see {@link TaskArtifactUpdateEvent}
 */
export function publishFinalArtifact(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  text: string,
): void {
  const event: TaskArtifactUpdateEvent = {
    kind: "artifact-update",
    taskId,
    contextId,
    append: false,
    lastChunk: true,
    artifact: {
      artifactId: `response-${uuidv4()}`,
      name: "response",
      parts: [{ kind: "text", text }],
    },
  };
  bus.publish(event);
}

/**
 * Publish a streaming text chunk in append mode.
 *
 * Constructs a {@link TaskArtifactUpdateEvent} with `append: true` and
 * `lastChunk: false`. The caller is responsible for providing a stable
 * `artifactId` across all chunks of the same logical artifact, and for
 * sending a final chunk via {@link publishLastChunkMarker} when streaming
 * is complete.
 *
 * @param bus        - The {@link ExecutionEventBus} for the current task execution.
 * @param taskId     - The A2A task identifier.
 * @param contextId  - The A2A context identifier for the conversation.
 * @param artifactId - A stable artifact ID shared across all chunks of this
 *                     streaming artifact. Typically generated once via UUID v4
 *                     at the start of the stream.
 * @param chunkText  - The incremental text chunk to append.
 *
 * @example
 * ```ts
 * const artifactId = `response-${uuidv4()}`;
 * publishStreamingChunk(bus, taskId, contextId, artifactId, "Hello ");
 * publishStreamingChunk(bus, taskId, contextId, artifactId, "world!");
 * publishLastChunkMarker(bus, taskId, contextId, artifactId, "Hello world!");
 * ```
 *
 * @see {@link publishLastChunkMarker}
 * @see {@link TaskArtifactUpdateEvent}
 */
export function publishStreamingChunk(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  artifactId: string,
  chunkText: string,
): void {
  const event: TaskArtifactUpdateEvent = {
    kind: "artifact-update",
    taskId,
    contextId,
    append: true,
    lastChunk: false,
    artifact: {
      artifactId,
      name: "response",
      parts: [{ kind: "text", text: chunkText }],
    },
  };
  bus.publish(event);
}

/**
 * Publish the final streaming chunk marker, signalling end-of-stream.
 *
 * Constructs a {@link TaskArtifactUpdateEvent} with `append: true` and
 * `lastChunk: true`. The `fullText` parameter carries the complete
 * accumulated response text, allowing consumers that missed earlier chunks
 * to reconstruct the full artifact from this single event.
 *
 * @param bus        - The {@link ExecutionEventBus} for the current task execution.
 * @param taskId     - The A2A task identifier.
 * @param contextId  - The A2A context identifier for the conversation.
 * @param artifactId - The same stable artifact ID used for all preceding
 *                     streaming chunks.
 * @param fullText   - The complete accumulated response text.
 *
 * @example
 * ```ts
 * publishLastChunkMarker(bus, taskId, contextId, artifactId, accumulatedText);
 * ```
 *
 * @see {@link publishStreamingChunk}
 * @see {@link TaskArtifactUpdateEvent}
 */
export function publishLastChunkMarker(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  artifactId: string,
  fullText: string,
): void {
  const event: TaskArtifactUpdateEvent = {
    kind: "artifact-update",
    taskId,
    contextId,
    append: true,
    lastChunk: true,
    artifact: {
      artifactId,
      name: "response",
      parts: [{ kind: "text", text: fullText }],
    },
  };
  bus.publish(event);
}

// ─── Sideband Trace Artifacts ───────────────────────────────────────────────
//
// Observability-only data carried within A2A TaskArtifactUpdateEvent.
// The orchestrator reads trace.* artifacts for evidence storage but
// does NOT pass them to the LLM — only `response` / `final_answer`
// artifacts are forwarded to the model.
//
// Key conventions:
//   trace.mcp        — MCP tool call (request + response)         → DataPart
//   trace.thought    — Agent reasoning / chain of thought          → TextPart
//   trace.delegation — Sub-agent call (child task link)            → DataPart
// ────────────────────────────────────────────────────────────────────────────

/**
 * Publish a structured trace artifact using a `DataPart`.
 *
 * Trace artifacts are sideband observability data — the orchestrator stores
 * them as evidence but does **not** forward them to the LLM. Common trace
 * keys include `trace.mcp` (tool calls) and `trace.delegation` (sub-agent
 * invocations).
 *
 * The artifact is published in buffered mode (`append: false`, `lastChunk: true`)
 * with a unique ID formatted as `{traceKey}-{uuid}`.
 *
 * @param bus       - The {@link ExecutionEventBus} for the current task execution.
 * @param taskId    - The A2A task identifier.
 * @param contextId - The A2A context identifier for the conversation.
 * @param traceKey  - The artifact `name` — should start with `"trace."`
 *                    (e.g. `"trace.mcp"`, `"trace.delegation"`).
 * @param data      - Structured JSON payload stored in a `DataPart`.
 *
 * @example
 * ```ts
 * publishTraceArtifact(bus, taskId, contextId, "trace.mcp", {
 *   tool: "read_file",
 *   request: { path: "/tmp/data.json" },
 *   response: { content: "..." },
 * });
 * ```
 *
 * @see {@link publishThoughtArtifact}
 * @see {@link TaskArtifactUpdateEvent}
 */
export function publishTraceArtifact(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  traceKey: string,
  data: Record<string, unknown>,
): void {
  const event: TaskArtifactUpdateEvent = {
    kind: "artifact-update",
    taskId,
    contextId,
    append: false,
    lastChunk: true,
    artifact: {
      artifactId: `${traceKey}-${uuidv4()}`,
      name: traceKey,
      parts: [
        {
          kind: "data",
          data,
          metadata: { mimeType: "application/json" },
        } as any,
      ],
    },
  };
  bus.publish(event);
}

/**
 * Publish a text trace artifact using a `TextPart`.
 *
 * Used for free-form observability text such as agent reasoning, chain of
 * thought, or internal decision logs. Like all trace artifacts, these are
 * stored by the orchestrator for evidence but **not** forwarded to the LLM.
 *
 * The artifact is published in buffered mode (`append: false`, `lastChunk: true`)
 * with a unique ID formatted as `{traceKey}-{uuid}`.
 *
 * @param bus       - The {@link ExecutionEventBus} for the current task execution.
 * @param taskId    - The A2A task identifier.
 * @param contextId - The A2A context identifier for the conversation.
 * @param traceKey  - The artifact `name` — should start with `"trace."`
 *                    (e.g. `"trace.thought"`).
 * @param text      - Free-form reasoning or thought text.
 *
 * @example
 * ```ts
 * publishThoughtArtifact(bus, taskId, contextId, "trace.thought",
 *   "The user is asking about file permissions. I should use the read_file tool."
 * );
 * ```
 *
 * @see {@link publishTraceArtifact}
 * @see {@link TaskArtifactUpdateEvent}
 */
export function publishThoughtArtifact(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  traceKey: string,
  text: string,
): void {
  const event: TaskArtifactUpdateEvent = {
    kind: "artifact-update",
    taskId,
    contextId,
    append: false,
    lastChunk: true,
    artifact: {
      artifactId: `${traceKey}-${uuidv4()}`,
      name: traceKey,
      parts: [{ kind: "text", text }],
    },
  };
  bus.publish(event);
}
