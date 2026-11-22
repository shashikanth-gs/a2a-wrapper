/**
 * @module a2a/bus-manager
 *
 * `ExecutionEventBusManager` that lets the run runtime own the event bus lifetime
 * (SDK 1.3 `settleByTaskId`). The SDK offers the manager the decision when
 * `execute()` returns. While core has a live run for the task (for example one
 * parked at `input-required`), the manager takes ownership and keeps the bus; core
 * itself finishes the stream and releases the bus when the run's terminal event is
 * out. With no live run the manager declines and the SDK's own policy applies, so
 * tasks the runtime does not run behave exactly as before.
 *
 * ### One bus per task, except for a message that cannot carry the run (design doc 3.12)
 *
 * The SDK gives every request for a task the SAME bus, and every request's stream sees every event of every
 * `execute()` on it (spike S2). A message posted to a task that is already working therefore has no safe first
 * event on the shared bus: a Task or Message breaks the stream that is running, a status update breaks its own.
 * `createOrGetByTaskId` is the seam: for a live task it hands out
 *
 * - the shared bus to the ONE request that may carry the run on (a reply to a parked task, or any message that
 *   continues an interrupted one): the first request of a task, and the winner of the parked task's reply claim;
 * - a PRIVATE bus to every other request (a message to a working task; a second reply to a parked one), so
 *   `CoreExecutor` can answer it with a single Message and never touch the shared stream.
 */

import { DefaultExecutionEventBus, DefaultExecutionEventBusManager } from "@a2a-js/sdk/server";
import type { ExecutionEventBus, ServerCallContext } from "@a2a-js/sdk/server";
import type { RunRegistry } from "../runtime/run-registry.js";

/** Buses handed out for a request that only gets an answer, never the run's stream. */
const privateBuses = new WeakSet<object>();
/** Call contexts that took the parked task's reply claim when their bus was created. */
const replyClaims = new WeakSet<object>();

/** Is `bus` a private answer bus (see the module doc)? */
export function isPrivateBus(bus: ExecutionEventBus): boolean {
  return privateBuses.has(bus);
}

/** Did the request with this call context take the parked task's reply claim (the caller must release it)? Consumes the mark. */
export function takeReplyClaim(context: ServerCallContext | undefined): boolean {
  if (!context || !replyClaims.has(context)) return false;
  replyClaims.delete(context);
  return true;
}

export class RunEventBusManager extends DefaultExecutionEventBusManager {
  private readonly contexts = new Map<string, ServerCallContext>();

  constructor(private readonly registry: RunRegistry) {
    super();
    registry.onSettled(({ taskId }) => {
      const ctx = this.contexts.get(taskId);
      this.contexts.delete(taskId);
      super.cleanupByTaskId(taskId, ctx);
    });
  }

  override createOrGetByTaskId(taskId: string, context?: ServerCallContext): ExecutionEventBus {
    if (this.registry.isLive(taskId)) {
      // A parked task may be answered: one request (the claim winner) carries the run on, on the shared bus.
      if (context && this.registry.isParked(taskId) && this.registry.beginReply(taskId)) {
        replyClaims.add(context);
        this.contexts.set(taskId, context);
        return super.createOrGetByTaskId(taskId, context);
      }
      const bus = new DefaultExecutionEventBus();
      privateBuses.add(bus);
      return bus;
    }
    if (context) this.contexts.set(taskId, context);
    return super.createOrGetByTaskId(taskId, context);
  }

  settleByTaskId(taskId: string, _bus: ExecutionEventBus, _last: unknown, context: ServerCallContext): boolean {
    if (!this.registry.isLive(taskId)) return false;
    // A private answer bus is not the task's bus: keep it from replacing the call context the shared one is cleaned up with.
    if (!isPrivateBus(_bus)) this.contexts.set(taskId, context);
    return true;
  }
}
