/**
 * @module a2a/store-publisher
 *
 * A {@link RunPublisher} that writes the A2A task store instead of an event bus. The SDK updates the store only from events some
 * request is CONSUMING; a run parked at `input-required` has no consumer (the stream ended there), so what core does to it on
 * its own (a timer expires an interaction, the provider withdraws it, the next queued one is presented, the run is expired
 * or canceled behind the client's back) would never reach the stored task. This publisher feeds the same events through the
 * SDK's own `ResultManager`, so the stored task is updated exactly as a consumed stream would have updated it.
 *
 * The per-task write queue (events of one task reach the store in the order they were published, across publishers) belongs
 * to a {@link StorePublisherFactory}, one per task store, so nothing is shared between servers in one process.
 */

import { ResultManager, ServerCallContext } from "@a2a-js/sdk/server";
import type { ExecutionEventBus, TaskStore } from "@a2a-js/sdk/server";
import type { RunPublisher } from "../runtime/types.js";
import { createLogger } from "../utils/logger.js";
import { createBusPublisher, type PublisherState } from "./bus-publisher.js";
import { contextForOwner } from "./orphan-task-store.js";

const log = createLogger("store-publisher");

export interface StorePublisherIds {
  taskId: string;
  contextId: string;
  owner: { id: string; kind: string };
  tenant?: string;
  /** The registry's `publisherState`, so this publisher knows which artifacts the run already started. */
  publisherState?: PublisherState;
}

/** Builds store publishers over one task store; usable as `RunRegistry.setDetachedPublisher`'s argument. */
export interface StorePublisherFactory {
  (ids: StorePublisherIds, context?: ServerCallContext): RunPublisher;
  /** Resolve when every queued store write of `taskId` has settled (tests, shutdown). */
  settle(taskId: string): Promise<void>;
}

/** A factory over `store` with its own per-task write queues. Never throws; a failed write is logged. */
export function createStorePublisherFactory(store: TaskStore): StorePublisherFactory {
  const chains = new Map<string, Promise<void>>();
  const factory = ((ids: StorePublisherIds, context?: ServerCallContext): RunPublisher => {
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
    return createBusPublisher(bus, { taskId: ids.taskId, contextId: ids.contextId }, ids.publisherState);
  }) as StorePublisherFactory;
  factory.settle = async (taskId) => {
    while (chains.has(taskId)) await chains.get(taskId);
  };
  return factory;
}

const defaults = new WeakMap<TaskStore, StorePublisherFactory>();

/** Publish to `store` as the task's owner (one shared factory per store instance). */
export function createStorePublisher(store: TaskStore, ids: StorePublisherIds, context?: ServerCallContext): RunPublisher {
  let f = defaults.get(store);
  if (!f) defaults.set(store, (f = createStorePublisherFactory(store)));
  return f(ids, context);
}
