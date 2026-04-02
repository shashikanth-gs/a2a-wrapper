/**
 * A2A Event Publisher
 *
 * Helpers for publishing TaskStatusUpdateEvent and TaskArtifactUpdateEvent
 * through the A2A ExecutionEventBus. Extracted from executor to keep
 * the orchestration logic clean.
 */

import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from "@a2a-js/sdk";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";

// ─── Status Updates ─────────────────────────────────────────────────────────

/** Publish a task status-update event. */
export function publishStatus(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  state: "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "rejected",
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
 * Publish a single, complete artifact (buffered mode).
 * Inspector-compatible: one artifact-update = one chat bubble.
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
 * Publish a streaming text chunk (A2A spec-correct mode).
 * Uses append:true and shared artifactId for concatenation.
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
 * Publish the final lastChunk marker (streaming mode).
 * Includes the full accumulated text for self-contained validation.
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
 * Publish a structured trace artifact (DataPart) — e.g. MCP calls, delegations.
 *
 * @param bus        Current task's A2A event bus
 * @param taskId     A2A task ID
 * @param contextId  A2A context ID
 * @param traceKey   Artifact `name` — must start with "trace." (e.g. "trace.mcp")
 * @param data       Structured JSON payload stored in a DataPart
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
 * Publish a text trace artifact (TextPart) — e.g. reasoning / thoughts.
 *
 * @param bus        Current task's A2A event bus
 * @param taskId     A2A task ID
 * @param contextId  A2A context ID
 * @param traceKey   Artifact `name` — must start with "trace." (e.g. "trace.thought")
 * @param text       Free-form reasoning text
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
