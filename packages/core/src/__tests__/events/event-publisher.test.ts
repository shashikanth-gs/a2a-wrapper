import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
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
 */

/** Simple mock for ExecutionEventBus that captures published events. */
function createMockBus() {
  const events: any[] = [];
  return {
    publish(event: any) { events.push(event); },
    events,
  };
}

/** Arbitrary for non-empty identifier strings. */
const arbId = fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter((s) => s.length > 0 && s.length <= 30);

/** Arbitrary for TaskState string literals. */
const arbState = fc.constantFrom("working", "completed", "failed", "canceled", "submitted", "input-required");

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

// Feature: shared-core-package, Property 13: Event publisher structure correctness
// Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
describe("Property 13: Event publisher structure correctness", () => {
  it("publishStatus produces correct status-update event structure", () => {
    fc.assert(
      fc.property(arbId, arbId, arbState, arbOptionalText, (taskId, contextId, state, messageText) => {
        const bus = createMockBus();
        publishStatus(bus as any, taskId, contextId, state as any, messageText);

        expect(bus.events).toHaveLength(1);
        const event = bus.events[0];

        // Correct kind, taskId, contextId
        expect(event.kind).toBe("status-update");
        expect(event.taskId).toBe(taskId);
        expect(event.contextId).toBe(contextId);

        // Correct state
        expect(event.status.state).toBe(state);

        // Valid ISO timestamp
        expect(event.status.timestamp).toMatch(isoTimestampRegex);

        // Agent message present only when messageText is provided
        if (messageText !== undefined) {
          expect(event.status.message).toBeDefined();
          expect(event.status.message.role).toBe("agent");
          expect(event.status.message.parts).toHaveLength(1);
          expect(event.status.message.parts[0].kind).toBe("text");
          expect(event.status.message.parts[0].text).toBe(messageText);
        } else {
          expect(event.status.message).toBeUndefined();
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

        expect(event.kind).toBe("artifact-update");
        expect(event.taskId).toBe(taskId);
        expect(event.contextId).toBe(contextId);
        expect(event.append).toBe(false);
        expect(event.lastChunk).toBe(true);
        expect(event.artifact.parts[0].kind).toBe("text");
        expect(event.artifact.parts[0].text).toBe(text);
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

        expect(event.kind).toBe("artifact-update");
        expect(event.taskId).toBe(taskId);
        expect(event.contextId).toBe(contextId);
        expect(event.append).toBe(true);
        expect(event.lastChunk).toBe(false);
        expect(event.artifact.artifactId).toBe(artifactId);
        expect(event.artifact.parts[0].kind).toBe("text");
        expect(event.artifact.parts[0].text).toBe(chunkText);
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

        expect(event.kind).toBe("artifact-update");
        expect(event.taskId).toBe(taskId);
        expect(event.contextId).toBe(contextId);
        expect(event.append).toBe(true);
        expect(event.lastChunk).toBe(true);
        expect(event.artifact.artifactId).toBe(artifactId);
        expect(event.artifact.parts[0].kind).toBe("text");
        expect(event.artifact.parts[0].text).toBe(fullText);
      }),
      { numRuns: 100 },
    );
  });

  it("publishTraceArtifact produces event with DataPart containing the data", () => {
    fc.assert(
      fc.property(arbId, arbId, arbTraceKey, arbData, (taskId, contextId, traceKey, data) => {
        const bus = createMockBus();
        publishTraceArtifact(bus as any, taskId, contextId, traceKey, data);

        expect(bus.events).toHaveLength(1);
        const event = bus.events[0];

        expect(event.kind).toBe("artifact-update");
        expect(event.taskId).toBe(taskId);
        expect(event.contextId).toBe(contextId);
        expect(event.append).toBe(false);
        expect(event.lastChunk).toBe(true);
        expect(event.artifact.name).toBe(traceKey);
        expect(event.artifact.parts[0].kind).toBe("data");
        expect(event.artifact.parts[0].data).toEqual(data);
      }),
      { numRuns: 100 },
    );
  });

  it("publishThoughtArtifact produces event with TextPart containing the text", () => {
    fc.assert(
      fc.property(arbId, arbId, arbTraceKey, arbText, (taskId, contextId, traceKey, text) => {
        const bus = createMockBus();
        publishThoughtArtifact(bus as any, taskId, contextId, traceKey, text);

        expect(bus.events).toHaveLength(1);
        const event = bus.events[0];

        expect(event.kind).toBe("artifact-update");
        expect(event.taskId).toBe(taskId);
        expect(event.contextId).toBe(contextId);
        expect(event.append).toBe(false);
        expect(event.lastChunk).toBe(true);
        expect(event.artifact.name).toBe(traceKey);
        expect(event.artifact.parts[0].kind).toBe("text");
        expect(event.artifact.parts[0].text).toBe(text);
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

          const artifactIds = bus.events.map((e: any) => e.artifact.artifactId);
          const uniqueIds = new Set(artifactIds);
          expect(uniqueIds.size).toBe(n);
        },
      ),
      { numRuns: 100 },
    );
  });
});
