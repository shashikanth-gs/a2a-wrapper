/**
 * Steering, queueing and interrupting a running task, through the real request handler: what the Claude CLI's streaming-input
 * `priority: "next"` can honestly promise (`inserted` when the CLI folds the message into the running turn, `queued` with a
 * handle when it runs as its own turn), held turns, and the abort reasons.
 *
 * The CLI is played by hand (`ManualClient`): the messages are the ones a real CLI sent in the live runs these tests mirror
 * (`command_lifecycle` frames with the pushed uuid, `user_message_uuids` on results).
 */

import { describe, expect, it, vi } from "vitest";
import { DELIVERY_RESULT_META_KEY, deliveryResultFromMetadata, stateName, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { init, interruptedResult, lifecycle, result, text, type ManualQuery } from "./helpers/manual-client.js";
import { serveManual, sleep, until, useWorkspace } from "./helpers/harness.js";

const ctx = useWorkspace();

function boot(steerAck?: number) {
  if (steerAck !== undefined) ctx.config.timeouts.steerAck = steerAck;
  return serveManual(ctx.config);
}
type H = ReturnType<typeof boot>;

/** Start a streaming task and wait until the CLI has its prompt; the CLI reports its session. */
async function startRunning(h: H, contextId = "ctx") {
  const live = h.server.startStream({ text: "first", contextId });
  await until(() => h.client.queries.length === 1 && h.client.queries[0].inputs.length === 1, 2000, "the prompt to reach the CLI");
  const q = h.client.queries[0];
  q.emit(init("sess-1"));
  await until(() => live.events.length >= 2, 2000, "the run to start");
  const taskId = (live.events[0] as any).payload.value.id as string;
  return { live, taskId, q };
}

/** What a request to a running task is answered with: its single Message and the DeliveryResult in it. */
async function steerWith(h: H, taskId: string, delivery: string, textValue = "also this", contextId = "ctx") {
  const r = await h.server.stream({ text: textValue, contextId, taskId, delivery });
  expect(r.error).toBeUndefined();
  const message = (r.events[0] as any).payload.value;
  return deliveryResultFromMetadata(message.metadata)!;
}

const responses = (task: any) => summarizeTask(task).artifacts.filter((a) => a.name === "response").map((a) => a.text);
const uuidOf = (q: ManualQuery, n = 1) => q.inputs[n].uuid!;

describe("steer: the streaming-input priority", () => {
  it("pushes the message with a uuid and priority `next` (the CLI folds it in at the next tool boundary)", async () => {
    const h = boot();
    const { live, taskId, q } = await startRunning(h);

    const delivered = steerWith(h, taskId, "steer", "also say STEERED");
    await until(() => q.inputs.length === 2);
    expect(q.inputs[1]).toMatchObject({ type: "user", message: { role: "user", content: "also say STEERED" }, priority: "next" });
    expect(q.inputs[1].uuid).toMatch(/^[0-9a-f-]{36}$/);
    q.emit(lifecycle(uuidOf(q), "started"));
    expect(await delivered).toMatchObject({ state: "inserted", taskId });

    q.emit(text("DONE STEERED"), result("DONE STEERED", { user_message_uuids: ["x", uuidOf(q)] }));
    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(responses(await h.server.getTask(taskId))).toEqual(["DONE STEERED"]);
  });

  it("`started` before the running turn's result is a fold-in even if the answer comes after the ack window passed (settleSteer inserted)", async () => {
    const h = boot(30);
    const { live, taskId, q } = await startRunning(h);

    const delivered = steerWith(h, taskId, "steer");
    await until(() => q.inputs.length === 2);
    // no word within the window: honestly queued, held by the CLI
    expect(await delivered).toMatchObject({ state: "queued", holder: "provider", taskId });
    // the CLI then folds it into the turn that was running: no new turn
    q.emit(lifecycle(uuidOf(q), "started"));
    q.emit(text("one answer"), result("one answer", { user_message_uuids: [uuidOf(q)] }));

    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(responses(await h.server.getTask(taskId))).toEqual(["one answer"]);
  });

  it("a result that lists the uuid says it was folded in, for a CLI that sends no lifecycle frames", async () => {
    const h = boot(30);
    const { live, taskId, q } = await startRunning(h);

    const delivered = steerWith(h, taskId, "steer");
    await until(() => q.inputs.length === 2);
    expect(await delivered).toMatchObject({ state: "queued" });
    q.emit(result("answer", { user_message_uuids: [uuidOf(q)] }));

    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(responses(await h.server.getTask(taskId))).toEqual(["answer"]);
  });

  it("queued: the turn ends first, the message starts its own turn; the first turn is complete where the held turn begins", async () => {
    const h = boot(20);
    const { live, taskId, q } = await startRunning(h);

    const delivered = steerWith(h, taskId, "steer", "second please");
    await until(() => q.inputs.length === 2);
    expect(await delivered).toMatchObject({ state: "queued", holder: "provider" });
    const uuid = uuidOf(q);

    // the CLI finishes the first answer without the message (one queued turn follows), then starts the message's own turn
    q.emit(text("first answer"), result("first answer", { queued_turn_count: 1 }));
    q.emit(lifecycle(uuid, "started"), init("sess-1"), text("second answer"), result("second answer", { user_message_uuids: [uuid] }));

    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    const task = await h.server.getTask(taskId);
    expect(stateName(task.status.state)).toBe("completed");
    expect(responses(task)).toEqual(["first answer", "second answer"]);
    expect(h.client.queries).toHaveLength(1); // the same CLI process, no new query
  });

  it("a steer still waiting for its answer when the turn ends is answered queued at once (it does not wait out the window)", async () => {
    const h = boot(60_000);
    const { live, taskId, q } = await startRunning(h);

    const delivered = steerWith(h, taskId, "steer");
    await until(() => q.inputs.length === 2);
    q.emit(text("first"), result("first", { queued_turn_count: 1 }));
    expect(await delivered).toMatchObject({ state: "queued", holder: "provider" });

    const uuid = uuidOf(q);
    q.emit(lifecycle(uuid, "started"), init("sess-1"), text("held"), result("held", { user_message_uuids: [uuid] }));
    await live.done;
    expect(responses(await h.server.getTask(taskId))).toEqual(["first", "held"]);
  });

  it("a held message the CLI never starts is dropped and the task completes (it does not hang)", async () => {
    const h = boot(40);
    const { live, taskId, q } = await startRunning(h);

    const delivered = steerWith(h, taskId, "steer");
    await until(() => q.inputs.length === 2);
    expect(await delivered).toMatchObject({ state: "queued" });
    q.emit(text("only answer"), result("only answer")); // nothing queued, the uuid is not in it

    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(responses(await h.server.getTask(taskId))).toEqual(["only answer"]);
    expect(q.inputClosed).toBe(true);
  });

  it("a message the CLI cancels is rejected while the steer waits", async () => {
    const h = boot(60_000);
    const { live, taskId, q } = await startRunning(h);

    const delivered = steerWith(h, taskId, "steer");
    await until(() => q.inputs.length === 2);
    q.emit(lifecycle(uuidOf(q), "cancelled"));
    expect(await delivered).toMatchObject({ state: "rejected" });

    q.emit(text("fine"), result("fine"));
    expect(summarizeEvent((await live.done).events.at(-1))).toMatchObject({ state: "completed" });
  });

  it("a message with no text cannot be steered (only text goes into a Claude turn)", async () => {
    const h = boot();
    const { live, taskId, q } = await startRunning(h);
    const r = await h.server.stream({ taskId, contextId: "ctx", delivery: "steer", parts: [{ content: { $case: "data", value: { a: 1 } }, metadata: undefined, filename: "", mediaType: "application/json" }] });
    const delivery = deliveryResultFromMetadata((r.events[0] as any).payload.value.metadata)!;
    expect(delivery).toMatchObject({ state: "rejected", reason: "unsupported" });
    expect(q.inputs).toHaveLength(1);
    q.emit(result("done"));
    await live.done;
  });

  it("steer for a task with no turn is rejected no-active-turn (core then queues it)", async () => {
    const h = boot();
    expect(await h.provider.steer({ taskId: "nope" } as never, { id: "m", role: "user", parts: [{ kind: "text", text: "x" }], from: { id: "a", kind: "anonymous" }, at: "t" })).toEqual({
      state: "rejected",
      reason: "no-active-turn",
    });
  });
});

describe("queue and interrupt", () => {
  it("queue (the default): core holds the message and runs it as the next turn on the same session once the first ends", async () => {
    const h = boot();
    h.client.onQuery = (q, n) => {
      if (n === 1) q.emit(init("sess-1"), text("two"), result("two"));
    };
    const { live, taskId, q } = await startRunning(h);
    const delivered = await steerWith(h, taskId, "queue", "second please");
    expect(delivered).toMatchObject({ state: "queued", holder: "core", position: 1 });
    expect(q.inputs).toHaveLength(1); // nothing was pushed into the running query

    q.emit(text("one"), result("one"));
    await live.done;
    await until(() => h.client.queries.length === 2);
    expect(h.client.queries[1].options.resume).toBe("sess-1"); // the same Claude session, resumed
    expect(h.client.queries[1].inputs[0]).toMatchObject({ message: { content: "second please" } });
    await vi.waitFor(async () => expect(stateName((await h.server.getTask(taskId)).status.state)).toBe("completed"));
    expect(responses(await h.server.getTask(taskId))).toEqual(["one", "two"]);
  });

  it("interrupt: asks the CLI to end the turn, ends the process and runs the message as the next turn of the task on the same session", async () => {
    const h = boot();
    h.client.onQuery = (q, n) => {
      if (n === 1) q.emit(init("sess-1"), text("new answer"), result("new answer"));
    };
    const { live, taskId, q } = await startRunning(h);
    q.onInterrupt = () => q.emit(interruptedResult());

    const delivered = await steerWith(h, taskId, "interrupt", "forget that, do this");
    expect(delivered).toMatchObject({ state: "interrupted" });
    expect(q.interrupts).toBe(1);
    expect(q.options.abortController?.signal.aborted).toBe(true);
    expect(q.inputClosed).toBe(true);

    await until(() => h.client.queries.length === 2);
    expect(h.client.queries[1].options.resume).toBe("sess-1");
    expect(h.client.queries[1].inputs[0]).toMatchObject({ message: { content: "forget that, do this" } });
    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    // the interrupted turn's own (error) result is not a failure of the task
    expect(responses(await h.server.getTask(taskId))).toEqual(["new answer"]);
  });

  it("interrupt hands a steered message the CLI still held to core: the interrupting message runs next, then the steered one as its own turn (the CLI's queue ends with the process)", async () => {
    const h = boot(20);
    h.client.onQuery = (q, n) => {
      if (n === 1) q.emit(init("sess-1"), text("go answer"), result("go answer"));
      if (n === 2) q.emit(init("sess-1"), text("held answer"), result("held answer"));
    };
    const { live, taskId, q } = await startRunning(h);
    q.onInterrupt = () => q.emit(interruptedResult());
    expect(await steerWith(h, taskId, "steer", "held one")).toMatchObject({ state: "queued" });

    expect(await steerWith(h, taskId, "interrupt", "go")).toMatchObject({ state: "interrupted" });
    await live.done;
    // not carried over to the new query by the CLI: the interrupting message runs next (design doc 3.4), then core runs the steered one as its own turn
    await until(() => h.client.queries.length === 3);
    expect(h.client.queries[1].inputs.map((i) => i.message.content)).toEqual(["go"]);
    expect(h.client.queries[2].inputs.map((i) => i.message.content)).toEqual(["held one"]);
    await vi.waitFor(async () => expect(stateName((await h.server.getTask(taskId)).status.state)).toBe("completed"));
    // each turn of the task has its own response artifact (the second and third turns by core's turn ordinal)
    expect(responses(await h.server.getTask(taskId))).toEqual(["go answer", "held answer"]);
    // ... named by core's turn ordinal (no process-local counter): the first turn's id is unchanged, later turns get `-t<n>`
    const ids = ((await h.server.getTask(taskId)).artifacts as any[]).filter((a) => a.name === "response").map((a) => a.artifactId);
    expect(ids).toEqual([`response-${taskId}-t1-1`, `response-${taskId}-t2-1`]);
  });

  it("interrupt while the steer is still waiting for the CLI's word: the message is answered queued and handed to core the same way", async () => {
    const h = boot(60_000);
    h.client.onQuery = (q, n) => {
      if (n === 1) q.emit(init("sess-1"), text("go answer"), result("go answer"));
      if (n === 2) q.emit(init("sess-1"), text("held answer"), result("held answer"));
    };
    const { live, taskId, q } = await startRunning(h);
    q.onInterrupt = () => q.emit(interruptedResult());
    const pending = steerWith(h, taskId, "steer", "pending one"); // no word from the CLI yet
    await until(() => q.inputs.length === 2);
    expect(await steerWith(h, taskId, "interrupt", "go")).toMatchObject({ state: "interrupted" });
    expect(await pending).toMatchObject({ state: "queued" });
    await live.done;
    await until(() => h.client.queries.length === 3);
    expect(h.client.queries[1].inputs.map((i) => i.message.content)).toEqual(["go"]);
    expect(h.client.queries[2].inputs.map((i) => i.message.content)).toEqual(["pending one"]);
  });

  it("cancel: aborts and ends the query, drops the held message; the task is canceled", async () => {
    const h = boot(20);
    const { live, taskId, q } = await startRunning(h);
    expect(await steerWith(h, taskId, "steer")).toMatchObject({ state: "queued" }); // held by the CLI

    await h.server.cancel(taskId);
    const { events } = await live.done;

    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "canceled" });
    expect(q.options.abortController?.signal.aborted).toBe(true);
    expect(q.interrupts).toBe(1);
    expect(q.inputClosed).toBe(true);
    expect(stateName((await h.server.getTask(taskId)).status.state)).toBe("canceled");
  });

  it("abort reports confirmed when the query ends, unconfirmed (still reusable) when it does not", async () => {
    const a = boot();
    const first = await startRunning(a);
    const outcome = await a.provider.abort({ runId: "r", turnId: "t", taskId: first.taskId, contextId: "ctx" }, "cancel");
    expect(outcome).toEqual({ stopped: "confirmed", session: "reusable" });
    await a.server.cancel(first.taskId);
    await first.live.done;

    // a CLI that never ends: bounded, unconfirmed
    const b = boot();
    const second = await startRunning(b);
    second.q.stubborn = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = b.provider.abort({ runId: "r", turnId: "t", taskId: second.taskId, contextId: "ctx" }, "cancel");
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await pending).toEqual({ stopped: "unconfirmed", session: "reusable" });
    vi.useRealTimers();
    second.q.fail(new Error("gone"));
    await b.server.cancel(second.taskId);
    await second.live.done;
  });

  it("an abort for a task with no turn (still opening) is confirmed: nothing was started", async () => {
    const h = boot();
    expect(await h.provider.abort({ runId: "r", turnId: "t", taskId: "unknown", contextId: "c" }, "cancel")).toEqual({ stopped: "confirmed", session: "reusable" });
  });

  it("shutdown stops what is running", async () => {
    const h = boot();
    const { live, q } = await startRunning(h);
    await h.provider.shutdown();
    expect(q.options.abortController?.signal.aborted).toBe(true);
    expect(q.inputClosed).toBe(true);
    await live.done.catch(() => undefined);
  });

  it("a cancel before the query exists starts nothing", async () => {
    const h = boot();
    h.provider.initialize = ((orig) => async () => {
      await sleep(30);
      return orig();
    })(h.provider.initialize.bind(h.provider));
    const live = h.server.startStream({ text: "go", contextId: "ctx" });
    await until(() => live.events.length >= 1);
    const taskId = (live.events[0] as any).payload.value.id as string;
    await h.server.cancel(taskId);
    await live.done;
    await sleep(60);
    expect(h.client.queries).toHaveLength(0);
  });
});

describe("the delivery result is the one metadata key a client reads", () => {
  it("uses the versioned wire key", async () => {
    const h = boot();
    h.client.onQuery = (q, n) => {
      if (n === 1) q.emit(init("sess-1"), result("two"));
    };
    const { live, taskId, q } = await startRunning(h);
    const r = await h.server.stream({ text: "x", contextId: "ctx", taskId, delivery: "queue" });
    expect(Object.keys((r.events[0] as any).payload.value.metadata)).toEqual([DELIVERY_RESULT_META_KEY]);
    q.emit(result("one"));
    await live.done;
    await until(() => h.client.queries.length === 2);
  });
});
