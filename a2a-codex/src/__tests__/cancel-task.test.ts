/**
 * Tests — CodexExecutor.cancelTask
 *
 * Cancel is looked up by taskId (it used the contextId before), publishes
 * `canceled` exactly once, stops the Codex turn through the run's abort signal,
 * and is idempotent. The Codex client and thread are faked.
 */

import { describe, it, expect, vi } from "vitest";
import type { RequestContext } from "@a2a-js/sdk/server";
import { TaskState } from "@a2a-js/sdk";

import { CodexExecutor } from "../codex/executor.js";
import { SessionManager } from "../codex/session-manager.js";

const TERMINAL = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
]);

function makeConfig(): any {
  return {
    agentCard: { name: "Test Agent", description: "test" },
    server: { port: 3000, hostname: "0.0.0.0", advertiseHost: "localhost", advertiseProtocol: "http" },
    codex: { model: "m", workingDirectory: "" },
    session: { reuseByContext: true, ttl: 3_600_000, cleanupInterval: 0 },
    features: { streamArtifactChunks: false },
    timeouts: { prompt: 600_000 },
    logging: { level: "error" },
    mcp: {},
    events: { enabled: true, transport: "a2a" },
  };
}

function makeCtx(taskId: string, contextId = "ctx-1"): RequestContext {
  return {
    taskId,
    contextId,
    userMessage: {
      messageId: "m1", contextId, taskId: "", role: 1,
      parts: [{ content: { $case: "text", value: "hello" }, metadata: undefined }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    },
    task: null,
  } as unknown as RequestContext;
}

function makeBus() {
  const events: any[] = [];
  return { events, publish: vi.fn((e: any) => { events.push(e); }), finished: vi.fn() } as any;
}
const states = (events: any[]) =>
  events.filter((e) => e.kind === "statusUpdate").map((e) => e.data.status.state as TaskState);
const terminals = (events: any[]) => states(events).filter((s) => TERMINAL.has(s));

/** A thread whose streamed turn hangs until its signal aborts, like the real CLI. */
function makeThread() {
  const signals: AbortSignal[] = [];
  const thread = {
    id: null,
    runStreamed: vi.fn(async (_input: string, opts?: { signal?: AbortSignal }) => {
      signals.push(opts!.signal!);
      async function* events() {
        yield { type: "thread.started", thread_id: "t-1" };
        await new Promise<void>((_res, rej) =>
          opts!.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))),
        );
      }
      return { events: events() };
    }),
    run: vi.fn(),
  };
  return { thread, signals };
}

function makeExecutor(thread: unknown) {
  const config = makeConfig();
  const executor: any = new CodexExecutor(config);
  const client = { startThread: vi.fn(() => thread), resumeThread: vi.fn(() => thread) };
  executor.client = client;
  executor.sessionManager = new SessionManager(client as any, config);
  executor.initialized = true;
  return executor as CodexExecutor;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("CodexExecutor.cancelTask", () => {
  it("cancels by taskId, aborts the turn and publishes one canceled", async () => {
    const { thread, signals } = makeThread();
    const executor = makeExecutor(thread);
    const bus = makeBus();

    const running = executor.execute(makeCtx("task-1", "ctx-1"), bus);
    await tick();
    expect(signals).toHaveLength(1);

    await executor.cancelTask("task-1", bus);
    await running;

    expect(signals[0].aborted).toBe(true);
    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
    expect(bus.events.find((e: any) => e.kind === "statusUpdate" && TERMINAL.has(e.data.status.state))?.data.taskId).toBe("task-1");
  });

  it("is idempotent and a no-op for unknown tasks", async () => {
    const { thread } = makeThread();
    const executor = makeExecutor(thread);
    const bus = makeBus();

    await executor.cancelTask("nope", bus);
    expect(bus.events).toHaveLength(0);

    const running = executor.execute(makeCtx("task-2"), bus);
    await tick();
    await executor.cancelTask("task-2", bus);
    await executor.cancelTask("task-2", bus);
    await running;
    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
  });

  it("cancels a turn that is still queued behind another one without starting it", async () => {
    const { thread } = makeThread();
    const executor = makeExecutor(thread);
    const busA = makeBus();
    const busB = makeBus();

    const a = executor.execute(makeCtx("task-a", "ctx-q"), busA);
    await tick();
    const b = executor.execute(makeCtx("task-b", "ctx-q"), busB); // same context: queued behind a
    await tick();
    expect(thread.runStreamed).toHaveBeenCalledTimes(1);

    await executor.cancelTask("task-b", busB);
    await executor.cancelTask("task-a", busA);
    await Promise.all([a, b]);

    expect(thread.runStreamed).toHaveBeenCalledTimes(1); // b never started
    expect(terminals(busB.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
    expect(terminals(busA.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
  });

  it("keeps the thread usable for the next message in the context", async () => {
    const { thread } = makeThread();
    const executor = makeExecutor(thread);
    const bus = makeBus();
    const first = executor.execute(makeCtx("task-1", "ctx-u"), bus);
    await tick();
    await executor.cancelTask("task-1", bus);
    await first;

    const bus2 = makeBus();
    const second = executor.execute(makeCtx("task-2", "ctx-u"), bus2);
    await tick();
    expect(thread.runStreamed).toHaveBeenCalledTimes(2);
    await executor.cancelTask("task-2", bus2);
    await second;
  });
});
