/**
 * Executor instrumentation — Hook A.
 *
 * Wraps `execute` / `cancelTask` once in {@link createA2AServer} so every
 * provider gets `a2a.task.*` spans without duplicating OTel in wrappers.
 *
 * @module telemetry/instrument
 */

import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import type { A2AExecutor } from "../executor/types.js";
import { withSpan } from "./api.js";
import { buildTaskSpanAttributes, slugAgentId } from "./attributes.js";
import { extractA2ATraceContext, runWithTaskOtelStore, type TaskOtelStore } from "./context.js";
import { resolveOtelEmissionPolicy, type OtelConfig } from "./types.js";

export interface InstrumentExecutorOptions {
  /** Optional otel block from agent config. */
  otel?: OtelConfig | null;
  /** e.g. "a2a-copilot" */
  wrapperName?: string;
  wrapperVersion?: string;
  protocolVersion?: string;
  agentName: string;
}

/**
 * Return an executor whose execute/cancelTask are wrapped with task spans.
 * Lifecycle methods are passed through unchanged.
 */
export function instrumentExecutor(
  executor: A2AExecutor,
  options: InstrumentExecutorOptions,
): A2AExecutor {
  const policy = resolveOtelEmissionPolicy(options.otel);
  const agentName = options.agentName;
  const agentId = slugAgentId(agentName);

  const wrappedExecute = async (ctx: RequestContext, bus: ExecutionEventBus): Promise<void> => {
    const taskId = ctx.taskId;
    const contextId = ctx.contextId;
    const trace = extractA2ATraceContext(ctx);
    const attrs = buildTaskSpanAttributes({
      taskId,
      contextId,
      agentName,
      agentId,
      wrapperName: options.wrapperName,
      wrapperVersion: options.wrapperVersion,
      protocolVersion: options.protocolVersion,
      parentAgentId: trace.parentAgentId,
      orchestratorTraceId: trace.traceId,
    });

    if (!policy.enabled) {
      // Still establish ALS with disabled policy so emitter hooks stay cheap/no-op.
      const store: TaskOtelStore = {
        policy,
        taskId,
        contextId,
        agentId,
        agentName,
        toolSpans: new Map(),
      };
      return runWithTaskOtelStore(store, () => executor.execute(ctx, bus));
    }

    return withSpan("a2a.task.execute", attrs, async (span) => {
      const store: TaskOtelStore = {
        span,
        policy,
        taskId,
        contextId,
        agentId,
        agentName,
        toolSpans: new Map(),
      };
      return runWithTaskOtelStore(store, () => executor.execute(ctx, bus));
    });
  };

  const wrappedCancel = executor.cancelTask
    ? async (taskId: string, bus: ExecutionEventBus): Promise<void> => {
        const attrs: Record<string, string | number | boolean> = {
          "a2a.task.id": taskId,
          "a2a.agent.name": agentName,
          "gen_ai.agent.name": agentName,
        };
        if (options.wrapperName) attrs["a2a.wrapper.name"] = options.wrapperName;

        if (!policy.enabled) {
          return executor.cancelTask!(taskId, bus);
        }

        return withSpan("a2a.task.cancel", attrs, async () => executor.cancelTask!(taskId, bus));
      }
    : undefined;

  return {
    initialize: () => executor.initialize(),
    shutdown: () => executor.shutdown(),
    execute: wrappedExecute,
    cancelTask: wrappedCancel,
    getContextContent: executor.getContextContent?.bind(executor),
    buildContext: executor.buildContext?.bind(executor),
  };
}
