/**
 * Interactions end to end through the REAL SDK `DefaultRequestHandler` (1.3, in-memory task
 * store): CoreExecutor + RunEventBusManager + OrphanGuardTaskStore + the interactions runtime over a
 * fake provider. Park and reply for blocking and streaming requests, as measured in the S1 spike
 * (s1-interrupted-states.test.ts).
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
  createStorePublisher,
  endTaskInStore,
  settleStoreWrites,
  type CoreInteractionRequest,
  type InteractionPolicy,
} from "../../index.js";
import { makeProvider } from "../runtime/harness.js";

const agentCard: any = { name: "t", description: "t", capabilities: { streaming: true }, defaultInputModes: [], defaultOutputModes: [], skills: [] };
const ctx = () => new ServerCallContext();

function textMessage(taskId = "", text = "hello", contextId = "ctx-i") {
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

/** A reply as the A2A wire carries it: a data part naming the interaction (the SDK's protobuf-style part). */
function dataMessage(taskId: string, data: Record<string, unknown>) {
  const m = textMessage(taskId, "");
  m.parts = [{ content: { $case: "data", value: data }, metadata: undefined, filename: "", mediaType: "application/json" }];
  return m;
}

function build(policy: Partial<InteractionPolicy> = { mode: "ask" }, providerOpts: Parameters<typeof makeProvider>[0] = {}) {
  const provider = makeProvider(providerOpts);
  const runStore = new InMemoryRunStore();
  const registry = new RunRegistry({ provider, store: runStore, interactionPolicy: policy, logger: { warn: vi.fn() } });
  const taskStore = new InMemoryTaskStore();
  registry.setDetachedPublisher((info) => createStorePublisher(taskStore, info));
  const busManager = new RunEventBusManager(registry);
  const handler = new DefaultRequestHandler(agentCard, new OrphanGuardTaskStore(taskStore, registry), new CoreExecutor(registry) as any, busManager);
  return { provider, runStore, registry, taskStore, busManager, handler };
}
type H = ReturnType<typeof build>;

const states = (events: any[]) =>
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

const send = (h: H, message: any) => h.handler.sendMessage({ tenant: "", message, configuration: undefined, metadata: undefined } as any, ctx());
const stream = (h: H, message: any) => collect(h.handler.sendMessageStream({ tenant: "", message, configuration: undefined, metadata: undefined } as any, ctx()));
const stored = async (h: H, id: string) => h.taskStore.load(id, ctx());

const permission: CoreInteractionRequest = {
  kind: "permission",
  title: "Run npm test?",
  subject: { tool: "bash", command: "npm test" },
  options: [
    { id: "once", label: "Allow once", kind: "allow_once" },
    { id: "no", label: "Reject", kind: "reject_once" },
  ],
};

/** The interaction payload (data part) of a status message, as a client reads it. */
function interactionOf(task: any) {
  const part = task.status.message?.parts?.find((p: any) => p.content?.$case === "data");
  return part?.content.value as { version: number; interactionId: string; interaction: any } | undefined;
}
function eventInteraction(events: any[]) {
  const status = [...events].reverse().find((e) => e.payload.$case === "statusUpdate");
  return interactionOf(status.payload.value);
}

