import { describe, it, expect } from "vitest";
import { summarizeEvent, type AgentEvent } from "@a2a-wrapper/core";
import type { SDKMessageLike } from "../claude/client-factory.js";
import { artifacts, responses, serve, sleep, states, streamText, useWorkspace } from "./helpers/harness.js";

const ctx = useWorkspace("a2a-claude-bg-");

const init = (sessionId: string): SDKMessageLike => ({ type: "system", subtype: "init", session_id: sessionId, model: "claude-test" });

const bgChanged = (...ids: string[]): SDKMessageLike => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: ids.map((id) => ({ task_id: id, task_type: "shell", description: `task ${id}` })),
});

const result = (text: string): SDKMessageLike => ({
  type: "result",
  subtype: "success",
  result: text,
  usage: { input_tokens: 1, output_tokens: 1 },
  total_cost_usd: 0.01,
  num_turns: 1,
});

const errorResult = (subtype: string): SDKMessageLike => ({ type: "result", subtype, errors: ["boom"], usage: {}, total_cost_usd: 0, num_turns: 1 });

const rejected = (): SDKMessageLike => ({
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: Date.now() + 3_600_000, utilization: 1 },
});

/** Fail fast rather than hanging to vitest's default timeout, so a wedge has a bounded, legible signal. */
async function settleWithin<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("held-open A2A task", () => {
  it("stays working when a result arrives with background work in flight", async () => {
    const { server } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), result("build started"), bgChanged(), result("build passed")] }]);

    const { summary } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "working", "completed"]);
  });

  it("publishes one artifact per round", async () => {
    const { server } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), result("build started"), bgChanged(), result("build passed")] }]);

    const { summary } = await streamText(server);

    const texts = responses(summary).map((a) => JSON.stringify(a));
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("build started");
    expect(texts[1]).toContain("build passed");
  });

  it("carries the live set as status metadata on the held update", async () => {
    const { server } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), result("waiting"), bgChanged(), result("done")] }]);

    const { summary, events } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "working", "completed"]);
    const held = summary.filter((e) => e.k === "status")[1] as { metaKeys: string[]; text?: string };
    expect(held.metaKeys).toEqual(["backgroundTasks"]);
    expect(held.text).toBe("waiting");
    expect(JSON.stringify(events)).toContain("bg1");
  });

  it("loops for as many rounds as the chain needs", async () => {
    const { server } = serve(ctx.config, [
      {
        messages: [
          init("s1"),
          bgChanged("bg1"), result("stage 1 running"),
          bgChanged(), bgChanged("bg2"), result("stage 2 running"),
          bgChanged(), result("both done"),
        ],
      },
    ]);

    const { summary } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "working", "working", "completed"]);
    expect(responses(summary)).toHaveLength(3);
  });

  it("completes at the first result when nothing is in flight", async () => {
    const { server } = serve(ctx.config, [{ messages: [init("s1"), result("hello world")] }]);

    const { summary } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "completed"]);
    expect(responses(summary)).toHaveLength(1);
  });

  it("completes at the first result when the flag is off", async () => {
    ctx.config.features.holdTaskForBackgroundWork = false;
    const { server } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), result("build started"), bgChanged(), result("never read")] }]);

    const { summary } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "completed"]);
    expect(responses(summary)).toHaveLength(1);
  });

  // ── Closing the SDK input stream ───────────────────────────────────────
  //
  // Three sites decide when the stream closes. The success and error `break`s close it first, the rate-limit `break` leans on
  // the `finally`. Asserting `inputClosed === true` alone cannot tell them apart, so the first two run against
  // `returnAwaitsInputClosed`, a transport that wedges on `break` unless the stream was already closed, and the third runs
  // without it so that only the `finally` can satisfy it.

  it("closes the input stream before breaking on the success path", async () => {
    const { server, client } = serve(ctx.config, [{ messages: [init("s1"), result("done")], returnAwaitsInputClosed: true }]);

    const { summary } = await settleWithin(streamText(server), 1000, "the stream");

    expect(states(summary)).toEqual(["submitted", "working", "completed"]);
    expect(client.calls[0].inputClosed).toBe(true);
    expect(client.calls[0].promptText).toBe("do the thing");
  });

  it("closes the input stream before breaking when a result errors", async () => {
    const { server, client } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), errorResult("error_max_turns")], returnAwaitsInputClosed: true }]);

    const { summary } = await settleWithin(streamText(server), 1000, "the stream");

    expect(states(summary)).toEqual(["submitted", "working", "failed"]);
    expect(client.calls[0].inputClosed).toBe(true);
  });

  it("leaves the rate-limit break's input stream to the finally", async () => {
    const { server, client } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), rejected()], hangAfter: true }]);

    const { summary } = await streamText(server);
    await sleep(10);

    expect(states(summary)).toEqual(["submitted", "working", "failed"]);
    expect(client.calls[0].inputClosed).toBe(true);
  });

  it("releases the input stream of a held task whose CLI never wakes", async () => {
    // `hangUntilInputClosed` models a real subprocess: it outlives its scripted output and only exits once stdin closes. The
    // task is held open (bg1 never clears) and never gets another message, so the prompt timeout is the only way out, and the
    // input stream must still be closed on the way, or the subprocess would be wedged for good.
    ctx.config.timeouts.prompt = 50;
    const { server, client } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), result("waiting")], hangUntilInputClosed: true }]);

    const { summary } = await streamText(server);
    await sleep(10);

    expect(states(summary)).toEqual(["submitted", "working", "working", "failed"]);
    expect(client.calls[0].inputClosed).toBe(true);
  });

  it("publishes no second terminal event when a cancel ends the iterator cleanly", async () => {
    // `endCleanlyOnAbort` models the race where the subprocess closes its stream just as the abort lands: the iterator ends
    // normally, so none of the turn's abort handling runs and the post-loop code is what has to notice. The task is held (bg1
    // never clears), so nothing terminal was published in the loop: exactly the state where a naive fallback would emit
    // `completed` on top of the cancel's `canceled`.
    const { server } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), result("waiting")], hangAfter: true, endCleanlyOnAbort: true }]);

    const live = server.startStream({ text: "go", contextId: "ctx-1" });
    await sleep(40);
    const taskId = (live.events[0] as { payload: { value: { id: string } } }).payload.value.id;
    await server.cancel(taskId);
    const { events } = await live.done;

    expect(states(events.map(summarizeEvent))).toEqual(["submitted", "working", "working", "canceled"]);
  });

  it("reports a timeout when the timer's abort ends the iterator cleanly", async () => {
    // The same clean-end race, reached via the prompt timer. The catch's timeout branch never runs, so the post-loop block is
    // the only thing between this and a Task that either claims it `completed` or never terminates at all.
    ctx.config.timeouts.prompt = 50;
    const { server } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), result("waiting")], hangAfter: true, endCleanlyOnAbort: true }]);

    const { summary } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "working", "failed"]);
  });

  it("falls back to completing when the iterator ends while still held", async () => {
    const { server } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), result("still waiting")] }]);

    const { summary } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "working", "completed"]);
  });

  it("emits the agent_finished bookend when the iterator ends while still held", async () => {
    // The last round's result was consumed with `{ held: true }`, which suppressed the bookend, and this path never sees
    // another result. If the fallback does not close it, the Task publishes `completed` while the trace stream shows
    // `agent_started` with nothing pairing it.
    ctx.config.events = { enabled: true } as typeof ctx.config.events;
    const captured: AgentEvent[] = [];
    const { server } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), result("still waiting")] }], {
      eventTransport: async (e: AgentEvent) => {
        captured.push(e);
      },
    });

    const { summary } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "working", "completed"]);
    expect(captured.filter((e) => e.eventType === "agent_started")).toHaveLength(1);
    const finishedEvents = captured.filter((e) => e.eventType === "agent_finished");
    expect(finishedEvents).toHaveLength(1);
    expect(finishedEvents[0].data).toMatchObject({ totalCostUsd: 0.01, numTurns: 1 });
  });

  it("emits the agent_finished bookend exactly once on the ordinary path", async () => {
    ctx.config.events = { enabled: true } as typeof ctx.config.events;
    const captured: AgentEvent[] = [];
    const { server } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), result("round 1"), bgChanged(), result("round 2")] }], {
      eventTransport: async (e: AgentEvent) => {
        captured.push(e);
      },
    });

    await streamText(server);

    expect(captured.filter((e) => e.eventType === "agent_finished")).toHaveLength(1);
  });

  it("publishes no second terminal event when the teardown throws after completing", async () => {
    // `break` awaits iterator.return(); a throw there lands in the catch after `completed` was already published. Without the
    // `ended` guard the client gets a contradictory `failed` on top of it.
    const { server } = serve(ctx.config, [
      { messages: [init("s1"), bgChanged("bg1"), result("round 1"), bgChanged(), result("round 2")], throwOnReturn: "transport closed unexpectedly" },
    ]);

    const { summary } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "working", "completed"]);
  });

  it("publishes no artifact for a success result with empty text", async () => {
    // An empty `response` artifact is noise on the wire, and a client that renders every artifact shows a blank message for it.
    const { server } = serve(ctx.config, [{ messages: [init("s1"), result("")] }]);

    const { summary } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "completed"]);
    expect(responses(summary)).toHaveLength(0);
  });

  it("gives each round its own streaming artifact id and lastChunk marker", async () => {
    ctx.config.features.streamArtifactChunks = true;
    const delta = (text: string): SDKMessageLike => ({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });
    const { server } = serve(ctx.config, [
      { messages: [init("s1"), bgChanged("bg1"), delta("build "), delta("started"), result("build started"), bgChanged(), delta("build passed"), result("build passed")] },
    ]);

    const { events } = await streamText(server);

    const ids = events
      .filter((e: any) => e.payload?.$case === "artifactUpdate")
      .map((e: any) => ({ id: e.payload.value.artifact.artifactId as string, last: !!e.payload.value.lastChunk, name: e.payload.value.artifact.name }))
      .filter((a) => a.name === "response");
    const taskId = (events[0] as any).payload.value.id as string;
    expect(ids.map((a) => a.id)).toEqual([
      `response-${taskId}-1`, `response-${taskId}-1`, `response-${taskId}-1`, // 2 chunks + marker
      `response-${taskId}-2`, `response-${taskId}-2`, // 1 chunk + marker
    ]);
    const markers = events.filter((e: any) => e.payload?.$case === "artifactUpdate" && e.payload.value.lastChunk === true && e.payload.value.artifact.name === "response");
    expect(markers).toHaveLength(2);
    expect(JSON.stringify(markers[0])).toContain("build started");
    expect(JSON.stringify(markers[1])).toContain("build passed");
    expect(artifacts(events.map(summarizeEvent)).filter((a) => a.name === "response")).toHaveLength(5);
  });

  it("reports the cost of the task once, not once per result (total_cost_usd is a running total)", async () => {
    const cum = (text: string, total: number): SDKMessageLike => ({ ...result(text), total_cost_usd: total, session_id: "s1" });
    const { server } = serve(ctx.config, [{ messages: [init("s1"), bgChanged("bg1"), cum("one", 0.01), bgChanged(), cum("two", 0.025)] }]);

    const { summary } = await streamText(server);

    const done = summary.find((e) => e.k === "status" && e.state === "completed") as { usage?: { cost: number; calls: Array<{ cost: number }>; inputTokens: number } };
    expect(done.usage?.calls.map((c) => c.cost)).toEqual([0.01, 0.015]);
    expect(done.usage?.cost).toBeCloseTo(0.025, 9);
    expect(done.usage?.inputTokens).toBe(2);
  });
});
