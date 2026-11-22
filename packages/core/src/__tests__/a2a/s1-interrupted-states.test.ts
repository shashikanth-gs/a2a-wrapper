/**
 * SPIKE S1 as executable documentation (issue #108, design doc 3.10.1).
 *
 * What `@a2a-js/sdk` 1.3 does at `input-required` and `auth-required`, measured with the REAL
 * `DefaultRequestHandler` (in-memory task store) and a bare `AgentExecutor` that behaves like a
 * run that outlives `execute()`. No core runtime is involved: these tests pin the SDK facts the
 * interactions design depends on. If an SDK upgrade changes one, a test here fails first.
 */

import { describe, it, expect } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import {
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

const agentCard: any = { name: "s1", description: "s1", capabilities: { streaming: true }, defaultInputModes: [], defaultOutputModes: [], skills: [] };
const ctx = () => new ServerCallContext();
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

function msg(taskId = "", contextId = "ctx-s1", text = "hello") {
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

/**
 * Parks at `parkState` on the first `execute()` and returns (the run lives on). A later
 * `execute()` for the task is the reply: with `snapshotOnReply` it opens with a Task event,
 * then finishes the run on the shared bus.
 */
class ParkingExecutor implements AgentExecutor {
  executes = 0;
  buses: ExecutionEventBus[] = [];
  contexts: RequestContext[] = [];
  constructor(
    private readonly opts: { parkState: "input-required" | "auth-required"; snapshotOnReply: boolean; returnOnPark?: boolean },
  ) {}
  async execute(c: RequestContext, bus: ExecutionEventBus): Promise<void> {
    this.executes++;
    this.buses.push(bus);
    this.contexts.push(c);
    const ids = { taskId: c.taskId, contextId: c.contextId };
    if (this.executes === 1) {
      publishTask(bus, c.taskId, c.contextId);
      bus.publish({ kind: "statusUpdate", data: toStatusUpdate({ ...ids, state: "working" }) });
      bus.publish({ kind: "statusUpdate", data: toStatusUpdate({ ...ids, state: this.opts.parkState, text: "approve?" }) });
      return;
    }
    if (this.opts.snapshotOnReply && c.task) bus.publish({ kind: "task", data: c.task });
    bus.publish({ kind: "statusUpdate", data: toStatusUpdate({ ...ids, state: "working" }) });
    bus.publish({ kind: "statusUpdate", data: toStatusUpdate({ ...ids, state: "completed", text: "done" }) });
    bus.finished();
  }
  async cancelTask(): Promise<void> {}
}

function build(opts: ConstructorParameters<typeof ParkingExecutor>[0]) {
  const executor = new ParkingExecutor(opts);
  const taskStore = new InMemoryTaskStore();
  const busManager = new DefaultExecutionEventBusManager();
  const handler = new DefaultRequestHandler(agentCard, taskStore, executor as any, busManager);
  return { executor, taskStore, busManager, handler };
}

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

const streamReq = (m: any) => ({ tenant: "", message: m, configuration: undefined, metadata: undefined }) as any;

describe("S1 (a): blocking message/send that parks at input-required", () => {
  it("returns the Task in input-required; the bus stays alive; the run is not over", async () => {
    const h = build({ parkState: "input-required", snapshotOnReply: true });
    const result: any = await h.handler.sendMessage({ tenant: "", message: msg(), configuration: undefined, metadata: undefined } as any, ctx());
    expect(result.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(h.executor.executes).toBe(1);
    // keepBusAliveStates defaults to the interrupted states: the bus is still there for the reply.
    expect(h.busManager.getByTaskId(result.id, ctx())).toBeDefined();
  });
});

describe("S1 (b): message/stream that parks at input-required", () => {
  it("the stream delivers task, working, input-required and then ENDS (the SDK queue stops at input-required)", async () => {
    const h = build({ parkState: "input-required", snapshotOnReply: true });
    const { events, error } = await collect(h.handler.sendMessageStream(streamReq(msg()), ctx()));
    expect(error).toBeUndefined();
    expect(kinds(events)).toEqual(["task", "status:TASK_STATE_WORKING", "status:TASK_STATE_INPUT_REQUIRED"]);
    expect(h.busManager.getByTaskId(h.executor.contexts[0]!.taskId, ctx())).toBeDefined();
  });
});

describe("S1 (c): the reply is a NEW message on the same taskId", () => {
  it("the SDK starts a second execute() (so core must route it, never run the provider again); original stream already closed", async () => {
    const h = build({ parkState: "input-required", snapshotOnReply: true });
    const first = await collect(h.handler.sendMessageStream(streamReq(msg()), ctx()));
    const taskId = h.executor.contexts[0]!.taskId;
    expect(kinds(first.events).at(-1)).toBe("status:TASK_STATE_INPUT_REQUIRED");

    const reply = await collect(h.handler.sendMessageStream(streamReq(msg(taskId)), ctx()));
    expect(h.executor.executes).toBe(2); // a second execute() on the same task and the same bus
    expect(h.executor.buses[1]).toBe(h.executor.buses[0]);
    // The SDK handed the reply's execute() the stored task, with the reply already appended to its history.
    expect(h.executor.contexts[1]!.task?.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(h.executor.contexts[1]!.task?.history.length).toBeGreaterThanOrEqual(2);
    expect(reply.error).toBeUndefined();
    expect(kinds(reply.events)).toEqual(["task", "status:TASK_STATE_WORKING", "status:TASK_STATE_COMPLETED"]);
    expect((await h.taskStore.load(taskId, ctx()))?.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("a streaming reply whose execute() publishes NO Task snapshot first fails with 'statusUpdate before initial Task/Message' (what #117 found)", async () => {
    const h = build({ parkState: "input-required", snapshotOnReply: false });
    await collect(h.handler.sendMessageStream(streamReq(msg()), ctx()));
    const taskId = h.executor.contexts[0]!.taskId;
    const reply = await collect(h.handler.sendMessageStream(streamReq(msg(taskId)), ctx()));
    expect(String((reply.error as Error)?.message)).toMatch(/before initial 'Message'\/'Task' event/);
  });

  it("a BLOCKING reply without a Task snapshot is fine: only the streaming path checks the opening event", async () => {
    const h = build({ parkState: "input-required", snapshotOnReply: false });
    const first: any = await h.handler.sendMessage({ tenant: "", message: msg(), configuration: undefined, metadata: undefined } as any, ctx());
    const reply: any = await h.handler.sendMessage(
      { tenant: "", message: msg(first.id), configuration: undefined, metadata: undefined } as any,
      ctx(),
    );
    expect(h.executor.executes).toBe(2);
    expect(reply.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("a Task snapshot published on the shared bus while the ORIGINAL stream is still attached breaks that stream (so core may publish it only when nothing is attached)", async () => {
    // Reproduces the #109 hazard: a message to a WORKING task (stream #1 open). A snapshot for stream #2
    // reaches stream #1 as well, and the SDK rejects a Task event inside a task-lifecycle stream.
    const taskStore = new InMemoryTaskStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const executor: AgentExecutor = {
      async execute(c, bus) {
        n++;
        const ids = { taskId: c.taskId, contextId: c.contextId };
        if (n === 1) {
          publishTask(bus, c.taskId, c.contextId);
          bus.publish({ kind: "statusUpdate", data: toStatusUpdate({ ...ids, state: "working" }) });
          await gate;
          bus.publish({ kind: "statusUpdate", data: toStatusUpdate({ ...ids, state: "completed" }) });
          bus.finished();
          return;
        }
        if (c.task) bus.publish({ kind: "task", data: c.task });
      },
      async cancelTask() {},
    };
    const handler = new DefaultRequestHandler(agentCard, taskStore, executor as any, new DefaultExecutionEventBusManager());
    const s1 = collect(handler.sendMessageStream(streamReq(msg()), ctx()));
    await tick();
    const taskId = ((await taskStore.list({ pageSize: 10 } as any, ctx())) as any).tasks[0].id as string;
    const s2 = collect(handler.sendMessageStream(streamReq(msg(taskId)), ctx()));
    await tick();
    release();
    const r1 = await s1;
    await s2;
    expect(String((r1.error as Error)?.message)).toMatch(/Stream ordering violation/);
  });
});

describe("S1 (d): auth-required differs from input-required in SDK 1.3", () => {
  it("a streaming client's stream stays OPEN at auth-required (the queue does not stop there); it ends only when the executor finishes the bus", async () => {
    const h = build({ parkState: "auth-required", snapshotOnReply: true });
    let ended = false;
    const consumer = collect(h.handler.sendMessageStream(streamReq(msg()), ctx())).then((r) => {
      ended = true;
      return r;
    });
    await tick();
    await tick();
    expect(ended).toBe(false); // still waiting for the executor to continue on the same bus
    const bus = h.executor.buses[0]!;
    bus.finished(); // what a parked-run runtime does to close the attachment
    const r = await consumer;
    expect(kinds(r.events)).toEqual(["task", "status:TASK_STATE_WORKING", "status:TASK_STATE_AUTH_REQUIRED"]);
  });

  it("a BLOCKING caller gets the auth-required snapshot immediately while the SDK keeps draining in the background", async () => {
    const h = build({ parkState: "auth-required", snapshotOnReply: true });
    const result: any = await h.handler.sendMessage({ tenant: "", message: msg(), configuration: undefined, metadata: undefined } as any, ctx());
    expect(result.status.state).toBe(TaskState.TASK_STATE_AUTH_REQUIRED);
    expect(h.executor.executes).toBe(1);
  });

  it("leaving the original stream attached at auth-required breaks it when the reply's Task snapshot arrives; the reply stream is fine", async () => {
    const h = build({ parkState: "auth-required", snapshotOnReply: true });
    const first = collect(h.handler.sendMessageStream(streamReq(msg()), ctx()));
    await tick();
    const taskId = h.executor.contexts[0]!.taskId;
    const second = await collect(h.handler.sendMessageStream(streamReq(msg(taskId)), ctx()));
    const firstResult = await first;
    expect(kinds(second.events)).toEqual(["task", "status:TASK_STATE_WORKING", "status:TASK_STATE_COMPLETED"]);
    // The first stream never sees the continuation: the snapshot event is a protocol violation inside its lifecycle.
    expect(String((firstResult.error as Error)?.message)).toMatch(/Stream ordering violation/);
    // Design consequence (3.10.1): core closes the attachment (bus.finished()) at auth-required exactly as the SDK
    // does at input-required, so the reply is always the one and only attachment.
  });
});
