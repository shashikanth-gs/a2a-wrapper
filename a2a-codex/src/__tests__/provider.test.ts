/**
 * The Codex provider through the real request handler: cancel (by task id, #104), queueing and interrupting a running task (the
 * provider has no `steer`: core says so), per-turn artifacts, usage, failures, and the start-up validation.
 */

import { describe, expect, it } from "vitest";
import { summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { CodexProvider } from "../codex/provider.js";
import { codexUsageToCallRecord, failureCode } from "../codex/turn.js";
import { FakeCodex, T1, T2, answer, artifacts, responses, serve, sleep, started, states, streamText, taskIdOf, turn, until, useWorkspace } from "./helpers/harness.js";

const ctx = useWorkspace();

const terminals = (summary: ReturnType<typeof summarizeEvent>[]) =>
  states(summary).filter((s) => ["completed", "failed", "canceled", "rejected"].includes(s));

describe("cancel (by task id)", () => {
  it("cancels by taskId, aborts the turn's signal and publishes one canceled", async () => {
    const { server, client } = serve(ctx.config, ["manual"]);
    const live = server.startStream({ text: "go", contextId: "ctx-1" });
    await until(() => client.calls.length === 1);
    client.calls[0].live!.push(...started(T1));
    await until(() => live.events.length >= 2);
    const taskId = taskIdOf(live.events);

    const t0 = Date.now();
    const canceled = await server.cancel(taskId);
    const got = await live.done;

    expect(Date.now() - t0).toBeLessThan(1000);
    expect(summarizeTask(canceled).state).toBe("canceled");
    expect(client.calls[0].signal!.aborted).toBe(true);
    expect(terminals(got.events.map(summarizeEvent))).toEqual(["canceled"]);
  });

  it("is idempotent and a no-op for unknown tasks", async () => {
    const { server, client } = serve(ctx.config, ["manual"]);
    await expect(server.cancel("nope")).rejects.toBeDefined(); // the SDK: task not found

    const live = server.startStream({ text: "go", contextId: "ctx-2" });
    await until(() => client.calls.length === 1);
    await until(() => live.events.length >= 1);
    const taskId = taskIdOf(live.events);
    await server.cancel(taskId);
    await server.cancel(taskId).catch(() => {}); // already canceled
    const got = await live.done;
    expect(terminals(got.events.map(summarizeEvent))).toEqual(["canceled"]);
  });

  it("cancels a turn that is still queued behind another one of the context without starting it", async () => {
    const { server, client } = serve(ctx.config, ["manual", turn(T2, "never")]);
    const a = server.startStream({ text: "a", contextId: "ctx-q" });
    await until(() => client.calls.length === 1);
    const b = server.startStream({ text: "b", contextId: "ctx-q" }); // same context: waits in core's lane
    await until(() => b.events.length >= 1);
    await sleep(30);
    expect(client.calls).toHaveLength(1);

    await server.cancel(taskIdOf(b.events));
    await server.cancel(taskIdOf(a.events));
    const [ra, rb] = await Promise.all([a.done, b.done]);

    expect(client.calls).toHaveLength(1); // b never started
    expect(terminals(rb.events.map(summarizeEvent))).toEqual(["canceled"]);
    expect(terminals(ra.events.map(summarizeEvent))).toEqual(["canceled"]);
  });

  it("keeps the thread usable for the next message of the context: it is resumed", async () => {
    const { server, client } = serve(ctx.config, ["manual", turn(T1, "after")]);
    const first = server.startStream({ text: "a", contextId: "ctx-u" });
    await until(() => client.calls.length === 1);
    client.calls[0].live!.push(...started(T1));
    await sleep(30);
    await server.cancel(taskIdOf(first.events));
    await first.done;

    const { summary } = await streamText(server, "b", "ctx-u");

    expect(states(summary)).toContain("completed");
    expect(client.opened.map((o) => [o.how, o.id])).toEqual([["start", undefined], ["resume", T1]]);
  });

  it("closes the lifecycle of a canceled turn with one agent_error", async () => {
    ctx.config.events = { enabled: true } as typeof ctx.config.events;
    const captured: any[] = [];
    const { server, client } = serve(ctx.config, ["manual"], { eventTransport: async (e) => void captured.push(e) });
    const live = server.startStream({ text: "go", contextId: "ctx-l" });
    await until(() => client.calls.length === 1);
    client.calls[0].live!.push(...started(T1));
    await until(() => captured.length >= 1);
    await server.cancel(taskIdOf(live.events));
    await live.done;
    await server.registry.drain();
    expect(captured.map((e) => e.eventType)).toEqual(["agent_started", "agent_error"]);
  });

  it("abort() confirms once the turn's stream has ended, and says the thread is reusable", async () => {
    const { server, client, provider } = serve(ctx.config, ["manual"]);
    const live = server.startStream({ text: "go", contextId: "ctx-a" });
    await until(() => client.calls.length === 1);
    const taskId = taskIdOf(live.events);
    // a direct abort (what core does after it aborted the signal) kills the CLI process of the turn
    const out = await provider.abort({ runId: "r", turnId: "t", taskId, contextId: "ctx-a" }, "cancel");
    expect(out).toEqual({ stopped: "confirmed", session: "reusable" });
    expect(client.calls[0].signal).toBeDefined();
    await server.cancel(taskId).catch(() => {});
    await live.done;
  });

  it("abort() of a task with no live turn is confirmed (nothing was started)", async () => {
    const { provider } = serve(ctx.config, []);
    expect(await provider.abort({ runId: "r", turnId: "t", taskId: "none", contextId: "c" }, "interrupt")).toEqual({
      stopped: "confirmed",
      session: "reusable",
    });
  });
});

describe("a message for a running task: queue and interrupt (no native steer)", () => {
  it("the provider offers no steer handler", () => {
    const { provider } = serve(ctx.config, []);
    expect((provider as any).steer).toBeUndefined();
  });

  it("steer falls back honestly: queued by core with `steer-unsupported`, and runs as the next turn on the same thread", async () => {
    const { server, client } = serve(ctx.config, ["manual", turn(T1, "second answer")]);
    const live = server.startStream({ text: "first", contextId: "ctx-s" });
    await until(() => client.calls.length === 1);
    client.calls[0].live!.push(...started(T1));
    await until(() => live.events.length >= 2);
    const taskId = taskIdOf(live.events);

    const ack = await server.send({ text: "also this", contextId: "ctx-s", taskId, delivery: "steer" });
    expect(JSON.stringify(ack)).toMatch(/steer-unsupported/);
    expect(client.calls).toHaveLength(1); // nothing was sent to the running CLI

    client.calls[0].live!.push(...answer("first answer"));
    client.calls[0].live!.end();
    const got = await live.done;
    const summary = got.events.map(summarizeEvent);

    expect(terminals(summary)).toEqual(["completed"]);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1].input).toBe("also this");
    expect(client.opened.map((o) => [o.how, o.id])).toEqual([["start", undefined], ["resume", T1]]);
    // two turns of one task, two response artifacts with different ids (the second must not replace the first)
    expect(responses(summary).map((r) => r.parts[0].text)).toEqual(["first answer", "second answer"]);
  });

  it("queue: the message waits and runs as the next turn", async () => {
    const { server, client } = serve(ctx.config, ["manual", turn(T1, "later answer")]);
    const live = server.startStream({ text: "first", contextId: "ctx-qq" });
    await until(() => client.calls.length === 1);
    client.calls[0].live!.push(...started(T1));
    await until(() => live.events.length >= 2);
    const taskId = taskIdOf(live.events);

    const ack = await server.send({ text: "next", contextId: "ctx-qq", taskId, delivery: "queue" });
    expect(JSON.stringify(ack)).toMatch(/queued/i);
    client.calls[0].live!.push(...answer("first answer"));
    client.calls[0].live!.end();
    const got = await live.done;
    expect(client.calls.map((c) => c.input)).toEqual(["first", "next"]);
    expect(terminals(got.events.map(summarizeEvent))).toEqual(["completed"]);
  });

  it("interrupt: the running turn is aborted (the CLI is killed) and the message runs next on the same thread", async () => {
    const { server, client } = serve(ctx.config, ["manual", turn(T1, "after interrupt")]);
    const live = server.startStream({ text: "long job", contextId: "ctx-i" });
    await until(() => client.calls.length === 1);
    client.calls[0].live!.push(...started(T1));
    await until(() => live.events.length >= 2);
    await sleep(30);
    const taskId = taskIdOf(live.events);

    await server.send({ text: "stop, do this instead", contextId: "ctx-i", taskId, delivery: "interrupt" });
    const got = await live.done;
    const summary = got.events.map(summarizeEvent);

    expect(client.calls[0].signal!.aborted).toBe(true);
    expect(client.calls.map((c) => c.input)).toEqual(["long job", "stop, do this instead"]);
    expect(client.opened.map((o) => [o.how, o.id])).toEqual([["start", undefined], ["resume", T1]]);
    expect(terminals(summary)).toEqual(["completed"]);
    expect(responses(summary).map((r) => r.parts[0].text)).toEqual(["after interrupt"]);
  });
});

