/**
 * Executor instrumentation — Hook A.
 *
 * Wraps `execute` / `cancelTask` once in {@link createA2AServer} so every
 * provider gets **one** `a2a.task.execute` span per inbound request
 * (~99% case). We do not invent multi-span trees for “purposes.”
 *
 * Re-entry / retry (orchestrator calls again — the wrapper cannot block that):
 * still **one new span per request**, same `a2a.task.id` /
 * `gen_ai.conversation.id`, plus `a2a.task.invocation` /
 * `a2a.task.invocation_kind` so Langfuse/Datadog/Phoenix can join turns.
 *
 * @module telemetry/instrument
 */

import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import type { A2AExecutor } from "../executor/types.js";
import { withSpan } from "./api.js";
import {
  buildTaskSpanAttributes,
  slugAgentId,
  type TaskInvocationKind,
} from "./attributes.js";
import { extractA2ATraceContext, runWithTaskOtelStore, type TaskOtelStore } from "./context.js";
import {
  resolveOtelEmissionPolicy,
  type OtelConfig,
  type OtelSpanContextLike,
  type OtelSpanLinkLike,
} from "./types.js";

export interface InstrumentExecutorOptions {
  /** Optional otel block from agent config. */
  otel?: OtelConfig | null;
  /** e.g. "a2a-copilot" */
  wrapperName?: string;
  wrapperVersion?: string;
  protocolVersion?: string;
  agentName: string;
}

/** In-process execute() counts keyed by taskId (retries / continue). */
const taskInvocationCounts = new Map<string, number>();
/** Prior span contexts for optional span links on continue/retry. */
const lastSpanContexts = new Map<string, OtelSpanContextLike>();

function nextInvocation(taskId: string): number {
  const n = (taskInvocationCounts.get(taskId) ?? 0) + 1;
  taskInvocationCounts.set(taskId, n);
  // Bound memory: drop after a large number of distinct tasks.
  if (taskInvocationCounts.size > 10_000) {
    const first = taskInvocationCounts.keys().next().value;
    if (first !== undefined) {
      taskInvocationCounts.delete(first);
      lastSpanContexts.delete(first);
    }
  }
  return n;
}

function linkToPriorAttempt(
  taskId: string,
  invocation: number,
  kind: TaskInvocationKind,
): OtelSpanLinkLike[] | undefined {
  if (invocation <= 1) return undefined;
  const prev = lastSpanContexts.get(taskId);
  if (!prev) return undefined;
  return [
    {
      context: prev,
      attributes: {
        "a2a.task.link_reason": kind,
        "a2a.task.prior_invocation": invocation - 1,
      },
    },
  ];
}

function resolveInvocationKind(
  invocation: number,
  hasExistingTask: boolean,
): TaskInvocationKind {
  if (invocation === 1) return "new";
  if (hasExistingTask) return "continue";
  return "retry";
}

function extractMessageId(ctx: RequestContext): string | undefined {
  try {
    const msg = ctx.userMessage as { messageId?: string } | undefined;
    if (msg?.messageId) return msg.messageId;
    const req = (ctx as unknown as { request?: { params?: { message?: { messageId?: string } } } })
      .request;
    return req?.params?.message?.messageId;
  } catch {
    return undefined;
  }
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
    const invocation = nextInvocation(taskId);
    const hasExistingTask = Boolean(ctx.task);
    const invocationKind = resolveInvocationKind(invocation, hasExistingTask);
    const messageId = extractMessageId(ctx);
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
      messageId,
      invocation,
      invocationKind,
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

    const links = linkToPriorAttempt(taskId, invocation, invocationKind);
    return withSpan(
      "a2a.task.execute",
      attrs,
      async (span) => {
        const sc = span?.spanContext?.();
        if (sc?.traceId && sc?.spanId) lastSpanContexts.set(taskId, sc);
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
      },
      links ? { links } : undefined,
    );
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
