/**
 * @module a2a/bus-publisher
 *
 * The {@link RunPublisher} of the run runtime over an SDK `ExecutionEventBus`:
 * what the runtime says about a task becomes status and artifact events on the
 * bus. The only place the runtime meets bus event shapes.
 */

import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import type { CoreArtifact, CoreEvent, Meta } from "../model/index.js";
import type { RunPublisher } from "../runtime/types.js";
import { toArtifactUpdate, toStatusUpdate, usageToMetadata } from "./adapter.js";

/**
 * Publish through `bus`. Text and thought deltas become streamed artifact chunks
 * (one artifact per message id), usage a `working` status carrying the usage
 * metadata, and any other event a `working` status with the event as a data part
 * (nothing is dropped silently).
 */
export function createBusPublisher(bus: ExecutionEventBus, ids: { taskId: string; contextId: string }): RunPublisher {
  const { taskId, contextId } = ids;
  const started = new Set<string>();

  const chunk = (artifactId: string, text: string, meta?: Meta) => {
    const append = started.has(artifactId);
    started.add(artifactId);
    bus.publish({
      kind: "artifactUpdate",
      data: toArtifactUpdate(taskId, contextId, {
        id: artifactId,
        parts: [{ kind: "text", text }],
        append,
        lastChunk: false,
        ...(meta ? { meta } : {}),
      }),
    });
  };

  return {
    status({ state, text, metadata, usage }) {
      const merged: Meta | undefined =
        metadata || usage ? { ...(metadata ?? {}), ...(usage ? usageToMetadata(usage) : {}) } : undefined;
      bus.publish({
        kind: "statusUpdate",
        data: toStatusUpdate({ taskId, contextId, state, ...(text ? { text } : {}), ...(merged ? { metadata: merged } : {}) }),
      });
    },
    event(e: CoreEvent) {
      if (e.type === "text") chunk(e.messageId ?? "text", e.text, e.meta);
      else if (e.type === "thought") chunk(`thought:${e.messageId ?? "thought"}`, e.text, { ...(e.meta ?? {}), thought: true });
      else if (e.type === "usage") {
        bus.publish({
          kind: "statusUpdate",
          data: toStatusUpdate({ taskId, contextId, state: "working", metadata: usageToMetadata(e.usage) }),
        });
      } else {
        bus.publish({
          kind: "statusUpdate",
          data: toStatusUpdate({ taskId, contextId, state: "working", parts: [{ kind: "data", data: e }] }),
        });
      }
    },
    artifact(a: CoreArtifact) {
      bus.publish({ kind: "artifactUpdate", data: toArtifactUpdate(taskId, contextId, a) });
    },
    finished() {
      bus.finished();
    },
  };
}