describe("artifacts, usage and failures", () => {
  it("each turn of a task has its own response artifact id (turnArtifactId)", async () => {
    const { server } = serve(ctx.config, [turn(T1, "one")]);
    const task: any = await server.send({ text: "a", contextId: "ctx-id" });
    expect(task.artifacts.find((a: any) => a.name === "response").artifactId).toBe(`response-${task.id}-1`);
  });

  it("streamed chunks: appended pieces and a last chunk with the full text", async () => {
    ctx.config.features.streamArtifactChunks = true;
    const { server } = serve(ctx.config, [
      {
        events: [
          ...started(T1),
          { type: "item.updated", item: { id: "m", type: "agent_message", text: "Hel" } },
          { type: "item.updated", item: { id: "m", type: "agent_message", text: "Hello" } },
          ...answer("Hello"),
        ],
      },
    ]);
    const { summary } = await streamText(server);
    expect(responses(summary).map((r) => [r.append, r.lastChunk, r.parts[0].text])).toEqual([
      [true, false, "Hel"],
      [true, false, "lo"],
      [true, true, "Hello"],
    ]);
  });

  it("completed carries x-usage built from turn.completed.usage (per turn, not cumulative)", async () => {
    const { server } = serve(ctx.config, [turn(T1, "one"), { events: [...started(T1), ...answer("two")] }]);
    const a = await streamText(server, "a", "ctx-u");
    const b = await streamText(server, "b", "ctx-u");
    for (const { summary } of [a, b]) {
      const done = summary.find((e) => e.k === "status" && e.state === "completed") as any;
      expect(done.usage).toMatchObject({ llmCalls: 1, inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, reasoningTokens: 1 });
    }
  });

  it("maps the Codex usage figures to a call record, including cache writes when the SDK reports them", () => {
    expect(
      codexUsageToCallRecord({ input_tokens: 5, output_tokens: 2, cached_input_tokens: 1, cache_write_input_tokens: 3, reasoning_output_tokens: 4 }, "m"),
    ).toMatchObject({ model: "m", inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 3, reasoningTokens: 4, cost: null });
  });

  it("failure codes: auth, rate limit, unavailable, backend", () => {
    expect(failureCode("Codex Exec exited with code 1: You are not logged in")).toBe("auth");
    expect(failureCode("You've hit your usage limit")).toBe("rate_limit");
    expect(failureCode("spawn codex ENOENT")).toBe("unavailable");
    expect(failureCode("something else")).toBe("backend");
  });

  it("a turn.failed event fails the task with the turn's error and one agent_error", async () => {
    ctx.config.events = { enabled: true } as typeof ctx.config.events;
    const captured: any[] = [];
    const { server } = serve(ctx.config, [{ events: [...started(T1), { type: "turn.failed", error: { message: "model overloaded" } }] }], {
      eventTransport: async (e) => void captured.push(e),
    });
    const task = summarizeTask(await server.send({ text: "x", contextId: "ctx-f" }));
    await server.registry.drain();
    expect(task).toMatchObject({ state: "failed", text: "model overloaded" });
    expect(captured.map((e) => e.eventType)).toEqual(["agent_started", "agent_error"]);
  });

  it("a thrown failure is sanitized, closes the lifecycle once and keeps the binding made before it", async () => {
    ctx.config.events = { enabled: true } as typeof ctx.config.events;
    const captured: any[] = [];
    const { server } = serve(ctx.config, [{ events: [...started(T1)], throwAfter: "Codex Exec exited with code 1: token=abc123" }], {
      eventTransport: async (e) => void captured.push(e),
    });
    const task = summarizeTask(await server.send({ text: "x", contextId: "ctx-f" }));
    await server.registry.drain();
    expect(task.state).toBe("failed");
    expect(task.text).toBe("Codex Exec exited with code 1: token=<redacted>");
    expect(captured.map((e) => e.eventType)).toEqual(["agent_started", "agent_error"]);
    expect((await server.runStore.getBinding("ctx-f"))?.session.ref).toBe(T1);
  });

  it("the agent card of the provider says what it takes and gives", () => {
    const { provider } = serve(ctx.config, []);
    expect(provider.info()).toMatchObject({ id: "codex", sessionFormat: "1", inputModes: ["text/plain"], outputModes: ["text/plain"] });
  });
});

