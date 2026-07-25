import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { TaskState } from "@a2a-js/sdk";
import {
  publishTask,
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
  publishTraceArtifact,
  publishThoughtArtifact,
} from "../../events/event-publisher.js";

/**
 * Property-based tests for the event publisher module.
 *
 * Validates Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6 via Property 13
 * and Requirement 8.7 via Property 14.
 *
 * A2A v1.0 note: `ExecutionEventBus.publish()` now takes a `{kind, data}`
 * envelope (see event-publisher.ts's module doc) — every assertion below
 * reads `event.data.*`, not `event.*` directly. `Part`s use the proto-oneof
 * `content.$case`/`content.value` shape instead of the old `kind`/`text`
 * fields, and `TaskStatus.state` is the numeric `TaskState` enum instead of
 * a lowercase-hyphen string.
 */

/** Simple mock for ExecutionEventBus that captures published events. */
function createMockBus() {
  const events: any[] = [];
  return {
    publish(event: any) { events.push(event); },
    events,
  };
}

/** Reads the text value of a part, or undefined if it isn't a text part. */
function partText(part: any): string | undefined {
  return part.content?.$case === "text" ? part.content.value : undefined;
}

/** Reads the data value of a part, or undefined if it isn't a data part. */
function partData(part: any): unknown {
  return part.content?.$case === "data" ? part.content.value : undefined;
}

/** Arbitrary for non-empty identifier strings. */
const arbId = fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter((s) => s.length > 0 && s.length <= 30);

/** Arbitrary for legacy lowercase-hyphen task state strings + their expected TaskState enum value. */
const arbState = fc.constantFrom(
  { legacy: "working", enum: TaskState.TASK_STATE_WORKING },
  { legacy: "completed", enum: TaskState.TASK_STATE_COMPLETED },
  { legacy: "failed", enum: TaskState.TASK_STATE_FAILED },
  { legacy: "canceled", enum: TaskState.TASK_STATE_CANCELED },
  { legacy: "submitted", enum: TaskState.TASK_STATE_SUBMITTED },
  { legacy: "input-required", enum: TaskState.TASK_STATE_INPUT_REQUIRED },
);

/** Arbitrary for non-empty text strings. */
const arbText = fc.string({ minLength: 1, maxLength: 200 });

/** Arbitrary for optional message text (string or undefined). */
const arbOptionalText = fc.option(arbText, { nil: undefined });

/** ISO 8601 timestamp regex for validation. */
const isoTimestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

/** Arbitrary for a trace key. */
const arbTraceKey = fc.constantFrom("trace.mcp", "trace.thought", "trace.delegation");

/** Arbitrary for structured data payload. */
const arbData = fc.dictionary(
  fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]*$/).filter((s) => s.length > 0 && s.length <= 10),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { minKeys: 1, maxKeys: 5 },
);

