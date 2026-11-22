/**
 * Steering, queueing and interrupting a running task, through the real request handler: what Copilot's native
 * `mode: "immediate"` can honestly promise (`inserted` when Copilot says `steering`, `queued` with a handle when the message
 * runs as its own Copilot run), held turns, and the abort reasons (`cancel` flushes Copilot's queue, `interrupt` keeps it).
 */

import { describe, expect, it, vi } from "vitest";
import { DELIVERY_RESULT_META_KEY, createProviderTestServer, deliveryResultFromMetadata, stateName, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { CopilotProvider } from "../copilot/provider.js";
import { makeConfig, type ConfigOptions } from "./helpers/config.js";
import { ManualClient, ManualSession } from "./helpers/manual-session.js";

function boot(config: ConfigOptions = {}, session = new ManualSession()) {
  const client = new ManualClient([session]);
  const provider = new CopilotProvider(makeConfig(config), { clientFactory: () => client as never });
  const server = createProviderTestServer(provider);
  return { client, session, provider, server };
}

type H = ReturnType<typeof boot>;

/** Start a streaming task and wait until its prompt was sent. */
async function startRunning(h: H, contextId = "ctx") {
  const live = h.server.startStream({ text: "first", contextId });
  await vi.waitFor(() => expect(h.session.send).toHaveBeenCalledTimes(1));
  const taskId = (live.events[0] as any).payload.value.id as string;
  return { live, taskId };
}

/** What a request to a running task is answered with: its single Message and the DeliveryResult in it. */
async function steerWith(h: H, taskId: string, delivery: string, text = "also this", contextId = "ctx") {
  const r = await h.server.stream({ text, contextId, taskId, delivery });
  expect(r.error).toBeUndefined();
  const message = r.events[0].payload.value;
  return deliveryResultFromMetadata(message.metadata)!;
}

/** The `user.message` event Copilot emits when it consumes a message. */
const echo = (s: ManualSession, clientTurnId: string, delivery: "steering" | "queued" | "idle") =>
  s.emit("user.message", { clientTurnId, delivery, content: "x" });

/** Make `send` of an immediate message answer with the given delivery after `afterMs`. */
function echoOnImmediate(s: ManualSession, delivery: "steering" | "queued" | "idle" | "none", afterMs = 0) {
  s.send.mockImplementation(async (p: { mode?: string; clientTurnId?: string }) => {
    if (p.mode === "immediate" && delivery !== "none") setTimeout(() => echo(s, p.clientTurnId!, delivery), afterMs);
    return "m";
  });
}

const responses = (task: any) => summarizeTask(task).artifacts.filter((a) => a.name === "response").map((a) => a.text);

describe("steer: Copilot's immediate send", () => {
  it("echo `steering`: the message is folded into the running turn (inserted); one turn, one answer", async () => {
    const h = boot();
    const { live, taskId } = await startRunning(h);
    h.session.send.mockImplementation(async (p: any) => {
      if (p.mode === "immediate") queueMicrotask(() => echo(h.session, p.clientTurnId, "steering"));
      return "m";
    });

    const result = await steerWith(h, taskId, "steer", "also say STEERED");
    expect(result).toMatchObject({ state: "inserted", taskId });
    // sent natively, immediate, with the correlation id Copilot echoes
    const sent = h.session.send.mock.calls.at(-1)![0];
    expect(sent).toMatchObject({ prompt: "also say STEERED", mode: "immediate" });
    expect(sent.clientTurnId).toMatch(/^copilot-steer-/);

    h.session.emit("assistant.message_delta", { deltaContent: "DONE STEERED" });
    h.session.emit("session.idle");
    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(responses(await h.server.getTask(taskId))).toEqual(["DONE STEERED"]);
  });

  it("echo `queued` in time: answered queued by the provider; the first turn ends where the held message starts, the held turn ends the task", async () => {
    const h = boot();
    const { live, taskId } = await startRunning(h);
    echoOnImmediate(h.session, "queued", 5);

    const result = await steerWith(h, taskId, "steer");
    expect(result).toMatchObject({ state: "queued", holder: "provider", taskId });
    await new Promise((r) => setTimeout(r, 20)); // the held message starts as soon as core has registered its handle

    // Copilot: the first answer, then the queued message runs as its own run
    // (the echo already arrived, so the held turn has begun; output from here belongs to it)
    h.session.emit("assistant.message_delta", { deltaContent: "second answer" });
    h.session.emit("session.idle");
    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    const task = await h.server.getTask(taskId);
    expect(stateName(task.status.state)).toBe("completed");
    expect(responses(task).at(-1)).toBe("second answer");
    expect(responses(task)).toHaveLength(2); // the first turn's response artifact (the fallback text) and the held turn's
  });

  it("no echo within the window: still answered queued; when the echo comes the turn splits there", async () => {
    const h = boot({ timeouts: { steerAck: 30 } });
    const { live, taskId } = await startRunning(h);
    echoOnImmediate(h.session, "none");

    const result = await steerWith(h, taskId, "steer");
    expect(result).toMatchObject({ state: "queued", holder: "provider" });

    h.session.emit("assistant.message_delta", { deltaContent: "first answer" });
    const heldHandle = h.session.send.mock.calls.at(-1)![0].clientTurnId;
    echo(h.session, heldHandle, "queued"); // Copilot consumes the message now: the first answer was complete
    h.session.emit("assistant.message_delta", { deltaContent: "held answer" });
    h.session.emit("session.idle");

    await live.done;
    expect(responses(await h.server.getTask(taskId))).toEqual(["first answer", "held answer"]);
  });

  it("a held message that never runs is released when the session goes idle (the task does not hang)", async () => {
    const h = boot({ timeouts: { steerAck: 20 } });
    const { live, taskId } = await startRunning(h);
    echoOnImmediate(h.session, "none");
    await steerWith(h, taskId, "steer");
    h.session.emit("assistant.message_delta", { deltaContent: "only answer" });
    h.session.emit("session.idle"); // no echo ever came
    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(responses(await h.server.getTask(taskId))).toEqual(["only answer"]);
  });

  it("a send that fails is rejected as not steerable (the task is untouched)", async () => {
    const h = boot();
    const { live, taskId } = await startRunning(h);
    h.session.send.mockRejectedValueOnce(new Error("immediate mode is not available"));
    const result = await steerWith(h, taskId, "steer");
    expect(result).toMatchObject({ state: "rejected", reason: "not-steerable" });
    h.session.emit("assistant.message_delta", { deltaContent: "still fine" });
    h.session.emit("session.idle");
    expect(summarizeEvent((await live.done).events.at(-1))).toMatchObject({ state: "completed" });
  });

  it("a message with no text cannot be steered (only text goes into a Copilot turn)", async () => {
    const h = boot();
    const { live, taskId } = await startRunning(h);
    const r = await h.server.stream({ taskId, contextId: "ctx", delivery: "steer", parts: [{ content: { $case: "data", value: { a: 1 } }, metadata: undefined, filename: "", mediaType: "application/json" }] });
    const result = deliveryResultFromMetadata(r.events[0].payload.value.metadata)!;
    expect(result).toMatchObject({ state: "rejected", reason: "unsupported" });
    h.session.emit("session.idle");
    await live.done;
  });
});

describe("queue and interrupt", () => {
  it("queue (the default): core holds the message and runs it as the next turn on the same session once the first is idle", async () => {
    const h = boot();
    const { live, taskId } = await startRunning(h);
    const result = await steerWith(h, taskId, "queue", "second please");
    expect(result).toMatchObject({ state: "queued", holder: "core", position: 1 });
    expect(h.session.send).toHaveBeenCalledTimes(1); // nothing was sent to Copilot yet

    h.session.emit("assistant.message_delta", { deltaContent: "one" });
    h.session.emit("session.idle");
    await vi.waitFor(() => expect(h.session.send).toHaveBeenCalledTimes(2));
    expect(h.session.send.mock.calls[1][0]).toMatchObject({ prompt: "second please" });
    expect(h.session.send.mock.calls[1][0].mode).toBeUndefined(); // an ordinary send, not an immediate one
    h.session.emit("assistant.message_delta", { deltaContent: "two" });
    h.session.emit("session.idle");
    await live.done;
    expect(responses(await h.server.getTask(taskId))).toEqual(["one", "two"]);
    expect(h.client.created).toHaveLength(1); // the same session
  });

  it("interrupt: aborts the session, KEEPS Copilot's queue, and runs the message as the next turn of the task", async () => {
    const h = boot();
    const { live, taskId } = await startRunning(h);
    // the abort makes Copilot go idle, as it does
    h.session.abort.mockImplementation(async () => {
      queueMicrotask(() => h.session.emit("session.idle", { aborted: true }));
    });
    const result = await steerWith(h, taskId, "interrupt", "forget that, do this");
    expect(result).toMatchObject({ state: "interrupted" });
    expect(h.session.abort).toHaveBeenCalledTimes(1);
    expect(h.session.rpc.queue.clear).not.toHaveBeenCalled(); // interrupt keeps the native queue

    await vi.waitFor(() => expect(h.session.send).toHaveBeenCalledTimes(2));
    expect(h.session.send.mock.calls[1][0]).toMatchObject({ prompt: "forget that, do this" });
    h.session.emit("assistant.message_delta", { deltaContent: "new answer" });
    h.session.emit("session.idle");
    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(responses(await h.server.getTask(taskId))).toEqual(["new answer"]);
  });

  it("cancel: aborts, FLUSHES Copilot's queue and drops the held message; the task is canceled", async () => {
    const h = boot({ timeouts: { steerAck: 20 } });
    const { live, taskId } = await startRunning(h);
    echoOnImmediate(h.session, "none");
    h.session.abort.mockImplementation(async () => {
      queueMicrotask(() => h.session.emit("session.idle", { aborted: true }));
    });
    await steerWith(h, taskId, "steer"); // held by Copilot
    await h.server.cancel(taskId);
    const { events } = await live.done;

    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "canceled" });
    await vi.waitFor(() => expect(h.session.rpc.queue.clear).toHaveBeenCalledTimes(1));
    expect(h.session.abort).toHaveBeenCalledTimes(1);
  });

  it("abort reports confirmed when Copilot goes idle, unconfirmed (still reusable) when it does not answer", async () => {
    const a = boot();
    const first = await startRunning(a);
    a.session.abort.mockImplementation(async () => {
      queueMicrotask(() => a.session.emit("session.idle", { aborted: true }));
    });
    const outcome = await a.provider.abort({ runId: "r", turnId: "t", taskId: first.taskId, contextId: "ctx" }, "cancel");
    expect(outcome).toEqual({ stopped: "confirmed", session: "reusable" });
    await a.server.cancel(first.taskId);
    await first.live.done;

    // no idle: bounded, unconfirmed
    const b = boot();
    const second = await startRunning(b);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = b.provider.abort({ runId: "r", turnId: "t", taskId: second.taskId, contextId: "ctx" }, "interrupt");
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await pending).toEqual({ stopped: "unconfirmed", session: "reusable" });
    vi.useRealTimers();
    await b.server.cancel(second.taskId);
    await second.live.done;
  });

  it("an abort for a task with no turn (still opening its session) is confirmed: nothing was sent", async () => {
    const h = boot();
    expect(await h.provider.abort({ runId: "r", turnId: "t", taskId: "unknown", contextId: "c" }, "cancel")).toEqual({ stopped: "confirmed", session: "reusable" });
    expect(h.session.abort).not.toHaveBeenCalled();
  });

  it("steer for a task with no turn is rejected no-active-turn (core then queues it)", async () => {
    const h = boot();
    expect(await h.provider.steer({ taskId: "nope" } as never, { id: "m", role: "user", parts: [{ kind: "text", text: "x" }], from: { id: "a", kind: "anonymous" }, at: "t" })).toEqual({
      state: "rejected",
      reason: "no-active-turn",
    });
  });
});

describe("the delivery result is the one metadata key a client reads", () => {
  it("uses the versioned wire key", async () => {
    const h = boot();
    const { live, taskId } = await startRunning(h);
    const r = await h.server.stream({ text: "x", contextId: "ctx", taskId, delivery: "queue" });
    expect(Object.keys(r.events[0].payload.value.metadata)).toEqual([DELIVERY_RESULT_META_KEY]);
    h.session.emit("session.idle");
    await vi.waitFor(() => expect(h.session.send).toHaveBeenCalledTimes(2));
    h.session.emit("session.idle");
    await live.done;
  });
});
