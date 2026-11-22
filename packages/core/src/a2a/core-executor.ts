/**
 * @module a2a/core-executor
 *
 * The SDK `AgentExecutor` over the run runtime. `execute` hands the request to
 * {@link RunRegistry.execute}; `cancelTask` is the single core-owned cancel entry
 * point ({@link RunRegistry.cancel}). A provider wrapper that implements
 * `ProviderExecutor` gets A2A cancel semantics (one terminal event, canceled
 * published before the abort, late events dropped, cancel at `input-required`,
 * orphans) and steering (`queue`, `steer`, `interrupt`) without any code of its own.
 *
 * ### A message to a task that is already running (design doc 3.12)
 *
 * The SDK would run a second `execute()` on the bus the running one publishes on, where nothing can be said without
 * breaking a stream (spike S2). `RunEventBusManager` therefore gives such a request a PRIVATE bus, and this executor
 * answers on it with exactly one `Message` carrying the `DeliveryResult` (`urn:a2a-wrapper:delivery-result:v1`):
 * the client never gets an error for a message that will be delivered, a blocking `message/send` returns at once
 * with that Message (not at the end of the task) and the task's own stream and store are untouched. The one
 * request per park that may carry a parked or interrupted task on (a reply, an `interrupt` that preempts an
 * interaction, a message that continues an interrupted task) keeps the shared bus and gets the Task snapshot first.
 *
 * Limitation: the SDK passes `cancelTask` only a task id and a bus, not the call
 * context, so the caller recorded for a cancel is `anonymous` until the SDK
 * exposes it (the authorization choke point already takes `by`).
 */

