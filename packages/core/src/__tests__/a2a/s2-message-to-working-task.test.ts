/**
 * SPIKE S2 as executable documentation (issue #109, design doc 3.12).
 *
 * What `@a2a-js/sdk` 1.3 does with a SECOND `message/send` / `message/stream` posted to a task whose
 * first request is still WORKING, measured with the REAL `DefaultRequestHandler` (in-memory task
 * store) and a bare executor: no core runtime is involved. The findings drive how `CoreExecutor` and
 * `RunEventBusManager` answer such a message (design doc 3.12). If an SDK upgrade changes one fact,
 * a test here fails first.
 *
 * Summary of the facts pinned below:
 *
 *  1. The second request runs a SECOND `execute()` on the SAME `ExecutionEventBus` and attaches its own
 *     `ExecutionEventQueue` to it, so every event published by either execute() reaches BOTH streams.
 *  2. A streaming second request needs its first event to be a Task or a Message. Nothing published on the
 *     shared bus can satisfy it without damaging the first stream: a Task snapshot or a Message is a
 *     "Stream ordering violation" for the first (task-lifecycle) stream, a status update throws on the second.
 *  3. A blocking second request on the shared bus returns only when the whole task ends.
 *  4. An `execute()` that rejects makes the SDK publish a synthetic Task + FAILED on the shared bus: the
 *     first stream sees a terminal FAILED event for a task that is still running.
 *  5. The way out: `ExecutionEventBusManager.createOrGetByTaskId` is the seam. Returning a PRIVATE bus for the
 *     second request lets its `execute()` answer with a single Message (valid A2A: message/send and
 *     message/stream may answer with a Message). The first stream is untouched, the second stream gets exactly
 *     one event and ends, a blocking caller returns at once, and the task store is not written by the Message
 *     (only the SDK's own history append).
 */

import { describe, it, expect } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import {
  DefaultExecutionEventBus,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { publishTask } from "../../events/event-publisher.js";
import { toStatusUpdate } from "../../a2a/adapter.js";

const agentCard: any = { name: "s2", description: "s2", capabilities: { streaming: true }, defaultInputModes: [], defaultOutputModes: [], skills: [] };
const ctx = () => new ServerCallContext();
const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

function msg(taskId = "", contextId = "ctx-s2", text = "hello") {
  return {
    messageId: `m-${Math.random()}`,
    contextId,
    taskId,
    role: 1,
    parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  } as any;
}

const streamReq = (m: any) => ({ tenant: "", message: m, configuration: undefined, metadata: undefined }) as any;
const sendReq = (m: any) => ({ tenant: "", message: m, configuration: undefined, metadata: undefined }) as any;

const kinds = (events: any[]) =>
  events.map((e) => (e.payload.$case === "statusUpdate" ? `status:${TaskState[e.payload.value.status.state]}` : e.payload.$case));

async function collect(iter: AsyncIterable<any>) {
  const events: any[] = [];
  let error: unknown;
  try {
    for await (const e of iter) events.push(e);
  } catch (e) {
    error = e;
  }
  return { events, error };
}

type SecondMode = "nothing" | "status" | "snapshot" | "message" | "throw";

/**
 * The first `execute()` publishes Task + working and then waits on a gate, so the task is WORKING while the
 * test posts a second message. What the second `execute()` does is `mode`.
 */
function build(mode: SecondMode, options: { privateBusForSecond?: boolean; stockManager?: boolean } = {}) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const state = { firstDone: false, executes: 0, buses: [] as ExecutionEventBus[], ctxs: [] as RequestContext[] };
  const executor: AgentExecutor = {
    async execute(c, bus) {
      state.executes++;
      state.buses.push(bus);
      state.ctxs.push(c);
      const ids = { taskId: c.taskId, contextId: c.contextId };
      if (state.executes === 1) {
        publishTask(bus, c.taskId, c.contextId);
        bus.publish({ kind: "statusUpdate", data: toStatusUpdate({ ...ids, state: "working" }) });
        await gate;
        bus.publish({ kind: "statusUpdate", data: toStatusUpdate({ ...ids, state: "completed", text: "done" }) });
        bus.finished();
        state.firstDone = true;
        return;
      }
      if (mode === "status") bus.publish({ kind: "statusUpdate", data: toStatusUpdate({ ...ids, state: "working", text: "ack" }) });
      if (mode === "snapshot" && c.task) bus.publish({ kind: "task", data: c.task });
      if (mode === "message") {
        bus.publish({
          kind: "message",
          data: {
            messageId: "ack-1",
            contextId: c.contextId,
            taskId: c.taskId,
            role: 2,
            parts: [{ content: { $case: "text", value: "queued" }, metadata: undefined, filename: "", mediaType: "text/plain" }],
            metadata: { ack: true },
            extensions: [],
            referenceTaskIds: [],
          } as any,
        });
      }
      if (mode === "throw") throw new Error("second execute failed");
    },
    async cancelTask() {},
  };
  const taskStore = new InMemoryTaskStore();
  const privateBuses: ExecutionEventBus[] = [];
  /**
   * Behaves like core's `RunEventBusManager` while the task is live: it owns the bus lifetime (`settleByTaskId`
   * returns true), so a second `execute()` returning cannot finish or clean up the shared bus. With the SDK's
   * stock manager the second execute() returning calls `bus.finished()` and `cleanupByTaskId` on the SHARED
   * bus (see the test "the stock manager"). `privateBusForSecond` adds the seam core uses.
   */
  class GuardedManager extends DefaultExecutionEventBusManager {
    private seen = new Set<string>();
    override createOrGetByTaskId(taskId: string, context?: ServerCallContext): ExecutionEventBus {
      if (options.privateBusForSecond && this.seen.has(taskId)) {
        const bus = new DefaultExecutionEventBus();
        privateBuses.push(bus);
        return bus;
      }
      this.seen.add(taskId);
      return super.createOrGetByTaskId(taskId, context);
    }
    settleByTaskId(): boolean {
      return !state.firstDone;
    }
  }
  const busManager = options.stockManager ? new DefaultExecutionEventBusManager() : new GuardedManager();
  const handler = new DefaultRequestHandler(agentCard, taskStore, executor as any, busManager);
  return { handler, taskStore, state, release, privateBuses };
}

