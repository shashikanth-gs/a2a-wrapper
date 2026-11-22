/**
 * @module a2a/store-publisher
 *
 * A {@link RunPublisher} that writes the A2A task store instead of an event bus. The SDK updates
 * the store only from events some request is CONSUMING; a run parked at `input-required` has no
 * consumer (the stream ended there), so what core does to it on its own (a timer expires an
 * interaction, the provider withdraws it, the next queued one is presented, the run is expired
 * or canceled behind the client's back) would never reach the stored task. This publisher feeds
 * the same events through the SDK's own `ResultManager`, so the stored task is updated exactly
 * as a consumed stream would have updated it.
 */

import { ResultManager, ServerCallContext } from "@a2a-js/sdk/server";
import type { ExecutionEventBus, TaskStore } from "@a2a-js/sdk/server";
import type { RunPublisher } from "../runtime/types.js";
import { createLogger } from "../utils/logger.js";
import { createBusPublisher } from "./bus-publisher.js";
import { contextForOwner } from "./orphan-task-store.js";

const log = createLogger("store-publisher");

/** Per-task write queues: events of one task reach the store in the order they were published, across publishers. */
const chains = new Map<string, Promise<void>>();

export interface StorePublisherIds {
  taskId: string;
  contextId: string;
  owner: { id: string; kind: string };
  tenant?: string;
}

/** Publish to `store` as the task's owner. Never throws; a failed write is logged. */
export function createStorePublisher(store: TaskStore, ids: StorePublisherIds, context?: ServerCallContext): RunPublisher {
  const ctx = context ?? contextForOwner(ids.owner, ids.tenant);
  const rm = new ResultManager(store, ctx);
  const bus = {
    publish(event: Parameters<ExecutionEventBus["publish"]>[0]) {
      const prev = chains.get(ids.taskId) ?? Promise.resolve();
      const next = prev
        .then(() => rm.processEvent(event))
        .catch((e) => log.warn(`writing the task store for ${ids.taskId} failed`, { error: e instanceof Error ? e.message : String(e) }));
      chains.set(ids.taskId, next);
      void next.then(() => {
        if (chains.get(ids.taskId) === next) chains.delete(ids.taskId);
      });
    },
    finished() {},
    on() {
      return bus;
    },
    off() {
      return bus;
    },
    once() {
      return bus;
    },
    removeAllListeners() {
      return bus;
    },
  } as unknown as ExecutionEventBus;
  return createBusPublisher(bus, { taskId: ids.taskId, contextId: ids.contextId });
}

/** Resolve when every queued store write of `taskId` has settled (tests, shutdown). */
export async function settleStoreWrites(taskId: string): Promise<void> {
  while (chains.has(taskId)) await chains.get(taskId);
}
