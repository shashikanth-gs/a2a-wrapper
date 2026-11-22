/**
 * Steering end to end through the REAL SDK `DefaultRequestHandler` (1.3, in-memory task store): CoreExecutor,
 * RunEventBusManager, OrphanGuardTaskStore and the run runtime over a fake provider. What a streaming and a blocking
 * caller receive for a message sent to a task that is already running, as designed from spike S2
 * (s2-message-to-working-task.test.ts, design doc 3.12): ONE Message carrying the DeliveryResult, never an error for a
 * message that will be delivered, the running task's own stream untouched.
 */

import { describe, it, expect, vi } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import {
  CoreExecutor,
  DELIVERY_META_KEY,
  DELIVERY_RESULT_META_KEY,
  InMemoryRunStore,
  OrphanGuardTaskStore,
  RunEventBusManager,
  RunRegistry,
  STEERING_EXTENSION_ALIAS,
  createStorePublisherFactory,
  deliveryResultFromMetadata,
  type CoreInteractionRequest,
  type DeliveryResult,
  type InteractionPolicy,
} from "../../index.js";
import { makeProvider } from "../runtime/harness.js";

const agentCard: any = { name: "t", description: "t", capabilities: { streaming: true }, defaultInputModes: [], defaultOutputModes: [], skills: [] };
const ctx = () => new ServerCallContext();
const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