describe("start-up", () => {
  it("rejects a missing or non-existent workspace, on-request approvals and an invalid sandbox", async () => {
    const mk = (mut: (c: typeof ctx.config) => void) => {
      const c = JSON.parse(JSON.stringify(ctx.config));
      mut(c);
      return new CodexProvider(c, { clientFactory: () => new FakeCodex([]) }).initialize();
    };
    await expect(mk((c) => (c.codex.workingDirectory = ""))).rejects.toThrow(/workingDirectory is required/);
    await expect(mk((c) => (c.codex.workingDirectory = "/no/such/dir-a2a"))).rejects.toThrow(/does not exist/);
    await expect(mk((c) => (c.codex.approvalPolicy = "on-request"))).rejects.toThrow(/on-request/);
    await expect(mk((c) => (c.codex.sandboxMode = "nope" as never))).rejects.toThrow(/Invalid sandboxMode/);
  });

  it("a start-up failure at the first request fails the task with the same text", async () => {
    ctx.config.codex.workingDirectory = "";
    const { server } = serve(ctx.config, []);
    const task = summarizeTask(await server.send({ text: "x", contextId: "ctx-e" }));
    expect(task.state).toBe("failed");
    expect(task.text).toMatch(/workingDirectory is required/);
  });

  it("shutdown stops a running turn's CLI process", async () => {
    const { server, client, provider } = serve(ctx.config, ["manual"]);
    const live = server.startStream({ text: "go", contextId: "ctx-sd" });
    await until(() => client.calls.length === 1);
    await provider.shutdown();
    expect(client.calls[0].signal!.aborted).toBe(true);
    await server.cancel(taskIdOf(live.events)).catch(() => {});
    await live.done;
  });
});

describe("trace artifacts", () => {
  it("keeps the thread events as trace artifacts (commands, file changes, reasoning, MCP)", async () => {
    ctx.config.events = { enabled: true, transport: "a2a" } as typeof ctx.config.events;
    const { server } = serve(ctx.config, [
      {
        events: [
          ...started(T1),
          { type: "item.completed", item: { id: "r", type: "reasoning", text: "hm" } },
          { type: "item.completed", item: { id: "f", type: "file_change", status: "completed", changes: [{ path: "a", kind: "add" }] } },
          ...answer("ok"),
        ],
      },
    ]);
    const { summary } = await streamText(server);
    const traces = artifacts(summary).map((a) => a.traceType).filter(Boolean);
    expect(traces).toEqual(["trace.lifecycle", "trace.thinking", "trace.decision", "trace.lifecycle"]);
  });
});