describe("blocking message/send", () => {
  it("parks at input-required (the task carries the interaction), the reply is a second message/send, the SAME run finishes", async () => {
    const h = build();
    const first = send(h, textMessage());
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const asked = call.view.ask(permission);
    const parked: any = await first;
    expect(parked.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const payload = interactionOf(parked)!;
    expect(payload).toMatchObject({ version: 1, interaction: { kind: "permission", title: "Run npm test?" } });
    expect(parked.status.message.parts[0].content.value).toMatch(/Run npm test\?[\s\S]*1\. Allow once[\s\S]*code/);
    expect(h.busManager.getByTaskId(parked.id, ctx())).toBeDefined(); // the bus lives on for the reply
    expect(h.registry.isParked(parked.id)).toBe(true);

    const replied = send(h, dataMessage(parked.id, { interactionId: payload.interactionId, optionId: "once" }));
    expect(await asked).toMatchObject({ outcome: "selected", optionId: "once" });
    call.view.event({ type: "text", text: "tests pass" });
    call.view.complete({});
    const done: any = await replied;
    expect(done.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(h.provider.run).toHaveBeenCalledTimes(1); // one provider run for the whole conversation
    expect(done.artifacts.flatMap((a: any) => a.parts).map((p: any) => p.content.value).join("")).toBe("tests pass");
    expect(h.busManager.getByTaskId(parked.id, ctx())).toBeUndefined();
  });

  it("a text reply with the code approves; without it, the client gets the prompt again", async () => {
    const h = build();
    const first = send(h, textMessage());
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const asked = h.provider.runs[0].view.ask(permission);
    const parked: any = await first;
    const { interaction } = interactionOf(parked)!;

    const nudged: any = await send(h, textMessage(parked.id, "yes"));
    expect(nudged.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(nudged.status.message.parts[0].content.value).toMatch(/could not be matched/);
    expect(h.registry.isParked(parked.id)).toBe(true);

    const approved = send(h, textMessage(parked.id, `1 ${interaction.replyCode}`));
    expect(await asked).toMatchObject({ outcome: "selected", optionId: "once" });
    h.provider.runs[0].view.complete({ text: "ok" });
    expect(((await approved) as any).status.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});

describe("streaming message/stream", () => {
  it("the stream parks and ends at input-required; the reply's stream opens with the Task snapshot and carries the rest (text appended, not replaced)", async () => {
    const h = build();
    const s1 = stream(h, textMessage());
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    call.view.event({ type: "text", text: "Let me run the tests. " });
    const asked = call.view.ask(permission);
    const r1 = await s1;
    expect(r1.error).toBeUndefined();
    expect(states(r1.events)[0]).toBe("task");
    expect(states(r1.events).at(-1)).toBe("status:TASK_STATE_INPUT_REQUIRED");
    const taskId = call.req.taskId;
    const payload = eventInteraction(r1.events)!;

    const s2 = stream(h, dataMessage(taskId, { interactionId: payload.interactionId, optionId: "once" }));
    expect(await asked).toMatchObject({ outcome: "selected" });
    call.view.event({ type: "text", text: "All green." });
    call.view.complete({});
    const r2 = await s2;
    expect(r2.error).toBeUndefined();
    const kinds = states(r2.events);
    expect(kinds[0]).toBe("task"); // the snapshot the SDK demands first
    expect(kinds.at(-1)).toBe("status:TASK_STATE_COMPLETED");
    expect(kinds).toContain("status:TASK_STATE_WORKING");
    expect(h.provider.run).toHaveBeenCalledTimes(1);
    const t = await stored(h, taskId);
    expect(t?.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    // the artifact the run started before the park was APPENDED to after the reply, not replaced
    expect(t?.artifacts.flatMap((a) => a.parts).map((p: any) => p.content.value).join("")).toBe("Let me run the tests. All green.");
  });

  it("auth-required: core closes the stream at the park (the SDK would keep it open), and the reply resumes the same run", async () => {
    const h = build();
    const s1 = stream(h, textMessage());
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const asked = call.view.ask({ kind: "auth", title: "Sign in to GitHub", auth: { service: "github", url: "https://github.com/login/device", userCode: "AB-CD" } });
    const r1 = await s1; // resolves: the stream ended
    expect(states(r1.events).at(-1)).toBe("status:TASK_STATE_AUTH_REQUIRED");
    const payload = eventInteraction(r1.events)!;
    expect(payload.interaction.auth).toMatchObject({ service: "github", userCode: "AB-CD" });

    const s2 = stream(h, dataMessage(call.req.taskId, { interactionId: payload.interactionId, completed: true }));
    expect(await asked).toMatchObject({ outcome: "completed" });
    call.view.complete({ text: "signed in, done" });
    const r2 = await s2;
    expect(r2.error).toBeUndefined();
    expect(states(r2.events).at(-1)).toBe("status:TASK_STATE_COMPLETED");
    expect(h.provider.run).toHaveBeenCalledTimes(1);
  });

  it("two asks in a row: the second is presented on the reply's stream, which then ends at that input-required", async () => {
    const h = build();
    const s1 = stream(h, textMessage());
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const a = call.view.ask(permission);
    const b = call.view.ask({ kind: "confirm", title: "Second?" });
    const r1 = await s1;
    const first = eventInteraction(r1.events)!;
    const r2 = await stream(h, dataMessage(call.req.taskId, { interactionId: first.interactionId, optionId: "once" }));
    await a;
    expect(states(r2.events).at(-1)).toBe("status:TASK_STATE_INPUT_REQUIRED");
    const second = eventInteraction(r2.events)!;
    expect(second.interaction.title).toBe("Second?");
    const r3 = stream(h, dataMessage(call.req.taskId, { interactionId: second.interactionId, optionId: "allow" }));
    expect(await b).toMatchObject({ outcome: "selected", optionId: "allow" });
    call.view.complete({ text: "done" });
    expect(states((await r3).events).at(-1)).toBe("status:TASK_STATE_COMPLETED");
  });
});

describe("core acts on a parked run nobody is consuming (the detached publisher writes the task store)", () => {
  it("expiry: the stored task goes failed with the reason, the provider is aborted, the run is gone", async () => {
    const h = build({ mode: "ask", timeoutMs: 60, onTimeout: "fail" });
    const s1 = stream(h, textMessage());
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const asked = call.view.ask(permission);
    await s1;
    expect((await stored(h, call.req.taskId))?.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    await vi.waitFor(async () => expect((await stored(h, call.req.taskId))?.status.state).toBe(TaskState.TASK_STATE_FAILED), { timeout: 2000 });
    await settleStoreWrites(call.req.taskId);
    const t = await stored(h, call.req.taskId);
    expect((t?.status.message?.parts[0] as any).content.value).toMatch(/not answered in time/);
    expect((await asked).outcome === "selected").toBe(false);
    await h.registry.drain();
    expect(h.provider.abort).toHaveBeenCalledTimes(1);
    expect(h.registry.isLive(call.req.taskId)).toBe(false);
    expect(h.busManager.getByTaskId(call.req.taskId, ctx())).toBeUndefined();
    expect((await h.runStore.getRun(call.req.taskId))?.state).toBe("failed");
    // and a reply now is refused by the SDK: the task is terminal
    await expect(send(h, textMessage(call.req.taskId, "approve"))).rejects.toThrow(/terminal/i);
  });

  it("onTimeout deny: the stored task goes back to working and the run continues to completion with nobody attached", async () => {
    const h = build({ mode: "ask", timeoutMs: 60, onTimeout: "deny" });
    const s1 = stream(h, textMessage());
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const asked = call.view.ask(permission);
    await s1;
    expect(await asked).toEqual({ outcome: "expired" });
    await vi.waitFor(async () => expect((await stored(h, call.req.taskId))?.status.state).toBe(TaskState.TASK_STATE_WORKING), { timeout: 2000 });
    call.view.event({ type: "text", text: "went on without approval" });
    call.view.complete({});
    await vi.waitFor(async () => expect((await stored(h, call.req.taskId))?.status.state).toBe(TaskState.TASK_STATE_COMPLETED), { timeout: 2000 });
    await settleStoreWrites(call.req.taskId);
    const t = await stored(h, call.req.taskId);
    expect(t?.artifacts.flatMap((a) => a.parts).map((p: any) => p.content.value).join("")).toBe("went on without approval");
  });

  it("withdrawal of the presented ask returns the stored task to working", async () => {
    const h = build();
    const s1 = stream(h, textMessage());
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const ac = new AbortController();
    const asked = call.view.ask(permission, { signal: ac.signal });
    await s1;
    ac.abort();
    expect(await asked).toEqual({ outcome: "withdrawn" });
    await vi.waitFor(async () => expect((await stored(h, call.req.taskId))?.status.state).toBe(TaskState.TASK_STATE_WORKING));
    call.view.complete({ text: "ok" });
    await vi.waitFor(async () => expect((await stored(h, call.req.taskId))?.status.state).toBe(TaskState.TASK_STATE_COMPLETED));
  });

  it("tasks/cancel on a parked task: canceled once, the ask is canceled, the abort goes to the provider", async () => {
    const h = build();
    const s1 = stream(h, textMessage());
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    const asked = call.view.ask(permission);
    await s1;
    const task = await h.handler.cancelTask({ tenant: "", id: call.req.taskId, metadata: undefined } as any, ctx());
    expect(task.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(await asked).toEqual({ outcome: "canceled" });
    await h.registry.drain();
    expect(h.provider.abort).toHaveBeenCalledTimes(1);
  });
});

describe("restart", () => {
  it("fail path through the SDK: the sweep fails a parked task with 'server restarted' and the client sees it", async () => {
    const h = build();
    const s1 = stream(h, textMessage());
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    void call.view.ask(permission);
    await s1;
    const taskId = call.req.taskId;

    // "restart": a new registry and handler over the same stores; the provider has no reattach
    const provider2 = makeProvider();
    const registry2 = new RunRegistry({ provider: provider2, store: h.runStore, interactionPolicy: { mode: "ask" } });
    const handler2 = new DefaultRequestHandler(agentCard, new OrphanGuardTaskStore(h.taskStore, registry2), new CoreExecutor(registry2) as any, new RunEventBusManager(registry2));
    const report = await registry2.sweep({ endTask: endTaskInStore(h.taskStore) });
    expect(report.entries).toMatchObject([{ taskId, action: "interrupted-failed" }]);
    const t = await handler2.getTask({ tenant: "", id: taskId, historyLength: undefined } as any, ctx());
    expect(t.status.state).toBe(TaskState.TASK_STATE_FAILED);
    expect((t.status.message?.parts[0] as any).content.value).toBe("server restarted");
    expect((await h.runStore.listPending(taskId))[0]).toMatchObject({ state: "expired" });
    await expect(send({ ...h, handler: handler2 } as any, textMessage(taskId, "approve"))).rejects.toThrow(/terminal/i);
  });

  it("reattach path through the SDK: a client reply after the restart resolves the restored interaction and the task completes", async () => {
    const h = build();
    const s1 = stream(h, textMessage());
    await vi.waitFor(() => expect(h.provider.runs).toHaveLength(1));
    const call = h.provider.runs[0];
    void call.view.ask(permission, { handle: "backend-req-1" });
    const r1 = await s1;
    const taskId = call.req.taskId;
    const payload = eventInteraction(r1.events)!;
    await h.registry.drain();

    let continued: Promise<unknown> | undefined;
    let resumedView: any;
    const provider2 = makeProvider();
    (provider2 as any).reattach = async (pending: any[], runs: any) => {
      resumedView = runs.view(pending[0].taskId);
      continued = resumedView.ask(permission, { handle: pending[0].handle });
    };
    const registry2 = new RunRegistry({ provider: provider2, store: h.runStore, interactionPolicy: { mode: "ask" } });
    registry2.setDetachedPublisher((info) => createStorePublisher(h.taskStore, info));
    const h2 = {
      ...h,
      registry: registry2,
      busManager: new RunEventBusManager(registry2),
    } as any;
    h2.handler = new DefaultRequestHandler(agentCard, new OrphanGuardTaskStore(h.taskStore, registry2), new CoreExecutor(registry2) as any, h2.busManager);
    const report = await registry2.sweep({ endTask: endTaskInStore(h.taskStore) });
    expect(report.entries[0].action).toBe("interrupted-reattached");
    expect((await stored(h, taskId))?.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED); // untouched

    const replied = send(h2, dataMessage(taskId, { interactionId: payload.interactionId, optionId: "once" }));
    expect(await continued).toMatchObject({ outcome: "selected", optionId: "once" });
    resumedView.event({ type: "text", text: "resumed after restart" });
    resumedView.complete({});
    const done: any = await replied;
    expect(done.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(provider2.run).not.toHaveBeenCalled();
    expect(done.artifacts.flatMap((a: any) => a.parts).map((p: any) => p.content.value).join("")).toBe("resumed after restart");
  });
});
