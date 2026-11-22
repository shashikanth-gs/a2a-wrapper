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
 */

import { DefaultExecutionEventBusManager } from "@a2a-js/sdk/server";
import type { ExecutionEventBus, ServerCallContext } from "@a2a-js/sdk/server";
import type { RunRegistry } from "../runtime/run-registry.js";

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
    if (context) this.contexts.set(taskId, context);
    return super.createOrGetByTaskId(taskId, context);
  }

  settleByTaskId(taskId: string, _bus: ExecutionEventBus, _last: unknown, context: ServerCallContext): boolean {
    if (!this.registry.isLive(taskId)) return false;
    this.contexts.set(taskId, context);
    return true;
  }
}
