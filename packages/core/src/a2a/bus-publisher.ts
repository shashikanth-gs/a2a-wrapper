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
import { toArtifactUpdate, toInteractionStatusUpdate, usageToMetadata, toStatusUpdate } from "./adapter.js";

/**
 * Which streamed artifacts of a task already have their first chunk out (task id -> artifact ids). Must be shared by every
 * publisher of one task: a reply to a parked run is a NEW attachment (a new publisher over the same bus, or over the task
 * store), and its first text chunk must append to the artifact the run started, not replace it. The owner of the map is the
 * `RunRegistry` (`publisherState`), which drops a task's entry when its run ends and clears it at shutdown, so nothing here
 * is process-global.
 */
export type PublisherState = Map<string, Set<string>>;

/**
 * Publish through `bus`. Text and thought deltas become streamed artifact chunks
 * (one artifact per message id), usage a `working` status carrying the usage
 * metadata, and any other event a `working` status with the event as a data part
 * (nothing is dropped silently).
 */
export function createBusPublisher(
  bus: ExecutionEventBus,
  ids: { taskId: string; contextId: string },
  state: PublisherState = new Map(),
): RunPublisher {
  const { taskId, contextId } = ids;
  const started = state.get(taskId) ?? new Set<string>();
  state.set(taskId, started);

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
    interaction(interaction, options) {
      // Structured payload always on: it sits next to the text rendering, so a client that ignores it loses nothing.
      // (When the agent card declares the interaction extension, gate it on the client's activation here.)
      const event = toInteractionStatusUpdate(taskId, contextId, interaction);
      const hint = options?.hint;
      const first = event.status?.message?.parts?.[0];
      if (hint && first?.content?.$case === "text") first.content.value = `${hint}
${first.content.value}`;
      bus.publish({ kind: "statusUpdate", data: event });
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
