/**
 * End to end through the real SDK `DefaultRequestHandler` (1.3) with the in-memory
 * task store: CoreExecutor, RunEventBusManager and OrphanGuardTaskStore over a fake
 * provider. Proves the sequencing against the SDK's own behaviour, including the
 * cancel-with-no-bus path that never calls the executor.
 */

import { describe, it, expect, vi } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import {
  CoreExecutor,
  InMemoryRunStore,
  OrphanGuardTaskStore,
  RunEventBusManager,
  RunRegistry,
  newRecordHeader,
  type CoreInteractionRequest,
  type CoreInteractionResult,
  type InteractionRuntime,
  type RunHandle,
} from "../../index.js";
import { makeProvider, tick } from "./harness.js";

const agentCard: any = { name: "t", description: "t", capabilities: { streaming: true }, defaultInputModes: [], defaultOutputModes: [], skills: [] };
const ctx = () => new ServerCallContext();

function message(taskId = "", contextId = "ctx-e2e") {
  return {
    messageId: `m-${Math.random()}`,
    contextId,
    taskId,
    role: 1,
    parts: [{ content: { $case: "text", value: "hello" }, metadata: undefined, filename: "", mediaType: "text/plain" }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  } as any;
}

function build(providerOpts: Parameters<typeof makeProvider>[0] = {}, interactions?: InteractionRuntime) {
  const provider = makeProvider(providerOpts);
  const runStore = new InMemoryRunStore();
  const registry = new RunRegistry({ provider, store: runStore, ...(interactions ? { interactions } : {}) });
  const taskStore = new InMemoryTaskStore();
  const busManager = new RunEventBusManager(registry);
  const handler = new DefaultRequestHandler(
    agentCard,
    new OrphanGuardTaskStore(taskStore, registry),
    new CoreExecutor(registry) as any,
    busManager,
  );
  return { provider, runStore, registry, taskStore, busManager, handler };
}

function stream(h: ReturnType<typeof build>, msg = message()) {
  const events: any[] = [];
  const consumer = (async () => {
    for await (const e of h.handler.sendMessageStream({ tenant: "", message: msg, configuration: undefined, metadata: undefined } as any, ctx())) events.push(e);
  })();
  return { events, consumer };
}

const stateOf = async (h: ReturnType<typeof build>, id: string) => (await h.taskStore.load(id, ctx()))?.status.state;

describe("end to end through DefaultRequestHandler", () => {
  it("tasks/cancel on a running task: one canceled status, task canceled in the store, abort in the background, late complete dropped", async () => {
    const h = build();
    const { consumer } = stream(h);
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const taskId = call.req.taskId;

    const task = await h.handler.cancelTask({ tenant: "", id: taskId, metadata: undefined } as any, ctx());
    expect(task.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    await consumer;

    call.view.complete({ text: "too late" });
    call.reject(new Error("aborted"));
    await h.registry.drain();
    expect(await stateOf(h, taskId)).toBe(TaskState.TASK_STATE_CANCELED);
    expect(h.provider.abort).toHaveBeenCalledTimes(1);
    expect(h.provider.abortOrphan).not.toHaveBeenCalled(); // not an orphan
    expect((await h.runStore.getRun(taskId))?.state).toBe("canceled");
    expect(h.registry.isLive(taskId)).toBe(false);
    expect(h.busManager.getByTaskId(taskId, ctx())).toBeUndefined();
  });

  it("tasks/cancel returns while the provider's abort hangs", async () => {
    const h = build({ abort: () => new Promise(() => {}) });
    stream(h);
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const task = await h.handler.cancelTask({ tenant: "", id: h.provider.runs[0].req.taskId, metadata: undefined } as any, ctx());
    expect(task.status.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it("a normal completion ends the task, closes and releases the bus", async () => {
    const h = build();
    const { consumer } = stream(h);
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    call.view.event({ type: "text", text: "hel" });
    call.view.event({ type: "text", text: "lo" });
    call.view.complete({});
    await consumer;
    expect(await stateOf(h, call.req.taskId)).toBe(TaskState.TASK_STATE_COMPLETED);
    const t = await h.taskStore.load(call.req.taskId, ctx());
    expect(t?.artifacts.flatMap((a) => a.parts).map((p: any) => p.content.value).join("")).toBe("hello");
    expect(h.busManager.getByTaskId(call.req.taskId, ctx())).toBeUndefined();
    // cancel after completion: the SDK reports not cancelable
    await expect(h.handler.cancelTask({ tenant: "", id: call.req.taskId, metadata: undefined } as any, ctx())).rejects.toThrow(/not cancelable/i);
  });

  it("cancel at input-required after execute() returned works (the bus stays alive because core has a live run)", async () => {
    const interactions: InteractionRuntime = {
      ask(handle: RunHandle, _req: CoreInteractionRequest) {
        return new Promise<CoreInteractionResult>((resolve) => {
          handle.registerPending({ cancel: () => resolve({ outcome: "canceled" }) });
          handle.publisher?.status({ state: "input-required", text: "approve?" });
          handle.signalParked();
        });
      },
    };
    const h = build({}, interactions);
    const { consumer } = stream(h);
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const answer = call.view.ask({ kind: "confirm", title: "approve?" } as CoreInteractionRequest);
    await consumer; // the stream ended at input-required
    expect(await stateOf(h, call.req.taskId)).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(h.registry.isLive(call.req.taskId)).toBe(true);

    const task = await h.handler.cancelTask({ tenant: "", id: call.req.taskId, metadata: undefined } as any, ctx());
    expect(task.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(await answer).toEqual({ outcome: "canceled" });
    await h.registry.drain();
    expect(h.provider.abort).toHaveBeenCalledTimes(1);
  });

  it("a second message to a working task never starts a second provider call and the bus stays alive for the cancel", async () => {
    const h = build();
    stream(h);
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const taskId = call.req.taskId;

    // Note: the SDK serves this second stream from the same bus and rejects it ("statusUpdate before
    // initial Task"): a second message/stream on a working task is an SDK limitation (a2a-js #632).
    // What matters here is that core never starts a second provider call.
    const second = stream(h, message(taskId, "ctx-e2e"));
    second.consumer.catch(() => {});
    await tick();
    await tick();
    expect(h.provider.runs).toHaveLength(1);
    expect(h.busManager.getByTaskId(taskId, ctx())).toBeDefined(); // execute #2 returned, the run is live, bus kept

    const task = await h.handler.cancelTask({ tenant: "", id: taskId, metadata: undefined } as any, ctx());
    expect(task.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    await h.registry.drain();
    expect(h.provider.abort).toHaveBeenCalledTimes(1);
    void second;
  });

  it("no-bus cancel: after a restart the SDK writes CANCELED itself (executor never called) and core reaches abortOrphan", async () => {
    // "Before the restart": a task that was working, recorded by core, with a bound session.
    const provider = makeProvider({ abortOrphan: async () => ({ stopped: "confirmed", session: "discard" }) });
    const runStore = new InMemoryRunStore();
    const taskStore = new InMemoryTaskStore();
    await taskStore.save(
      { id: "t-orphan", contextId: "ctx-o", status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined }, artifacts: [], history: [], metadata: {} } as any,
      ctx(),
    );
    const owner = { id: "anonymous", kind: "anonymous" };
    await runStore.putRun({
      ...newRecordHeader(owner, "t"),
      runId: "run-o",
      taskId: "t-orphan",
      contextId: "ctx-o",
      turnId: "turn-o",
      state: "working",
      startedAt: "t",
    });
    await runStore.putBinding({ ...newRecordHeader(owner, "t"), contextId: "ctx-o", session: { ref: "sess-o", issuer: "fake@1" } });

    // "After the restart": a fresh registry and handler over the same stores; no live handle, no bus.
    const registry = new RunRegistry({ provider, store: runStore });
    const handler = new DefaultRequestHandler(
      agentCard,
      new OrphanGuardTaskStore(taskStore, registry),
      new CoreExecutor(registry) as any,
      new RunEventBusManager(registry),
    );
    const executeSpy = vi.spyOn(CoreExecutor.prototype, "cancelTask");

    const task = await handler.cancelTask({ tenant: "", id: "t-orphan", metadata: undefined } as any, ctx());
    await registry.drain();

    expect(task.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(executeSpy).not.toHaveBeenCalled(); // SDK 1.3: no bus, the executor is never called
    expect(provider.abortOrphan).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t-orphan", runId: "run-o", reason: "cancel", session: { ref: "sess-o" } }));
    expect(await runStore.getBinding("ctx-o")).toBeUndefined();
    expect(provider.release).toHaveBeenCalledWith({ ref: "sess-o" });
    expect((await runStore.getRun("t-orphan"))?.state).toBe("canceled");
    executeSpy.mockRestore();
  });
});
