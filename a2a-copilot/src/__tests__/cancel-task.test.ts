/**
 * Tests — CopilotExecutor.cancelTask aborts the backend session (#66)
 *
 * The Copilot SDK exposes `session.abort()`; cancelTask must call it so the
 * backend turn actually stops, not just mark the A2A task canceled. The SDK and
 * SessionManager are faked so nothing touches the network or spawns a CLI.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestContext } from "@a2a-js/sdk/server";
import { TaskState } from "@a2a-js/sdk";

import { CopilotExecutor } from "../copilot/executor.js";
import type { CopilotSession } from "../copilot/session-manager.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TERMINAL = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

function makeConfig(opts: { streaming?: boolean; chunks?: boolean } = {}): any {
  return {
    agentCard: { name: "Test Agent", description: "test" },
    server: { port: 3000, hostname: "0.0.0.0", advertiseHost: "localhost", advertiseProtocol: "http" },
    copilot: {
      cliUrl: "",
      model: "gpt-4",
      streaming: opts.streaming !== false,
      systemPrompt: "",
      systemPromptMode: "append",
      contextFile: "context.md",
      contextPrompt: "",
      workspaceDirectory: "",
    },
    session: { reuseByContext: true, ttl: 3_600_000, cleanupInterval: 300_000, titlePrefix: "A2A" },
    features: { streamArtifactChunks: opts.chunks === true, trackUsage: false },
    timeouts: { prompt: 600_000 },
    logging: { level: "error" },
    mcp: {},
    customAgents: [],
    events: { enabled: true, transport: "a2a" },
    memory: undefined,
    configDir: undefined,
    subAgents: undefined,
  };
}

function makeCtx(taskId = "task-1", contextId = "ctx-1"): RequestContext {
  return {
    taskId,
    contextId,
    userMessage: {
      messageId: "m1",
      contextId,
      taskId: "",
      role: 1,
      parts: [{ content: { $case: "text", value: "hello" }, metadata: undefined }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    task: null,
  } as unknown as RequestContext;
}

function makeBus() {
  const events: any[] = [];
  const bus: any = {
    events,
    publish: vi.fn((e: any) => { events.push(e); }),
    finished: vi.fn(),
  };
  return bus;
}

const states = (events: any[]) =>
  events.filter((e) => e.kind === "statusUpdate").map((e) => e.data.status.state as TaskState);
const terminals = (events: any[]) => states(events).filter((s) => TERMINAL.has(s));

/** Session whose turn stays "running" until the test (or abort) ends it. */
function makeSession() {
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  let rejectSendAndWait: ((e: Error) => void) | undefined;
  const session = {
    sessionId: "sess-1",
    on: vi.fn((event: string, h: (e: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(h);
      return () => {
        const arr = handlers.get(event) ?? [];
        const i = arr.indexOf(h);
        if (i !== -1) arr.splice(i, 1);
      };
    }),
    send: vi.fn(async () => {}), // streaming: never idles on its own
    sendAndWait: vi.fn(
      () => new Promise<any>((_res, rej) => { rejectSendAndWait = rej; }), // non-streaming: pending
    ),
    abort: vi.fn(async () => {
      // Like the real SDK, an aborted sendAndWait rejects.
      rejectSendAndWait?.(new Error("Request aborted"));
    }),
    disconnect: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    emit(event: string, data?: unknown) {
      for (const h of [...(handlers.get(event) ?? [])]) h({ data });
    },
    listenerCount(event: string) {
      return handlers.get(event)?.length ?? 0;
    },
  };
  return session as typeof session & CopilotSession;
}

function setup(config: any, session = makeSession()) {
  const executor = new CopilotExecutor(config);
  vi.spyOn(executor as any, "initialize").mockResolvedValue(undefined);
  const sessionManager = {
    getOrCreate: vi.fn(async () => ({ sessionId: session.sessionId, session, isNew: true })),
    trackTask: vi.fn(),
    untrackTask: vi.fn(),
    getSessionForTask: vi.fn(),
    getContextForTask: vi.fn(() => "ctx-1"),
    destroySession: vi.fn(async () => {}),
    startCleanup: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  (executor as any).sessionManager = sessionManager;
  (executor as any).mcpHooks = { setEmitter: vi.fn(), clearEmitter: vi.fn() };
  return { executor, session, sessionManager, bus: makeBus() };
}

/** Let queued microtasks and a macrotask turn run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Cancel while a prompt is running ────────────────────────────────────────

describe("cancelTask aborts the backend session", () => {
  it("streaming: calls session.abort(), publishes canceled once, no completed/failed", async () => {
    const { executor, session, bus } = setup(makeConfig({ streaming: true }));

    const running = executor.execute(makeCtx(), bus);
    await tick();
    expect(session.send).toHaveBeenCalledTimes(1);

    await executor.cancelTask("task-1", bus);
    await running;

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
    expect(states(bus.events)).not.toContain(TaskState.TASK_STATE_COMPLETED);
    expect(states(bus.events)).not.toContain(TaskState.TASK_STATE_FAILED);
    expect(bus.finished).toHaveBeenCalledTimes(1);
    // The canceled event carries the real contextId, not "".
    const canceled = bus.events.find((e: any) => e.data?.status?.state === TaskState.TASK_STATE_CANCELED);
    expect(canceled.data.contextId).toBe("ctx-1");
  });

  it("non-streaming: aborts, and the rejected sendAndWait is not reported as failed", async () => {
    const { executor, session, bus } = setup(makeConfig({ streaming: false }));

    const running = executor.execute(makeCtx(), bus);
    await tick();
    await executor.cancelTask("task-1", bus);
    await running;

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
    expect(bus.finished).toHaveBeenCalledTimes(1);
  });

  it("drops late events from the aborted turn (never publishes after canceled)", async () => {
    const { executor, session, bus } = setup(makeConfig({ streaming: true, chunks: true }));

    const running = executor.execute(makeCtx(), bus);
    await tick();
    await executor.cancelTask("task-1", bus);
    await running;
    const countAtCancel = bus.events.length;

    // The aborted turn keeps talking: deltas, tool progress, even an idle.
    session.emit("assistant.message_delta", { deltaContent: "late text" });
    session.emit("tool.execution_start", { toolName: "bash" });
    session.emit("session.idle");
    await tick();

    expect(bus.events.length).toBe(countAtCancel);
    expect(bus.finished).toHaveBeenCalledTimes(1);
    // Listeners were removed, so they cannot leak into the next turn.
    expect(session.listenerCount("assistant.message_delta")).toBe(0);
    expect(session.listenerCount("session.idle")).toBe(0);
  });

  it("a following message in the same context reuses the aborted session cleanly", async () => {
    const { executor, session, sessionManager } = setup(makeConfig({ streaming: true }));

    const bus1 = makeBus();
    const first = executor.execute(makeCtx("task-1"), bus1);
    await tick();
    await executor.cancelTask("task-1", bus1);
    await first;

    // Second turn on the same session completes normally.
    session.send.mockImplementation(async () => {
      session.emit("assistant.message_delta", { deltaContent: "fresh answer" });
      session.emit("session.idle");
    });
    const bus2 = makeBus();
    await executor.execute(makeCtx("task-2"), bus2);

    expect(terminals(bus2.events)).toEqual([TaskState.TASK_STATE_COMPLETED]);
    const artifact = JSON.stringify(bus2.events.filter((e: any) => e.kind === "artifactUpdate"));
    expect(artifact).toContain("fresh answer");
    expect(artifact).not.toContain("late text");
    // Abort succeeded, so the session was kept (not destroyed).
    expect(sessionManager.destroySession).not.toHaveBeenCalled();
  });

  it("cancel while the session is still being created: never sends the prompt", async () => {
    const { executor, session, sessionManager, bus } = setup(makeConfig({ streaming: true }));
    let release!: () => void;
    sessionManager.getOrCreate.mockImplementation(
      () => new Promise((res) => {
        release = () => res({ sessionId: session.sessionId, session, isNew: true });
      }),
    );

    const running = executor.execute(makeCtx(), bus);
    await tick();
    await executor.cancelTask("task-1", bus);
    release();
    await running;

    expect(session.send).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
  });
});

// ─── Unknown / finished tasks, idempotency, racing completion ────────────────

describe("cancelTask is safe and idempotent", () => {
  it("unknown task: no throw, no events, no abort", async () => {
    const { executor, session, bus } = setup(makeConfig());

    await expect(executor.cancelTask("does-not-exist", bus)).resolves.toBeUndefined();

    expect(bus.events).toEqual([]);
    expect(bus.finished).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("cancel after completion publishes nothing and does not abort", async () => {
    const { executor, session, bus } = setup(makeConfig({ streaming: true }));
    session.send.mockImplementation(async () => {
      session.emit("assistant.message_delta", { deltaContent: "done" });
      session.emit("session.idle");
    });

    await executor.execute(makeCtx(), bus);
    const before = bus.events.length;
    await executor.cancelTask("task-1", bus);

    expect(bus.events.length).toBe(before);
    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_COMPLETED]);
    expect(bus.finished).toHaveBeenCalledTimes(1);
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("double cancel aborts and publishes only once", async () => {
    const { executor, session, bus } = setup(makeConfig({ streaming: true }));

    const running = executor.execute(makeCtx(), bus);
    await tick();
    await Promise.all([executor.cancelTask("task-1", bus), executor.cancelTask("task-1", bus)]);
    await running;

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
    expect(bus.finished).toHaveBeenCalledTimes(1);
  });

  it("cancel racing completion yields exactly one terminal state (completion already finalizing wins)", async () => {
    const { executor, session, bus } = setup(makeConfig({ streaming: true }));
    session.send.mockImplementation(async () => {
      session.emit("assistant.message_delta", { deltaContent: "answer" });
      session.emit("session.idle");
    });
    // Land the cancel exactly when execute starts publishing its final artifact.
    let cancelDuringFinalize: Promise<void> | undefined;
    bus.publish.mockImplementation((e: any) => {
      bus.events.push(e);
      if (e.kind === "artifactUpdate" && JSON.stringify(e).includes("answer") && !cancelDuringFinalize) {
        cancelDuringFinalize = executor.cancelTask("task-1", bus);
      }
    });

    await executor.execute(makeCtx(), bus);
    await cancelDuringFinalize;

    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_COMPLETED]);
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("cancel arriving before completion finalizes wins and suppresses completed", async () => {
    const { executor, session, bus } = setup(makeConfig({ streaming: true }));
    // Idle fires, but the cancel lands in the same tick, before execute resumes.
    session.send.mockImplementation(async () => {
      session.emit("assistant.message_delta", { deltaContent: "answer" });
      session.emit("session.idle");
      void executor.cancelTask("task-1", bus);
    });

    await executor.execute(makeCtx(), bus);
    await tick();

    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
  });
});

// ─── Abort failure and cleanup of handles ────────────────────────────────────

describe("abort failure handling and handle cleanup", () => {
  it("publishes canceled before a slow abort() settles (the SDK closes the bus once execute returns)", async () => {
    const { executor, session, bus } = setup(makeConfig({ streaming: true }));
    let finishAbort!: () => void;
    session.abort.mockImplementation(() => new Promise<void>((r) => { finishAbort = r; }));

    const running = executor.execute(makeCtx(), bus);
    await tick();
    const cancelling = executor.cancelTask("task-1", bus);
    await tick();

    // abort() has not answered yet, but the terminal event is already out and
    // execute has unwound; nothing is left to publish after the SDK closes the bus.
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
    expect(bus.finished).toHaveBeenCalledTimes(1);
    await running;

    finishAbort();
    await cancelling;
    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
  });

  it("abort() rejecting still cancels, and discards the session so the next turn starts clean", async () => {
    const { executor, session, sessionManager, bus } = setup(makeConfig({ streaming: true }));
    session.abort.mockRejectedValue(new Error("connection lost"));

    const running = executor.execute(makeCtx(), bus);
    await tick();
    await executor.cancelTask("task-1", bus);
    await running;

    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
    expect(sessionManager.destroySession).toHaveBeenCalledWith("ctx-1");
  });

  it("abort() hanging is bounded by a timeout, then the session is discarded", async () => {
    vi.useFakeTimers();
    const { executor, session, sessionManager, bus } = setup(makeConfig({ streaming: true }));
    session.abort.mockImplementation(() => new Promise<void>(() => {}));

    const running = executor.execute(makeCtx(), bus);
    await vi.advanceTimersByTimeAsync(0);
    const cancelling = executor.cancelTask("task-1", bus);
    await vi.advanceTimersByTimeAsync(5_000);
    await cancelling;
    await running;

    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_CANCELED]);
    expect(sessionManager.destroySession).toHaveBeenCalledWith("ctx-1");
    // The abort timeout timer and the prompt timer are both cleared.
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("no timers or listeners leak after cancel (streaming=%s)", async (streaming) => {
    vi.useFakeTimers();
    const { executor, session, bus } = setup(makeConfig({ streaming }));

    const running = executor.execute(makeCtx(), bus);
    await vi.advanceTimersByTimeAsync(0);
    await executor.cancelTask("task-1", bus);
    await running;

    expect(vi.getTimerCount()).toBe(0);
    for (const ev of ["assistant.usage", "session.usage_info", "session.idle"]) {
      expect(session.listenerCount(ev)).toBe(0);
    }
    expect((executor as any).runs.size).toBe(0);
  });

  it("non-streaming: the prompt timeout timer is cleared after a normal completion", async () => {
    vi.useFakeTimers();
    const { executor, session, bus } = setup(makeConfig({ streaming: false }));
    session.sendAndWait.mockResolvedValue({ data: { content: "ok" } });

    await executor.execute(makeCtx(), bus);

    expect(terminals(bus.events)).toEqual([TaskState.TASK_STATE_COMPLETED]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
