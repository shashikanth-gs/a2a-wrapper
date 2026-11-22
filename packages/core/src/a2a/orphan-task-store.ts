/**
 * @module a2a/orphan-task-store
 *
 * `TaskStore` wrapper that closes the SDK 1.3 cancel hole. With no event bus for a
 * task, `DefaultRequestHandler.cancelTask` writes `CANCELED` straight to the store
 * and never calls the executor: a run that core still lists as active but has no
 * live handle for (the process restarted) would be canceled on paper while its
 * backend keeps working. This wrapper notices that save and hands the task to
 * {@link RunRegistry.handleStoreCancel}, which calls `abortOrphan`.
 */

import { TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import type { TaskStore } from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";
import { Role } from "@a2a-js/sdk";
import type { RunRegistry, SweepOptions } from "../runtime/run-registry.js";

type SdkTask = Parameters<TaskStore["save"]>[0];

export class OrphanGuardTaskStore implements TaskStore {
  constructor(
    private readonly inner: TaskStore,
    private readonly registry: RunRegistry,
  ) {}

  async save(task: SdkTask, context: ServerCallContext): Promise<void> {
    await this.inner.save(task, context);
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
      // Not awaited: the store must not block on the provider. Failures are the registry's to log.
      void this.registry.handleStoreCancel(task.id).catch(() => {});
    }
  }

  load(taskId: string, context: ServerCallContext): ReturnType<TaskStore["load"]> {
    return this.inner.load(taskId, context);
  }

  list(params: Parameters<TaskStore["list"]>[0], context: ServerCallContext): ReturnType<TaskStore["list"]> {
    return this.inner.list(params, context);
  }
}

/**
 * `SweepOptions.endTask` over a `TaskStore`: mark the task `failed` with the sweep's
 * reason, so a client that asks sees it instead of a task stuck in `working`.
 */
export function endTaskInStore(
  store: TaskStore,
  context?: ServerCallContext | ((info: { owner: { id: string; kind: string }; tenant?: string }) => ServerCallContext),
): NonNullable<SweepOptions["endTask"]> {
  return async ({ taskId, contextId, reason, owner, tenant }) => {
    // Owner-scoped stores find a task only under its owner and tenant: use the run record's.
    const ctx =
      typeof context === "function"
        ? context({ owner, ...(tenant ? { tenant } : {}) })
        : (context ??
          new ServerCallContext({
            user: { isAuthenticated: owner.id !== "anonymous", userName: owner.id === "anonymous" ? "" : owner.id },
            ...(tenant ? { tenant } : {}),
          }));
    const task = await store.load(taskId, ctx);
    if (!task) return;
    const s = task.status?.state;
    if (s === TaskState.TASK_STATE_COMPLETED || s === TaskState.TASK_STATE_FAILED || s === TaskState.TASK_STATE_CANCELED || s === TaskState.TASK_STATE_REJECTED) return;
    task.status = {
      state: TaskState.TASK_STATE_FAILED,
      timestamp: new Date().toISOString(),
      message: {
        messageId: uuidv4(),
        taskId,
        contextId,
        role: Role.ROLE_AGENT,
        parts: [{ content: { $case: "text", value: reason }, mediaType: "text/plain", filename: "", metadata: {} }],
        metadata: {},
        extensions: [],
        referenceTaskIds: [],
      },
    };
    await store.save(task, ctx);
  };
}
