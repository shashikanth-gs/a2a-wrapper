/**
 * @module a2a/core-executor
 *
 * The SDK `AgentExecutor` over the run runtime. `execute` hands the request to
 * {@link RunRegistry.execute}; `cancelTask` is the single core-owned cancel entry
 * point ({@link RunRegistry.cancel}). A provider wrapper that implements
 * `ProviderExecutor` gets A2A cancel semantics (one terminal event, canceled
 * published before the abort, late events dropped, cancel at `input-required`,
 * orphans) without any cancel code of its own.
 *
 * Limitation: the SDK passes `cancelTask` only a task id and a bus, not the call
 * context, so the caller recorded for a cancel is `anonymous` until the SDK
 * exposes it (the authorization choke point already takes `by`).
 */

import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { publishTask } from "../events/event-publisher.js";
import type { A2AExecutor } from "../executor/types.js";
import { ANONYMOUS_CALLER } from "../model/index.js";
import { createLogger } from "../utils/logger.js";
import type { RunRegistry } from "../runtime/run-registry.js";
import { callerFromContext, coreRequestFromContext, fromA2AMessage } from "./adapter.js";
import { createBusPublisher } from "./bus-publisher.js";

const log = createLogger("core-executor");

export class CoreExecutor implements A2AExecutor {
  constructor(private readonly registry: RunRegistry) {}

  initialize(): Promise<void> {
    return this.registry.provider.initialize();
  }

  async shutdown(): Promise<void> {
    await this.registry.shutdown();
    await this.registry.provider.shutdown();
  }

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    // A stream must open with a Task event. Only when core has no live run for the task: with
    // one, the bus is shared with the stream that is already open (the reply and queue paths
    // belong to the interactions and steering runtimes, #108 and #109).
    const live = this.registry.isLive(ctx.taskId);
    if (!live) {
      if (ctx.task) bus.publish({ kind: "task", data: ctx.task });
      else publishTask(bus, ctx.taskId, ctx.contextId);
    }
    try {
      await this.registry.execute({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        caller: callerFromContext(ctx),
        publisher: createBusPublisher(bus, { taskId: ctx.taskId, contextId: ctx.contextId }),
        ...(ctx.userMessage ? { message: fromA2AMessage(ctx.userMessage) } : {}),
        request: (ids) => coreRequestFromContext(ctx, ids),
      });
    } catch (e) {
      // While the task is live the bus is shared with the running turn: if this execute() rejected,
      // the SDK would publish Task + FAILED on that bus, a second terminal event. Never reject then.
      if (!live) throw e;
      log.warn(`execute() for live task ${ctx.taskId} failed; swallowed`, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    await this.registry.cancel(taskId, { ...ANONYMOUS_CALLER }, (ids) => createBusPublisher(bus, ids));
  }
}
