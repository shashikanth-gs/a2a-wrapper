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
    // A run parked on an interaction has no stream attached (the original one ended at input-required and
    // core closed it at auth-required), so a reply may open its stream with the stored task as the snapshot;
    // the SDK throws on a stream whose first event is a status update (spike S1, design doc 3.10.1).
    // A snapshot on a run that DOES have a stream attached would break that stream, so never then.
    const parked = live && this.registry.isParked(ctx.taskId);
    let claimed = false;
    if (!live) {
      if (ctx.task) bus.publish({ kind: "task", data: ctx.task });
      else publishTask(bus, ctx.taskId, ctx.contextId);
    } else if (parked) {
      // One snapshot per park, claimed synchronously: with two replies in flight (the window is the whole authorize
      // await) a second snapshot would land inside the first reply's lifecycle stream and break it.
      claimed = this.registry.beginReply(ctx.taskId);
      if (!claimed) {
        // This reply lost the race. It starts nothing and is never queued as a turn. Say so on the shared bus with a
        // plain status (harmless inside the winner's stream); a streaming request errors at its first event, as for any
        // message to a live task (#109), and a blocking one returns with the winner's result.
        const pub = createBusPublisher(bus, { taskId: ctx.taskId, contextId: ctx.contextId }, this.registry.publisherState);
        pub.status({ state: "working", text: "Another reply to this request is already being applied; this one was not used." });
        return;
      }
      if (ctx.task) bus.publish({ kind: "task", data: ctx.task });
    }
    try {
      const outcome = await this.registry.execute({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        caller: callerFromContext(ctx),
        publisher: createBusPublisher(bus, { taskId: ctx.taskId, contextId: ctx.contextId }, this.registry.publisherState),
        ...(ctx.userMessage ? { message: fromA2AMessage(ctx.userMessage) } : {}),
        request: (ids) => coreRequestFromContext(ctx, ids),
      });
      // Parked: the SDK itself stops listening at input-required but NOT at auth-required, where it keeps the
      // stream open for an executor that resumes on the same bus. Core resumes through the reply's own
      // attachment, so close this one at both (a stream left open would be broken by the reply's snapshot).
      if (outcome === "parked") bus.finished();
    } catch (e) {
      // While the task is live the bus is shared with the running turn: if this execute() rejected,
      // the SDK would publish Task + FAILED on that bus, a second terminal event. Never reject then.
      if (!live) throw e;
      log.warn(`execute() for live task ${ctx.taskId} failed; swallowed`, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (claimed) this.registry.endReply(ctx.taskId);
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    await this.registry.cancel(taskId, { ...ANONYMOUS_CALLER }, (ids) => createBusPublisher(bus, ids, this.registry.publisherState));
  }
}