describe("publishTask", () => {
  it("publishes a task envelope with state submitted", () => {
    fc.assert(
      fc.property(arbId, arbId, (taskId, contextId) => {
        const bus = createMockBus();
        publishTask(bus as any, taskId, contextId);

        expect(bus.events).toHaveLength(1);
        const event = bus.events[0];
        expect(event.kind).toBe("task");
        expect(event.data.id).toBe(taskId);
        expect(event.data.contextId).toBe(contextId);
        expect(event.data.status.state).toBe(TaskState.TASK_STATE_SUBMITTED);
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: shared-core-package, Property 13: Event publisher structure correctness
// Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
describe("Property 13: Event publisher structure correctness", () => {
  it("publishStatus produces correct statusUpdate event structure", () => {
    fc.assert(
      fc.property(arbId, arbId, arbState, arbOptionalText, (taskId, contextId, state, messageText) => {
        const bus = createMockBus();
        publishStatus(bus as any, taskId, contextId, state.legacy as any, messageText);

        expect(bus.events).toHaveLength(1);
        const event = bus.events[0];

        // Correct envelope kind, taskId, contextId
        expect(event.kind).toBe("statusUpdate");
        expect(event.data.taskId).toBe(taskId);
        expect(event.data.contextId).toBe(contextId);

        // Correct state (as the v1.0 TaskState enum)
        expect(event.data.status.state).toBe(state.enum);

        // Valid ISO timestamp
        expect(event.data.status.timestamp).toMatch(isoTimestampRegex);

        // No `final` field on the wire (removed in v1.0)
        expect(event.data).not.toHaveProperty("final");

        // Agent message present only when messageText is provided
        if (messageText !== undefined) {
          expect(event.data.status.message).toBeDefined();
          expect(event.data.status.message.role).toBe(2); // Role.ROLE_AGENT
          expect(event.data.status.message.parts).toHaveLength(1);
          expect(partText(event.data.status.message.parts[0])).toBe(messageText);
        } else {
          expect(event.data.status.message).toBeUndefined();
        }
      }),
      { numRuns: 100 },
    );
  });

  it("publishFinalArtifact produces event with append: false and lastChunk: true", () => {
    fc.assert(
      fc.property(arbId, arbId, arbText, (taskId, contextId, text) => {
        const bus = createMockBus();
        publishFinalArtifact(bus as any, taskId, contextId, text);

        expect(bus.events).toHaveLength(1);
        const event = bus.events[0];

        expect(event.kind).toBe("artifactUpdate");
        expect(event.data.taskId).toBe(taskId);
        expect(event.data.contextId).toBe(contextId);
        expect(event.data.append).toBe(false);
        expect(event.data.lastChunk).toBe(true);
        expect(partText(event.data.artifact.parts[0])).toBe(text);
      }),
      { numRuns: 100 },
    );
  });

  it("publishStreamingChunk produces event with append: true and lastChunk: false", () => {
    fc.assert(
      fc.property(arbId, arbId, arbId, arbText, (taskId, contextId, artifactId, chunkText) => {
        const bus = createMockBus();
        publishStreamingChunk(bus as any, taskId, contextId, artifactId, chunkText);

        expect(bus.events).toHaveLength(1);
        const event = bus.events[0];

        expect(event.kind).toBe("artifactUpdate");
        expect(event.data.taskId).toBe(taskId);
        expect(event.data.contextId).toBe(contextId);
        expect(event.data.append).toBe(true);
        expect(event.data.lastChunk).toBe(false);
        expect(event.data.artifact.artifactId).toBe(artifactId);
        expect(partText(event.data.artifact.parts[0])).toBe(chunkText);
      }),
      { numRuns: 100 },
    );
  });

  it("publishLastChunkMarker produces event with append: true and lastChunk: true", () => {
    fc.assert(
      fc.property(arbId, arbId, arbId, arbText, (taskId, contextId, artifactId, fullText) => {
        const bus = createMockBus();
        publishLastChunkMarker(bus as any, taskId, contextId, artifactId, fullText);

        expect(bus.events).toHaveLength(1);
        const event = bus.events[0];

        expect(event.kind).toBe("artifactUpdate");
        expect(event.data.taskId).toBe(taskId);
        expect(event.data.contextId).toBe(contextId);
        expect(event.data.append).toBe(true);
        expect(event.data.lastChunk).toBe(true);
        expect(event.data.artifact.artifactId).toBe(artifactId);
        expect(partText(event.data.artifact.parts[0])).toBe(fullText);
      }),
      { numRuns: 100 },
    );
  });

  it("publishTraceArtifact produces event with a data part containing the data", () => {
    fc.assert(
      fc.property(arbId, arbId, arbTraceKey, arbData, (taskId, contextId, traceKey, data) => {
        const bus = createMockBus();
        publishTraceArtifact(bus as any, taskId, contextId, traceKey, data);

        expect(bus.events).toHaveLength(1);
        const event = bus.events[0];

        expect(event.kind).toBe("artifactUpdate");
        expect(event.data.taskId).toBe(taskId);
        expect(event.data.contextId).toBe(contextId);
        expect(event.data.append).toBe(false);
        expect(event.data.lastChunk).toBe(true);
        expect(event.data.artifact.name).toBe(traceKey);
        expect(partData(event.data.artifact.parts[0])).toEqual(data);
      }),
      { numRuns: 100 },
    );
  });

  it("publishThoughtArtifact produces event with a text part containing the text", () => {
    fc.assert(
      fc.property(arbId, arbId, arbTraceKey, arbText, (taskId, contextId, traceKey, text) => {
        const bus = createMockBus();
        publishThoughtArtifact(bus as any, taskId, contextId, traceKey, text);

        expect(bus.events).toHaveLength(1);
        const event = bus.events[0];

        expect(event.kind).toBe("artifactUpdate");
        expect(event.data.taskId).toBe(taskId);
        expect(event.data.contextId).toBe(contextId);
        expect(event.data.append).toBe(false);
        expect(event.data.lastChunk).toBe(true);
        expect(event.data.artifact.name).toBe(traceKey);
        expect(partText(event.data.artifact.parts[0])).toBe(text);
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: shared-core-package, Property 14: Artifact ID uniqueness
// Validates: Requirements 8.7
describe("Property 14: Artifact ID uniqueness", () => {
  it("N calls to publishFinalArtifact produce N unique artifact IDs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 20 }),
        arbId,
        arbId,
        (n, taskId, contextId) => {
          const bus = createMockBus();

          for (let i = 0; i < n; i++) {
            publishFinalArtifact(bus as any, taskId, contextId, `text-${i}`);
          }

          expect(bus.events).toHaveLength(n);

          const artifactIds = bus.events.map((e: any) => e.data.artifact.artifactId);
          const uniqueIds = new Set(artifactIds);
          expect(uniqueIds.size).toBe(n);
        },
      ),
      { numRuns: 100 },
    );
  });
});