let seq = 0;
function message(taskId = "", text = "hello", metadata?: Record<string, unknown>, messageId = `m-${++seq}`) {
  return {
    messageId,
    contextId: "ctx-steer",
    taskId,
    role: 1,
    parts: text === "" ? [] : [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
    metadata,
    extensions: [],
    referenceTaskIds: [],
  } as any;
}
const withDelivery = (delivery: string) => ({ [DELIVERY_META_KEY]: delivery });

function dataMessage(taskId: string, data: Record<string, unknown>) {
  const m = message(taskId, "");
  m.parts = [{ content: { $case: "data", value: data }, metadata: undefined, filename: "", mediaType: "application/json" }];
  return m;
}

function build(
  providerOpts: Parameters<typeof makeProvider>[0] = {},
  policy: Partial<InteractionPolicy> = { mode: "auto" },
  registryOpts: Partial<ConstructorParameters<typeof RunRegistry>[0]> = {},
) {
  const provider = makeProvider(providerOpts);
  const runStore = new InMemoryRunStore();
  const registry = new RunRegistry({ provider, store: runStore, interactionPolicy: policy, logger: { warn: vi.fn() }, ...registryOpts });
  const taskStore = new InMemoryTaskStore();
  registry.setDetachedPublisher(createStorePublisherFactory(taskStore));
  const handler = new DefaultRequestHandler(
    agentCard,
    new OrphanGuardTaskStore(taskStore, registry),
    new CoreExecutor(registry) as any,
    new RunEventBusManager(registry),
  );
  return { provider, runStore, registry, taskStore, handler };
}
type H = ReturnType<typeof build>;

const kinds = (events: any[]) =>
  events.map((e) => (e.payload.$case === "statusUpdate" ? `status:${TaskState[e.payload.value.status.state]}` : e.payload.$case));

async function collect(iter: AsyncIterable<any>) {
  const events: any[] = [];
  let error: unknown;
  try {
    for await (const e of iter) events.push(e);
  } catch (err) {
    error = err;
  }
  return { events, error };
}

const stream = (h: H, m: any) => collect(h.handler.sendMessageStream({ tenant: "", message: m, configuration: undefined, metadata: undefined } as any, ctx()));
const send = (h: H, m: any) => h.handler.sendMessage({ tenant: "", message: m, configuration: undefined, metadata: undefined } as any, ctx());
const stored = (h: H, id: string) => h.taskStore.load(id, ctx());

/** Start the first request as a stream and wait until the provider is running its first turn. */
async function startStream(h: H, text = "first") {
  const first = stream(h, message("", text));
  await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
  return { first, call: h.provider.runs[0], taskId: h.provider.runs[0].req.taskId };
}

const textOf = (m: any) => m?.parts?.map((p: any) => p.content?.value).join("");
/** The single Message a second request is answered with, and the DeliveryResult in its metadata. */
function answerOf(r: { events: any[]; error: unknown }): { message: any; result: DeliveryResult } {
  expect(r.error).toBeUndefined();
  expect(kinds(r.events)).toEqual(["message"]);
  const message = r.events[0].payload.value;
  const result = deliveryResultFromMetadata(message.metadata);
  expect(result).toBeDefined();
  return { message, result: result! };
}

describe("a message to a WORKING task: the caller gets one Message with the DeliveryResult, never an error", () => {
  it("a streaming queue: one Message (queued, core, position 1); the running stream is untouched and carries the queued turn on", async () => {
    const h = build();
    const { first, call, taskId } = await startStream(h);
    const second = message(taskId, "second");
    const answer = answerOf(await stream(h, second));
    expect(answer.result).toEqual({ state: "queued", taskId, messageId: second.messageId, holder: "core", position: 1 });
    expect(answer.message.metadata[DELIVERY_RESULT_META_KEY]).toBeDefined();
    expect(textOf(answer.message)).toMatch(/queued/i);
    expect(answer.message.role).toBe(2); // agent
    expect(h.provider.runs).toHaveLength(1);

    call.view.event({ type: "text", text: "turn one " });
    call.view.complete({});
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(2));
    expect(h.provider.runs[1].req.runId).toBe(call.req.runId); // the same run
    expect(textOf({ parts: h.provider.runs[1].req.input.map((p: any) => ({ content: { value: p.text } })) })).toBe("second");
    h.provider.runs[1].view.event({ type: "text", text: "turn two" });
    h.provider.runs[1].view.complete({});

    const r1 = await first;
    expect(r1.error).toBeUndefined(); // the first stream never broke
    expect(kinds(r1.events)[0]).toBe("task");
    expect(kinds(r1.events).at(-1)).toBe("status:TASK_STATE_COMPLETED");
    expect(kinds(r1.events)).not.toContain("message");
    const task = await stored(h, taskId);
    expect(task?.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(task?.artifacts.flatMap((a) => a.parts).map((p: any) => p.content.value).join("")).toBe("turn one turn two");
  });

  it("a BLOCKING queue returns the Message at once (not at the end of the task), while the first request is still running", async () => {
    const h = build();
    const firstBlocking = send(h, message("", "first"));
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const taskId = call.req.taskId;

    const reply: any = await send(h, message(taskId, "second"));
    expect(reply.messageId).toEqual(expect.any(String)); // a Message, not a Task
    expect(reply.status).toBeUndefined();
    expect(deliveryResultFromMetadata(reply.metadata)).toMatchObject({ state: "queued", holder: "core", position: 1 });

    call.view.complete({ text: "one" });
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(2));
    h.provider.runs[1].view.complete({ text: "two" });
    const finalTask: any = await firstBlocking;
    expect(finalTask.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    // the first turn's answer was published as output, the second is the final one
    expect(finalTask.history.some((m: any) => m.role === 2 && textOf(m) === "one")).toBe(true);
    expect(textOf(finalTask.status.message)).toBe("two");
  });

  it("steer with a handler that inserts: inserted, nothing queued, no second turn", async () => {
    const h = build({ steer: async () => ({ state: "inserted" }) });
    const { first, call, taskId } = await startStream(h);
    const { result, message: ack } = answerOf(await stream(h, message(taskId, "also x", withDelivery("steer"))));
    expect(result).toMatchObject({ state: "inserted", taskId });
    expect(textOf(ack)).toMatch(/added to the running turn/);
    call.view.complete({ text: "done" });
    const r1 = await first;
    expect(r1.error).toBeUndefined();
    expect(h.provider.runs).toHaveLength(1);
    expect(await h.runStore.listQueued(taskId)).toEqual([]);
  });

  it("steer without a handler: queued by core and the answer says why; it runs as the next turn", async () => {
    const h = build();
    const { first, call, taskId } = await startStream(h);
    const { result } = answerOf(await stream(h, message(taskId, "steer me", withDelivery("steer"))));
    expect(result).toMatchObject({ state: "queued", holder: "core", reason: expect.stringMatching(/^steer-unsupported/) });
    call.view.complete({ text: "one" });
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(2));
    h.provider.runs[1].view.complete({ text: "two" });
    expect((await first).error).toBeUndefined();
  });

  it("steer rejected by the provider: the answer is rejected with the provider's reason, and the message is not run", async () => {
    const h = build({ steer: async () => ({ state: "rejected", reason: "not-steerable", detail: "compacting" }) });
    const { first, call, taskId } = await startStream(h);
    const { result, message: ack } = answerOf(await stream(h, message(taskId, "x", withDelivery("steer"))));
    expect(result).toMatchObject({ state: "rejected", reason: "not-steerable", detail: "compacting" });
    expect(textOf(ack)).toMatch(/not delivered: not-steerable/);
    call.view.complete({ text: "done" });
    await first;
    expect(h.provider.runs).toHaveLength(1);
  });

  it("steer answered queued{handle} (the provider's own queue): the task stays open until the provider runs or drops it", async () => {
    const h = build({ steer: async () => ({ state: "queued", handle: "h1" }) });
    const { first, call, taskId } = await startStream(h);
    const { result } = answerOf(await stream(h, message(taskId, "later", withDelivery("steer"))));
    expect(result).toMatchObject({ state: "queued", holder: "provider" });
    call.view.complete({ text: "one" });
    await tick(20);
    expect((await stored(h, taskId))?.status.state).toBe(TaskState.TASK_STATE_WORKING); // not terminal
    const held = call.view.beginHeldTurn("h1");
    held.complete({ text: "held done" });
    const r1 = await first;
    expect(r1.error).toBeUndefined();
    expect(kinds(r1.events).at(-1)).toBe("status:TASK_STATE_COMPLETED");
  });

  it("interrupt: answered interrupted, the turn is aborted (reason interrupt), the message is the next turn, the task is never canceled", async () => {
    const h = build();
    const { first, call, taskId } = await startStream(h);
    const { result, message: ack } = answerOf(await stream(h, message(taskId, "new direction", withDelivery("interrupt"))));
    expect(result).toEqual({ state: "interrupted", taskId, messageId: expect.any(String) });
    expect(textOf(ack)).toMatch(/interrupted/);
    expect(call.view.signal.reason).toBe("interrupt");
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(2));
    expect(h.provider.abort).toHaveBeenCalledWith(expect.anything(), "interrupt");
    h.provider.runs[1].view.complete({ text: "after interrupt" });
    const r1 = await first;
    expect(r1.error).toBeUndefined();
    expect(kinds(r1.events)).not.toContain("status:TASK_STATE_CANCELED");
    expect(kinds(r1.events).at(-1)).toBe("status:TASK_STATE_COMPLETED");
  });

  it("the delivery is read from the wire: the versioned key, the legacy key and the steering alias; the core key wins; an unknown word is rejected", async () => {
    const h = build();
    const { first, call, taskId } = await startStream(h);
    const via = async (metadata: Record<string, unknown>) => answerOf(await stream(h, message(taskId, "x", metadata))).result;
    expect(await via({ "urn:a2a-wrapper:delivery": "interrupt" })).toMatchObject({ state: "interrupted" });
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(2));
    const call2 = h.provider.runs[1];
    expect(await via({ [STEERING_EXTENSION_ALIAS]: { action: "steer" } })).toMatchObject({ state: "queued", reason: expect.stringMatching(/^steer-unsupported/) });
    const queued = await via({ [STEERING_EXTENSION_ALIAS]: "interrupt", [DELIVERY_META_KEY]: "queue" });
    expect(queued).toMatchObject({ state: "queued" });
    expect((queued as { reason?: string }).reason).toBeUndefined(); // the core key won: a plain queue, not an interrupt
    expect(await via(withDelivery("replace"))).toMatchObject({ state: "rejected", reason: "unsupported-delivery" });
    call.view.complete({ text: "stopped, ignored" });
    call2.view.complete({ text: "two" });
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(3));
    h.provider.runs[2].view.complete({ text: "three" });
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(4));
    h.provider.runs[3].view.complete({ text: "four" });
    expect((await first).error).toBeUndefined();
  });

  it("the same message id twice: the same answer, one turn", async () => {
    const h = build();
    const { first, call, taskId } = await startStream(h);
    const a = answerOf(await stream(h, message(taskId, "once", undefined, "dup-id"))).result;
    const b = answerOf(await stream(h, message(taskId, "once", undefined, "dup-id"))).result;
    expect(b).toEqual(a);
    expect(await h.runStore.listQueued(taskId)).toHaveLength(1);
    call.view.complete({ text: "one" });
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(2));
    h.provider.runs[1].view.complete({ text: "two" });
    await first;
    expect(h.provider.runs).toHaveLength(2);
  });

  it("a denied caller is answered rejected/denied (a Message, not an error) and nothing is queued", async () => {
    const h = build({}, { mode: "auto" }, { authorize: (_by, action) => action !== "queue" });
    const { first, call, taskId } = await startStream(h);
    expect(answerOf(await stream(h, message(taskId, "x"))).result).toMatchObject({ state: "rejected", reason: "denied" });
    call.view.complete({ text: "done" });
    await first;
    expect(h.provider.runs).toHaveLength(1);
  });

  it("cancel after a message was queued: the stream ends canceled once and the queued message never runs", async () => {
    const h = build();
    const { first, taskId } = await startStream(h);
    answerOf(await stream(h, message(taskId, "never")));
    const task = await h.handler.cancelTask({ tenant: "", id: taskId, metadata: undefined } as any, ctx());
    expect(task.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    const r1 = await first;
    expect(r1.error).toBeUndefined();
    await h.registry.drain();
    expect(h.provider.runs).toHaveLength(1);
    expect((await h.runStore.listQueued(taskId))[0]).toMatchObject({ state: "dropped", reason: "task canceled" });
  });
});