import { TaskState } from "@a2a-js/sdk";
import type { Message, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { publishTask } from "../events/event-publisher.js";
import type { A2AExecutor } from "../executor/types.js";
import { ANONYMOUS_CALLER, type DeliveryResult } from "../model/index.js";
import { createLogger } from "../utils/logger.js";
import type { RunRegistry } from "../runtime/run-registry.js";
import type { RunPublisher } from "../runtime/types.js";
import {
  callerFromContext,
  coreRequestFromContext,
  deliveryResultText,
  deliveryResultToMetadata,
  fromA2AMessage,
  toDeliveryAckMessage,
  toStatusUpdate,
} from "./adapter.js";
import { isPrivateBus, takeReplyClaim } from "./bus-manager.js";
import { createBusPublisher } from "./bus-publisher.js";

const log = createLogger("core-executor");

/** What a request with a private bus hands the registry as its stream: nothing, its answer is the one Message. */
const SILENT_PUBLISHER: RunPublisher = {
  status() {},
  interaction() {},
  event() {},
  artifact() {},
  finished() {},
};

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
    // A message to a task that is running (or a second reply to a parked one) has a private bus: answer it with one Message.
    if (isPrivateBus(bus)) return this.answer(ctx, bus);

    // A stream must open with a Task event. Only when core has no live run for the task: with
    // one, the bus is shared with the stream that is already open.
    const live = this.registry.isLive(ctx.taskId);
    // A run parked on an interaction (or interrupted) has no stream attached (the original one ended at input-required and
    // core closed it at auth-required), so the one request that carries it on opens its stream with the stored task as the
    // snapshot; the SDK throws on a stream whose first event is a status update (spike S1, design doc 3.10.1).
    // A snapshot on a run that DOES have a stream attached would break that stream, so never then.
    const parked = live && this.registry.isParked(ctx.taskId);
    // The bus manager takes the park's reply claim when it hands the shared bus out; without it, claim here.
    let claimed = takeReplyClaim(ctx.context);
    if (!live) {
      if (ctx.task) bus.publish({ kind: "task", data: ctx.task });
      else publishTask(bus, ctx.taskId, ctx.contextId);
    } else if (parked) {
      // One snapshot per park, claimed synchronously: with two replies in flight a second snapshot would land inside the
      // first one's lifecycle stream and break it.
      claimed = claimed || this.registry.beginReply(ctx.taskId);
      if (!claimed) {
        // Only without the bus manager (it gives the loser a private bus): this request starts nothing and is never
        // queued as a turn. Say so on the shared bus with a plain status (harmless inside the winner's stream).
        const pub = createBusPublisher(bus, { taskId: ctx.taskId, contextId: ctx.contextId }, this.registry.publisherState);
        pub.status({ state: "working", text: "Another reply to this request is already being applied; this one was not used." });
        return;
      }
      if (ctx.task) bus.publish({ kind: "task", data: ctx.task });
    }
    const ids = { taskId: ctx.taskId, contextId: ctx.contextId };
    try {
      const caller = callerFromContext(ctx);
      const outcome = await this.registry.execute({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        caller,
        publisher: createBusPublisher(bus, ids, this.registry.publisherState),
        ...(ctx.userMessage ? { message: fromA2AMessage(ctx.userMessage, { from: caller }) } : {}),
        request: (reqIds) => coreRequestFromContext(ctx, reqIds),
        ...(claimed
          ? {
              // This request holds the shared bus of a parked task: say what core did with the message on it.
              onDelivery: (result: DeliveryResult, info: { resumed: boolean }) => bus.publish({
                kind: "statusUpdate",
                data: info.resumed ? resumedStatus(ids, result) : reassertedStatus(ctx, ids, result),
              }),
            }
          : {}),
      });
      // Parked: the SDK itself stops listening at input-required but NOT at auth-required, where it keeps the
      // stream open for an executor that resumes on the same bus. Core resumes through the reply's own
      // attachment, so close this one at both (a stream left open would be broken by the reply's snapshot).
      // A message that was only delivered (queued behind the interaction, steered, rejected) has nothing more to stream.
      if (outcome === "parked" || (claimed && (outcome === "queued" || outcome === "delivered" || outcome === "reply"))) {
        bus.finished();
      }
    } catch (e) {
      // While the task is live the bus is shared with the running turn: if this execute() rejected,
      // the SDK would publish Task + FAILED on that bus, a second terminal event. Never reject then.
      if (!live) throw e;
      log.warn(`execute() for live task ${ctx.taskId} failed; swallowed`, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (claimed) this.registry.endReply(ctx.taskId);
    }
  }

  /**
   * Answer a message that arrived for a task that is already running, on its private bus: hand it to the registry
   * (which delivers it by its `delivery`) and publish the {@link DeliveryResult} as one Message. Never rejects and never
   * leaves the request without an answer.
   */
  private async answer(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const ids = { taskId: ctx.taskId, contextId: ctx.contextId };
    const messageId = ctx.userMessage?.messageId ?? "";
    let answered = false;
    const reply = (result: DeliveryResult): void => {
      if (answered) return;
      answered = true;
      const message: Message = toDeliveryAckMessage(result, ids);
      bus.publish({ kind: "message", data: message });
      bus.finished();
    };
    try {
      const caller = callerFromContext(ctx);
      const message = ctx.userMessage ? fromA2AMessage(ctx.userMessage, { from: caller }) : undefined;
      if (!this.registry.isLive(ctx.taskId)) {
        // It ended between the SDK's checks and now: never start a new run for it from here.
        reply({ state: "rejected", ...ids, messageId, reason: "task-ended", detail: "the task is no longer running" });
      } else if (message && message.delivery === undefined && this.registry.isParked(ctx.taskId)) {
        // No `delivery` on a message to a parked task: it may be the reply to the open request, and only one reply per
        // park can carry the task on. Do not queue it as a turn (a late "yes" would run as one); say it was not used.
        reply({
          state: "rejected",
          ...ids,
          messageId,
          reason: "reply-conflict",
          detail: "another reply to this task's open request is being applied; resend with a delivery (queue, steer or interrupt) if this is a new message",
        });
      } else {
        await this.registry.execute({
          ...ids,
          caller,
          publisher: SILENT_PUBLISHER,
          ...(message ? { message } : {}),
          request: (reqIds) => coreRequestFromContext(ctx, reqIds),
          carriesStream: false,
          onDelivery: (result) => reply(result),
        });
      }
    } catch (e) {
      log.warn(`answering a message to live task ${ctx.taskId} failed`, { error: e instanceof Error ? e.message : String(e) });
    } finally {
      reply({ state: "rejected", ...ids, messageId, reason: "not-delivered", detail: "core did not report what happened to the message" });
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    await this.registry.cancel(taskId, { ...ANONYMOUS_CALLER }, (ids) => createBusPublisher(bus, ids, this.registry.publisherState));
  }
}

/** The request now carries the run on: a `working` status whose message tells the caller what was done with its message. */
function resumedStatus(ids: { taskId: string; contextId: string }, result: DeliveryResult): TaskStatusUpdateEvent {
  return toStatusUpdate({
    ...ids,
    state: "working",
    text: deliveryResultText(result),
    messageMetadata: deliveryResultToMetadata(result),
  });
}

/**
 * The message did not resume the task (it waits behind the open request, was steered or refused). Say so WITHOUT
 * replacing the task's status: re-assert the stored status (state and message, here the prompt of the open request)
 * with the delivery result added to that message's metadata. The message keeps its id, so the history gets no duplicate.
 */
function reassertedStatus(ctx: RequestContext, ids: { taskId: string; contextId: string }, result: DeliveryResult): TaskStatusUpdateEvent {
  const status = ctx.task?.status;
  const base = status?.message;
  if (!status || !base) {
    return toStatusUpdate({
      ...ids,
      state: "input-required",
      text: deliveryResultText(result),
      messageMetadata: deliveryResultToMetadata(result),
    });
  }
  const state: TaskState = status.state;
  return {
    ...ids,
    status: {
      state,
      message: { ...structuredClone(base), metadata: { ...(base.metadata ?? {}), ...deliveryResultToMetadata(result) } },
      timestamp: new Date().toISOString(),
    },
    metadata: undefined,
  };
}