/** Start the first (streaming) request and wait until its task is working. Returns its task id and consumer. */
async function startFirst(h: ReturnType<typeof build>) {
  const first = collect(h.handler.sendMessageStream(streamReq(msg()), ctx()));
  await tick();
  const taskId = h.state.ctxs[0]!.taskId;
  return { first, taskId };
}

describe("S2 (a): a second request runs a second execute() on the SAME bus", () => {
  it("both executes share one bus object, and the stored task already has the second message in its history", async () => {
    const h = build("nothing");
    const { taskId } = await startFirst(h);
    const second = msg(taskId);
    void collect(h.handler.sendMessageStream(streamReq(second), ctx()));
    await tick();
    expect(h.state.executes).toBe(2);
    expect(h.state.buses[1]).toBe(h.state.buses[0]);
    // The SDK appended the message to the stored task BEFORE execute() ran (and handed that task to execute()).
    expect(h.state.ctxs[1]!.task?.status.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(h.state.ctxs[1]!.task?.history.map((m: any) => m.messageId)).toContain(second.messageId);
    h.release();
  });
});

describe("S2 (b): a streaming second request on the shared bus has no good first event", () => {
  it("a status update first: the SECOND stream throws 'statusUpdate before initial Task/Message'; the first stream is fine", async () => {
    const h = build("status");
    const { first, taskId } = await startFirst(h);
    const second = collect(h.handler.sendMessageStream(streamReq(msg(taskId)), ctx()));
    await tick();
    h.release();
    const r1 = await first;
    const r2 = await second;
    expect(String((r2.error as Error)?.message)).toMatch(/statusUpdate before initial 'Message'\/'Task' event/);
    expect(r1.error).toBeUndefined();
    // The first stream also saw the second execute()'s status: events of every execute() reach every stream.
    expect(kinds(r1.events)).toEqual(["task", "status:TASK_STATE_WORKING", "status:TASK_STATE_WORKING", "status:TASK_STATE_COMPLETED"]);
  });

  it("no event at all: the second stream just waits for the first execute()'s events, then fails on the first of them", async () => {
    const h = build("nothing");
    const { first, taskId } = await startFirst(h);
    const second = collect(h.handler.sendMessageStream(streamReq(msg(taskId)), ctx()));
    await tick();
    h.release();
    const r2 = await second;
    await first;
    expect(String((r2.error as Error)?.message)).toMatch(/before initial 'Message'\/'Task' event/);
  });

  it("a Task snapshot first: the second stream starts, but the FIRST stream breaks ('Stream ordering violation')", async () => {
    const h = build("snapshot");
    const { first, taskId } = await startFirst(h);
    const second = collect(h.handler.sendMessageStream(streamReq(msg(taskId)), ctx()));
    await tick();
    h.release();
    const r1 = await first;
    await second;
    expect(String((r1.error as Error)?.message)).toMatch(/Stream ordering violation: received task in task lifecycle stream/);
  });

  it("a Message first: the second stream is a valid message-only response, but the FIRST stream breaks the same way", async () => {
    const h = build("message");
    const { first, taskId } = await startFirst(h);
    const second = collect(h.handler.sendMessageStream(streamReq(msg(taskId)), ctx()));
    await tick();
    h.release();
    const r1 = await first;
    const r2 = await second;
    expect(String((r1.error as Error)?.message)).toMatch(/Stream ordering violation: received message in task lifecycle stream/);
    expect(kinds(r2.events)).toEqual(["message"]);
    expect(r2.error).toBeUndefined();
  });
});

describe("S2 (c): a blocking second request on the shared bus", () => {
  it("returns only when the whole task ends (the status it published did not end the SDK queue)", async () => {
    const h = build("status");
    const { first, taskId } = await startFirst(h);
    let settled = false;
    const second = h.handler.sendMessage(sendReq(msg(taskId)), ctx()).then((r) => {
      settled = true;
      return r;
    });
    await tick(20);
    expect(settled).toBe(false); // still waiting: a blocking caller of a queued message waits for the end of the task
    h.release();
    const result: any = await second;
    await first;
    expect(result.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});

describe("S2 (d): an execute() that rejects on the shared bus", () => {
  it("the SDK publishes a synthetic Task + FAILED on the shared bus: the FIRST stream breaks (a Task inside its lifecycle) for a task that is still running", async () => {
    const h = build("throw");
    const { first, taskId } = await startFirst(h);
    const second = collect(h.handler.sendMessageStream(streamReq(msg(taskId)), ctx()));
    await tick();
    const r1 = await first; // ended by the second execute()'s synthetic events, before the gate was released
    expect(String((r1.error as Error)?.message)).toMatch(/Stream ordering violation: received task in task lifecycle stream/);
    h.release();
    await second;
  });
});

describe("S2 (d2): the SDK's stock bus manager", () => {
  it("the second execute() returning finishes and removes the SHARED bus: the first stream ends early and never sees the terminal event", async () => {
    const h = build("status", { stockManager: true });
    const { first, taskId } = await startFirst(h);
    void collect(h.handler.sendMessageStream(streamReq(msg(taskId)), ctx())).catch(() => {});
    await tick();
    h.release();
    const r1 = await first;
    expect(kinds(r1.events)).not.toContain("status:TASK_STATE_COMPLETED");
  });
});

describe("S2 (e): the way out, a private bus for the second request", () => {
  it("a streaming second request gets exactly ONE event, a Message, and ends; the first stream is untouched", async () => {
    const h = build("message", { privateBusForSecond: true });
    const { first, taskId } = await startFirst(h);
    const second = await collect(h.handler.sendMessageStream(streamReq(msg(taskId)), ctx()));
    expect(second.error).toBeUndefined();
    expect(kinds(second.events)).toEqual(["message"]);
    expect(second.events[0].payload.value.metadata).toEqual({ ack: true });
    expect(h.privateBuses).toHaveLength(1);
    expect(h.state.buses[1]).not.toBe(h.state.buses[0]);

    h.release();
    const r1 = await first;
    expect(r1.error).toBeUndefined();
    expect(kinds(r1.events)).toEqual(["task", "status:TASK_STATE_WORKING", "status:TASK_STATE_COMPLETED"]);
  });

  it("a BLOCKING second request returns the Message at once (not the task, and not at the end of the task)", async () => {
    const h = build("message", { privateBusForSecond: true });
    const { first, taskId } = await startFirst(h);
    const result: any = await h.handler.sendMessage(sendReq(msg(taskId)), ctx());
    expect(result.messageId).toBe("ack-1"); // a Message, not a Task: message/send may answer with either
    expect(result.metadata).toEqual({ ack: true });
    h.release();
    await first;
  });

  it("the Message is not written to the task store: only the SDK's own history append of the second user message remains", async () => {
    const h = build("message", { privateBusForSecond: true });
    const { first, taskId } = await startFirst(h);
    const second = msg(taskId);
    await collect(h.handler.sendMessageStream(streamReq(second), ctx()));
    const during = await h.taskStore.load(taskId, ctx());
    expect(during?.status.state).toBe(TaskState.TASK_STATE_WORKING); // untouched
    const ids = (during?.history ?? []).map((m: any) => m.messageId);
    expect(ids.filter((i: string) => i === second.messageId)).toHaveLength(1);
    expect(ids).not.toContain("ack-1");
    h.release();
    await first;
    expect((await h.taskStore.load(taskId, ctx()))?.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("the SDK does not clean up or finish the first bus when the second execute() returns on its private one", async () => {
    const h = build("message", { privateBusForSecond: true });
    const { first, taskId } = await startFirst(h);
    await h.handler.sendMessage(sendReq(msg(taskId)), ctx());
    await tick();
    h.release();
    const r1 = await first;
    expect(kinds(r1.events)).toEqual(["task", "status:TASK_STATE_WORKING", "status:TASK_STATE_COMPLETED"]);
  });
});