describe("interrupt with no follow-up content through the SDK: stop and wait", () => {
  it("the stream ends at input-required marked interrupted; the next message opens with the Task snapshot and continues the SAME run", async () => {
    const h = build();
    const { first, call, taskId } = await startStream(h);
    const ack = answerOf(await stream(h, message(taskId, "", withDelivery("interrupt"))));
    expect(ack.result).toMatchObject({ state: "interrupted" });

    const r1 = await first;
    expect(r1.error).toBeUndefined();
    expect(kinds(r1.events).at(-1)).toBe("status:TASK_STATE_INPUT_REQUIRED");
    const last = r1.events.at(-1).payload.value;
    expect(last.metadata).toMatchObject({ interrupted: true });
    expect((await stored(h, taskId))?.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(h.registry.isParked(taskId)).toBe(true);

    const cont = stream(h, message(taskId, "carry on"));
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(2));
    expect(h.provider.runs[1].req.runId).toBe(call.req.runId);
    h.provider.runs[1].view.complete({ text: "finished" });
    const r2 = await cont;
    expect(r2.error).toBeUndefined();
    expect(kinds(r2.events)[0]).toBe("task"); // a stream opens with the snapshot
    expect(kinds(r2.events).at(-1)).toBe("status:TASK_STATE_COMPLETED");
    const working = r2.events.find((e: any) => e.payload.$case === "statusUpdate" && e.payload.value.status.state === TaskState.TASK_STATE_WORKING);
    expect(deliveryResultFromMetadata(working.payload.value.status.message.metadata)).toMatchObject({ state: "queued", reason: "continues-interrupted-task" });
    expect((await stored(h, taskId))?.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});

describe("a message to a task parked on an interaction", () => {
  const permission: CoreInteractionRequest = {
    kind: "permission",
    title: "Run npm test?",
    options: [
      { id: "once", label: "Allow once", kind: "allow_once" },
      { id: "no", label: "Reject", kind: "reject_once" },
    ],
  };
  const interactionId = async (h: H, taskId: string) => (await h.runStore.listPending(taskId))[0].interaction.id;

  async function park(h: H) {
    const first = stream(h, message("", "go"));
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const answer = call.view.ask(permission);
    await first; // the stream ended at input-required
    return { call, answer, taskId: call.req.taskId };
  }

  it("a steer is queued BEHIND the interaction: the stream gets the Task, then the stored status re-asserted with the delivery result; the prompt is not replaced", async () => {
    const h = build({ steer: async () => ({ state: "inserted" }) }, { mode: "ask" });
    const { call, answer, taskId } = await park(h);
    const before = (await stored(h, taskId))!.status.message;

    const r = await stream(h, message(taskId, "yes do it", withDelivery("steer")));
    expect(r.error).toBeUndefined();
    expect(kinds(r.events)).toEqual(["task", "status:TASK_STATE_INPUT_REQUIRED"]);
    const status = r.events[1].payload.value.status;
    expect(deliveryResultFromMetadata(status.message.metadata)).toMatchObject({ state: "queued", holder: "core", reason: expect.stringMatching(/^interaction-presented/) });
    expect(textOf(status.message)).toBe(textOf(before)); // still the prompt
    expect(status.message.messageId).toBe(before!.messageId);
    expect(h.provider.steer).not.toHaveBeenCalled();
    expect((await h.runStore.listPending(taskId))[0].state).toBe("presented"); // not answered

    // Answer it; the steer runs afterwards as the next turn.
    const replied = stream(h, dataMessage(taskId, { interactionId: await interactionId(h, taskId), optionId: "once" }));
    expect(await answer).toMatchObject({ outcome: "selected" });
    call.view.complete({ text: "turn one" });
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(2));
    h.provider.runs[1].view.complete({ text: "turn two" });
    const r2 = await replied;
    expect(r2.error).toBeUndefined();
    expect(kinds(r2.events).at(-1)).toBe("status:TASK_STATE_COMPLETED");
  });

  it("a BLOCKING steer to a parked task returns the Task in input-required with the result in its status message metadata", async () => {
    const h = build({}, { mode: "ask" });
    const { taskId } = await park(h);
    const t: any = await send(h, message(taskId, "x", withDelivery("steer")));
    expect(t.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(deliveryResultFromMetadata(t.status.message.metadata)).toMatchObject({ state: "queued", holder: "core" });
    expect(textOf(t.status.message)).toMatch(/Run npm test\?/);
  });

  it("an interrupt PREEMPTS the interaction: the stream carries the next turn on to its end", async () => {
    const h = build({}, { mode: "ask" });
    const { call, answer, taskId } = await park(h);
    const next = stream(h, message(taskId, "never mind, do this", withDelivery("interrupt")));
    expect(await answer).toEqual({ outcome: "canceled" });
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(2));
    expect(call.view.signal.reason).toBe("interrupt");
    h.provider.runs[1].view.complete({ text: "done" });
    const r = await next;
    expect(r.error).toBeUndefined();
    expect(kinds(r.events)[0]).toBe("task");
    const working = r.events.find((e: any) => e.payload.$case === "statusUpdate" && e.payload.value.status.state === TaskState.TASK_STATE_WORKING);
    expect(deliveryResultFromMetadata(working.payload.value.status.message.metadata)).toMatchObject({ state: "interrupted" });
    expect(kinds(r.events).at(-1)).toBe("status:TASK_STATE_COMPLETED");
    expect((await h.runStore.listPending(taskId))[0].state).toBe("canceled");
  });

  it("two replies at once: one carries the task on, the other is answered with a Message (reply-conflict), never an error", async () => {
    // A slow authorizer keeps the park open while the second reply arrives (the window of the claim).
    const h = build({}, { mode: "ask" }, { authorize: async (_by, action) => { if (action === "answer") await tick(40); return true; } });
    const { call, answer, taskId } = await park(h);
    const id = await interactionId(h, taskId);
    const winner = stream(h, dataMessage(taskId, { interactionId: id, optionId: "once" }));
    await tick(10); // the winner holds the park's claim until its execute() ends
    const loser = await stream(h, message(taskId, "yes"));
    expect(answerOf(loser).result).toMatchObject({ state: "rejected", reason: "reply-conflict" });
    expect(await answer).toMatchObject({ outcome: "selected", optionId: "once" });
    call.view.complete({ text: "ok" });
    const w = await winner;
    expect(w.error).toBeUndefined();
    expect(kinds(w.events).at(-1)).toBe("status:TASK_STATE_COMPLETED");
    expect(h.provider.runs).toHaveLength(1);
  });

  it("known limit N3: a plain text message that arrives AFTER the interaction was answered is an ordinary message (queued), not a reply", async () => {
    const h = build({}, { mode: "ask" });
    const { call, answer, taskId } = await park(h);
    const id = await interactionId(h, taskId);
    const replied = stream(h, dataMessage(taskId, { interactionId: id, optionId: "once" }));
    await answer;
    const late = await stream(h, message(taskId, "yes"));
    expect(answerOf(late).result).toMatchObject({ state: "queued", holder: "core" });
    call.view.complete({ text: "one" });
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(2));
    h.provider.runs[1].view.complete({ text: "two" });
    expect((await replied).error).toBeUndefined();
  });
});
