/**
 * Steering, queueing and interrupting a running task, through the real request handler, against a scripted OpenCode server:
 * what a 2.x server's durable inbox can honestly promise (`inserted` when the server says it delivered the message into the
 * running turn, `queued` with the inbox id when it has not yet), held turns, and the abort reasons. A 1.x server has no native
 * steering: the provider has no `steer` handler there and core says so.
 *
 * The server is played by hand: the events are the ones a real 2.x server sent in the live runs these tests mirror
 * (`session.inbox.delivered` at the next step boundary, `session.execution.started` before the delivery that starts it).
 */

import { describe, expect, it } from "vitest";
import { DELIVERY_RESULT_META_KEY, deliveryResultFromMetadata, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { FakeBackend, assistant, hang, idle, reply, text } from "./helpers/fake-backend.js";
import { serve, sleep, until, useConfig } from "./helpers/harness.js";

void DELIVERY_RESULT_META_KEY;
const ctx = useConfig();

function boot(opts: { steerAck?: number; kind?: "v1" | "v2"; scripts?: Parameters<typeof reply>[0][] | any[] } = {}) {
  if (opts.steerAck !== undefined) ctx.config.timeouts.steerAck = opts.steerAck;
  const backend = new FakeBackend({ kind: opts.kind ?? "v2", autoDeliver: true, scripts: opts.scripts ?? [hang(), hang(), hang()] });
  return serve(ctx.config, backend);
}
type H = ReturnType<typeof boot>;

/** Start a streaming task and wait until the server has its prompt. */
async function startRunning(h: H, contextId = "ctx") {
  const live = h.server.startStream({ text: "first", contextId });
  await until(() => h.backend.prompts.length === 1, 2000, "the prompt to reach the server");
  await sleep(15);
  const taskId = (live.events[0] as any).payload.value.id as string;
  return { live, taskId };
}

/** What a request to a running task is answered with: its single Message and the DeliveryResult in it. */
async function steerWith(h: H, taskId: string, delivery: string, textValue = "also this", contextId = "ctx") {
  const r = await h.server.stream({ text: textValue, contextId, taskId, delivery });
  expect(r.error).toBeUndefined();
  const message = (r.events[0] as any).payload.value;
  return deliveryResultFromMetadata(message.metadata)!;
}

const responses = (task: any) => summarizeTask(task).artifacts.filter((a) => a.name === "response").map((a) => a.text);
const finish = (b: FakeBackend, answer: string) => {
  b.emit(assistant("m", {}, "ses_1"));
  b.emit(text(answer, "ses_1"));
  b.emit(idle("ses_1"));
};

describe("steer on a 2.x server: the durable inbox", () => {
  it("sends the message with delivery `steer` and says `inserted` once the server delivered it into the running turn", async () => {
    const h = boot();
    const { live, taskId } = await startRunning(h);

    const delivered = steerWith(h, taskId, "steer", "also say STEERED");
    await until(() => h.backend.prompts.length === 2);
    expect(h.backend.prompts[1]).toMatchObject({ delivery: "steer", body: { delivery: "steer", parts: [{ type: "text", text: "also say STEERED" }] } });
    h.backend.deliver(h.backend.prompts[1]!.inboxId!);
    expect(await delivered).toMatchObject({ state: "inserted", taskId });

    finish(h.backend, "DONE STEERED");
    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(responses(await h.server.getTask(taskId))).toEqual(["DONE STEERED"]);
  });

  it("no word within the window: honestly `queued` with the inbox id; a delivery into the running execution settles it as inserted (no new turn)", async () => {
    const h = boot({ steerAck: 30 });
    const { live, taskId } = await startRunning(h);

    const result = await steerWith(h, taskId, "steer");
    expect(result).toMatchObject({ state: "queued", holder: "provider", taskId });
    const handle = h.backend.prompts[1]!.inboxId!;
    // the server folds it into the turn that is running at the next step boundary: no new turn
    h.backend.deliver(handle);
    await sleep(20);
    finish(h.backend, "one answer");

    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(responses(await h.server.getTask(taskId))).toEqual(["one answer"]);
    const records = await h.server.runStore.listQueued(taskId);
    expect(records.map((r) => r.state)).toEqual(["done"]);
  });

  it("the execution ends first and the server starts the held message as its own execution: the turn splits there (beginHeldTurn)", async () => {
    const h = boot({ steerAck: 400 });
    const { live, taskId } = await startRunning(h);

    const steered = steerWith(h, taskId, "steer", "and then this");
    await until(() => h.backend.prompts.length === 2);
    await sleep(450); // the window passes: queued
    expect(await steered).toMatchObject({ state: "queued", holder: "provider" });
    const handle = h.backend.prompts[1]!.inboxId!;

    finish(h.backend, "first answer"); // the execution ends with the held message still parked
    await sleep(30);
    h.backend.emit({ type: "session.execution.started", properties: { sessionID: "ses_1" } }); // the server wakes up for it...
    h.backend.deliver(handle); // ...and delivers it
    await sleep(20);
    h.backend.emit(text("second answer", "ses_1"));
    h.backend.emit(idle("ses_1"));

    const { events } = await live.done;
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(responses(await h.server.getTask(taskId))).toEqual(["first answer", "second answer"]);
  });

  it("a held message the server never delivers is taken out of the inbox and handed back to core, which runs it as the next turn", async () => {
    const h = boot({ steerAck: 40, scripts: [hang(), hang(), reply("requeued answer")] });
    const { live, taskId } = await startRunning(h);

    expect(await steerWith(h, taskId, "steer", "do this too")).toMatchObject({ state: "queued", holder: "provider" });
    const handle = h.backend.prompts[1]!.inboxId!;
    finish(h.backend, "first answer");

    const { events } = await live.done;
    await h.server.registry.drain();
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(h.backend.calls).toContain(`inboxCancel:${handle}`);
    // the message ran as its own turn: a third prompt with the same text, after the first answer
    expect(h.backend.prompts.map((p) => p.body.parts[0].text)).toEqual(["first", "do this too", "do this too"]);
    expect(responses(await h.server.getTask(taskId))).toEqual(["first answer", "requeued answer"]);
  });

  it("a delivery inside the window is `inserted` and the task keeps a single answer", async () => {
    const h = boot({ steerAck: 300 });
    const { live, taskId } = await startRunning(h);
    const steered = steerWith(h, taskId, "steer");
    await until(() => h.backend.prompts.length === 2);
    h.backend.deliver(h.backend.prompts[1]!.inboxId!);
    expect(await steered).toMatchObject({ state: "inserted" });
    finish(h.backend, "ok");
    await live.done;
    expect(responses(await h.server.getTask(taskId))).toEqual(["ok"]);
  });
});

describe("cancel and interrupt with a held message", () => {
  it("cancel takes the held message out of the inbox, drops its handle and stops the session", async () => {
    const h = boot({ steerAck: 30 });
    const { live, taskId } = await startRunning(h);
    expect(await steerWith(h, taskId, "steer")).toMatchObject({ state: "queued" });
    const handle = h.backend.prompts[1]!.inboxId!;

    const canceled = await h.server.cancel(taskId);
    expect(summarizeTask(canceled).state).toBe("canceled");
    await live.done;
    await h.server.registry.drain();

    expect(h.backend.calls).toContain("sessionAbort:ses_1");
    expect(h.backend.calls).toContain(`inboxCancel:${handle}`);
    const records = await h.server.runStore.listQueued(taskId);
    expect(records.map((r) => r.state)).toEqual(["dropped"]);
  });

  it("interrupt hands the held message back to core: the interrupting message runs first, then the held one", async () => {
    const h = boot({ steerAck: 30, scripts: [hang(), hang(), reply("INTERRUPTED"), reply("HELD ANSWER")] });
    const { live, taskId } = await startRunning(h);
    expect(await steerWith(h, taskId, "steer", "held text")).toMatchObject({ state: "queued" });
    const handle = h.backend.prompts[1]!.inboxId!;

    expect(await steerWith(h, taskId, "interrupt", "forget it, say INTERRUPTED")).toMatchObject({ state: "interrupted" });
    await live.done;
    await h.server.registry.drain();

    expect(h.backend.calls).toContain("sessionAbort:ses_1");
    expect(h.backend.calls).toContain(`inboxCancel:${handle}`);
    expect(h.backend.prompts.map((p) => p.body.parts[0].text)).toEqual(["first", "held text", "forget it, say INTERRUPTED", "held text"]);
    expect(responses(await h.server.getTask(taskId))).toEqual(["INTERRUPTED", "HELD ANSWER"]);
  });
});

describe("steer on a 1.x server", () => {
  it("has no handler (OpenCode 1.x has no native steering): core holds the message and runs it as the next turn, and says so", async () => {
    const h = boot({ kind: "v1", scripts: [hang(), reply("second turn")] });
    expect(h.provider.steer).toBeUndefined();
    await h.provider.initialize();
    expect(h.provider.steer).toBeUndefined();
    const { live, taskId } = await startRunning(h);

    const result = await steerWith(h, taskId, "steer", "also this");
    expect(result).toMatchObject({ state: "queued", holder: "core", taskId });
    // nothing was sent to the server while the turn runs
    expect(h.backend.prompts).toHaveLength(1);

    finish(h.backend, "first answer");
    await live.done;
    await h.server.registry.drain();
    expect(h.backend.prompts.map((p) => p.body.parts[0].text)).toEqual(["first", "also this"]);
    expect(responses(await h.server.getTask(taskId))).toEqual(["first answer", "second turn"]);
  });

  it("the 2.x provider offers the handler once it is connected", async () => {
    const h = boot({ kind: "v2" });
    expect(h.provider.steer).toBeUndefined(); // not connected yet: nothing to steer
    await h.provider.initialize();
    expect(typeof h.provider.steer).toBe("function");
  });
});

describe("queue", () => {
  it("is core's: the message waits for the turn to end and runs as the next turn, with no delivery mode sent to the server", async () => {
    const h = boot({ scripts: [hang(), reply("second")] });
    const { live, taskId } = await startRunning(h);
    expect(await steerWith(h, taskId, "queue", "next please")).toMatchObject({ state: "queued", holder: "core" });
    finish(h.backend, "first");
    await live.done;
    await h.server.registry.drain();
    expect(h.backend.prompts[1]?.body.delivery).toBeUndefined();
    expect(responses(await h.server.getTask(taskId))).toEqual(["first", "second"]);
  });
});

describe("the end of an execution that is not ours", () => {
  it("an interruption announced before our own prompt was delivered belongs to the execution it replaced and is ignored", async () => {
    const h = serve(ctx.config, {
      kind: "v2",
      scripts: [
        async ({ emit, sessionId, sleep: nap }) => {
          emit({ type: "session.idle", properties: { sessionID: sessionId, execution: "interrupted", reason: "user" } });
          await nap(40);
          emit(text("the real answer", sessionId));
          emit(idle(sessionId));
        },
      ],
    });
    const { events } = await h.server.stream({ text: "go", contextId: "ctx" });
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(JSON.stringify(events.map(summarizeEvent))).toContain("the real answer");
  });
});

describe("a delivery announced before the prompt call returns", () => {
  it("is `inserted` at once (the event beat the response), not queued after the window", async () => {
    const h = boot({ steerAck: 30 });
    const { live, taskId } = await startRunning(h);
    const orig = h.backend.sessionPromptAsync.bind(h.backend);
    h.backend.sessionPromptAsync = async (...a: Parameters<typeof orig>) => {
      const r = (await orig(...a)) as { inboxId?: string };
      if (a[1].delivery === "steer") {
        h.backend.emit({ type: "session.inbox.delivered", properties: { sessionID: "ses_1", inboxID: r.inboxId } });
        await sleep(25); // the stream handles the event before the call returns
      }
      return r as never;
    };
    expect(await steerWith(h, taskId, "steer", "early")).toMatchObject({ state: "inserted" });
    finish(h.backend, "ok");
    await live.done;
  });
});
