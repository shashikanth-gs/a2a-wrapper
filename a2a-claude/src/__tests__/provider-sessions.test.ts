/**
 * Context binding: the Claude session id bound to the contextId (`run.bind`) and resumed from `request.session` (`resume`),
 * also after a restart; a session the CLI no longer has starts a fresh one; `session.ttl` is a hard maximum age;
 * and the usage total kept with the binding makes `x-usage` cost the cost of the turn.
 */

import { describe, expect, it } from "vitest";
import { InMemoryRunStore } from "@a2a-wrapper/core";
import { ClaudeProvider } from "../claude/provider.js";
import { interactionPolicyOf, registryOptionsOf } from "../server/index.js";
import { FakeClaudeClient, happyTurn } from "./helpers/fake-client.js";
import { init, result, text } from "./helpers/manual-client.js";
import { serve, serveManual, sleep, states, streamText, until, useWorkspace } from "./helpers/harness.js";

const ctx = useWorkspace();

const noConversation = (sid: string) => ({
  messages: [{ type: "result", subtype: "error_during_execution", errors: [`No conversation found with session ID: ${sid}`], num_turns: 0, usage: {}, total_cost_usd: 0 }] as never,
});

describe("bind and resume", () => {
  it("binds the session id of the init message to the contextId, stamped with the provider's identity", async () => {
    const store = new InMemoryRunStore();
    const { server } = serve(ctx.config, [happyTurn("sess-1", "one")], { runStore: store });

    await streamText(server, "hi", "ctx-a");
    await server.registry.drain();

    const b = await store.getBinding("ctx-a");
    expect(b?.session).toMatchObject({ ref: "sess-1", issuer: "claude@1" });
    expect(await store.getBinding("ctx-b")).toBeUndefined();
  });

  it("binds as soon as the CLI reports the session, before any output", async () => {
    const store = new InMemoryRunStore();
    const h = serveManual(ctx.config, { runStore: store });
    const live = h.server.startStream({ text: "hi", contextId: "ctx-a" });
    await until(() => h.client.queries.length === 1);

    h.client.queries[0].emit(init("sess-early")); // nothing else yet: no assistant text, no result
    await sleep(30);

    expect((await store.getBinding("ctx-a"))?.session.ref).toBe("sess-early");
    h.client.queries[0].emit(text("x"), result("x"));
    await live.done;
  });

  it("a restart keeps the conversation with a persistent store: the new process resumes the bound session", async () => {
    const store = new InMemoryRunStore();
    const first = serve(ctx.config, [happyTurn("sess-r", "one")], { runStore: store });
    await streamText(first.server, "remember 7", "ctx-r");
    await first.server.registry.drain();
    await first.provider.shutdown();

    // "restart": a new provider, runtime and request handler over the same store
    const second = serve(ctx.config, [happyTurn("sess-r", "seven")], { runStore: store });
    const { summary } = await streamText(second.server, "what was it?", "ctx-r");

    expect(states(summary)).toContain("completed");
    expect(second.client.calls[0].options.resume).toBe("sess-r");
  });

  it("with the default in-memory store a restart starts the context afresh (the transcripts stay on disk)", async () => {
    const first = serve(ctx.config, [happyTurn("sess-r", "one")]);
    await streamText(first.server, "remember 7", "ctx-r");

    const second = serve(ctx.config, [happyTurn("sess-r2", "none")]);
    await streamText(second.server, "what was it?", "ctx-r");

    expect(second.client.calls[0].options.resume).toBeUndefined();
  });

  it("session.reuseByContext false binds nothing and never resumes", async () => {
    ctx.config.session.reuseByContext = false;
    const store = new InMemoryRunStore();
    const { server, client } = serve(ctx.config, [happyTurn("s1", "one"), happyTurn("s2", "two")], { runStore: store });

    await streamText(server, "a", "ctx-n");
    await streamText(server, "b", "ctx-n");
    await server.registry.drain();

    expect(await store.getBinding("ctx-n")).toBeUndefined();
    expect(client.calls.map((c) => c.options.resume)).toEqual([undefined, undefined]);
  });
});

describe("a session the CLI does not have", () => {
  it("a resume answered with `No conversation found` starts a fresh session once, with nothing published by the failed attempt", async () => {
    ctx.config.events = { enabled: true } as typeof ctx.config.events;
    const captured: unknown[] = [];
    const store = new InMemoryRunStore();
    const { server, client } = serve(ctx.config, [happyTurn("old", "one"), noConversation("old"), happyTurn("new", "fresh")], {
      runStore: store,
      eventTransport: async (e) => {
        captured.push(e);
      },
    });
    await streamText(server, "first", "ctx-g");
    await server.registry.drain();
    captured.length = 0;

    const { summary } = await streamText(server, "second", "ctx-g");
    await server.registry.drain();

    expect(client.calls.map((c) => c.options.resume)).toEqual([undefined, "old", undefined]);
    // progress is not output, so the retry publishes its "Processing request..." again
    expect(states(summary)).toEqual(["submitted", "working", "working", "completed"]);
    expect(JSON.stringify(summary)).toContain("fresh");
    expect((await store.getBinding("ctx-g"))?.session.ref).toBe("new");
    // the failed attempt published no lifecycle events: only the fresh attempt's bookends (agent_started, agent_finished)
    expect(captured.map((e: any) => e.eventType)).toEqual(["agent_started", "agent_finished"]);
  });

  it("a CLI that throws the same error instead of returning an error result is handled the same", async () => {
    const { server, client } = serve(ctx.config, [
      happyTurn("old", "one"),
      { messages: [], throwAfter: "Claude Code returned an error result: No conversation found with session ID: old" },
      happyTurn("new", "fresh"),
    ]);
    await streamText(server, "first", "ctx-g");

    const { summary } = await streamText(server, "second", "ctx-g");

    expect(states(summary)).toContain("completed");
    expect(client.calls.map((c) => c.options.resume)).toEqual([undefined, "old", undefined]);
  });

  it("any other failure of a resumed turn is an ordinary failure, not a lost session", async () => {
    const { server, client } = serve(ctx.config, [
      happyTurn("old", "one"),
      { messages: [{ type: "result", subtype: "error_during_execution", errors: ["boom"], num_turns: 0 }] as never },
    ]);
    await streamText(server, "first", "ctx-g");

    const { summary } = await streamText(server, "second", "ctx-g");

    expect(states(summary)).toContain("failed");
    expect(client.calls).toHaveLength(2);
  });
});

describe("session lifetime", () => {
  it("session.ttl is the maximum age of a context's session: bindingMaxAgeMs; unset or 0 means none", () => {
    expect(registryOptionsOf(ctx.config)).toEqual({ interactionPolicy: {} });
    ctx.config.session.ttl = 3_600_000;
    expect(registryOptionsOf(ctx.config)).toMatchObject({ bindingMaxAgeMs: 3_600_000 });
    ctx.config.session.ttl = 0;
    expect(registryOptionsOf(ctx.config).bindingMaxAgeMs).toBeUndefined();
    ctx.config.session.ttl = -5;
    expect(registryOptionsOf(ctx.config).bindingMaxAgeMs).toBeUndefined();
  });

  it("session.idleTtl is the optional idle expiry: bindingTtlMs", () => {
    ctx.config.session.idleTtl = 60_000;
    expect(registryOptionsOf(ctx.config)).toMatchObject({ bindingTtlMs: 60_000 });
    ctx.config.session.idleTtl = 0;
    expect(registryOptionsOf(ctx.config).bindingTtlMs).toBeUndefined();
  });

  it("the interaction config maps to core's policy", () => {
    ctx.config.interactions = { mode: "ask", timeoutMs: 9 };
    expect(registryOptionsOf(ctx.config).interactionPolicy).toEqual(interactionPolicyOf(ctx.config));
    expect(registryOptionsOf(ctx.config).interactionPolicy).toEqual({ mode: "ask", timeoutMs: 9 });
  });

  it("a session older than ttl is not resumed, however recently the context was used", async () => {
    ctx.config.session.ttl = 150;
    const { server, client } = serve(ctx.config, [happyTurn("s1", "one"), happyTurn("s1", "two"), happyTurn("s2", "three")]);

    await streamText(server, "a", "ctx-t");
    await sleep(80);
    await streamText(server, "b", "ctx-t"); // 80 ms old: resumed (and used again)
    await sleep(100);
    await streamText(server, "c", "ctx-t"); // 180 ms old, used 100 ms ago: over its maximum age, so fresh

    expect(client.calls.map((c) => c.options.resume)).toEqual([undefined, "s1", undefined]);
  });

  it("with no ttl a context resumes its session indefinitely", async () => {
    const { server, client } = serve(ctx.config, [happyTurn("s1", "one"), happyTurn("s1", "two")]);
    await streamText(server, "a", "ctx-t");
    await sleep(60);
    await streamText(server, "b", "ctx-t");
    expect(client.calls[1].options.resume).toBe("s1");
  });

  it("idleTtl expires a context that was not used for that long, but not one that keeps being used", async () => {
    ctx.config.session.idleTtl = 100;
    const { server, client } = serve(ctx.config, [happyTurn("s1", "one"), happyTurn("s1", "two"), happyTurn("s1", "three"), happyTurn("s2", "four")]);

    await streamText(server, "a", "ctx-i");
    await sleep(60);
    await streamText(server, "b", "ctx-i");
    await sleep(60);
    await streamText(server, "c", "ctx-i"); // 120 ms after the first, 60 after the last use: still resumed
    await sleep(160);
    await streamText(server, "d", "ctx-i"); // idle for 160 ms: fresh

    expect(client.calls.map((c) => c.options.resume)).toEqual([undefined, "s1", "s1", undefined]);
  });
});

describe("a new session over an old one", () => {
  it("a different session id reported by a resumed turn is bound (and starts a new age)", async () => {
    const store = new InMemoryRunStore();
    const { server } = serve(ctx.config, [happyTurn("a", "one"), happyTurn("b", "two")], { runStore: store });
    await streamText(server, "1", "ctx-x");
    await server.registry.drain();
    const first = await store.getBinding("ctx-x");

    await sleep(5);
    await streamText(server, "2", "ctx-x");
    await server.registry.drain();
    const second = await store.getBinding("ctx-x");

    expect(second?.session.ref).toBe("b");
    expect(Date.parse(second!.createdAt)).toBeGreaterThan(Date.parse(first!.createdAt));
  });
});

describe("probeSession and abortOrphan", () => {
  it("probes the CLI's transcript: alive when it exists, unknown otherwise (never gone on a missing summary)", async () => {
    const client = new FakeClaudeClient([happyTurn("s", "x")]);
    client.sessionExists = async (id) => id === "known";
    const provider = new ClaudeProvider(ctx.config, { clientFactory: () => client });
    await provider.initialize();

    expect(await provider.probeSession({ ref: "known" })).toBe("alive");
    expect(await provider.probeSession({ ref: "other" })).toBe("unknown");
    client.sessionExists = async () => {
      throw new Error("io");
    };
    expect(await provider.probeSession({ ref: "known" })).toBe("unknown");
  });

  it("probes unknown when the client cannot tell", async () => {
    const provider = new ClaudeProvider(ctx.config, { clientFactory: () => new FakeClaudeClient([happyTurn("s", "x")]) });
    await provider.initialize();
    expect(await provider.probeSession({ ref: "x" })).toBe("unknown");
  });

  it("abortOrphan has nothing to stop: a process this provider spawned died with it", async () => {
    const provider = new ClaudeProvider(ctx.config, { clientFactory: () => new FakeClaudeClient([happyTurn("s", "x")]) });
    expect(await provider.abortOrphan({ runId: "r", turnId: "t", taskId: "t", contextId: "c", reason: "cancel" })).toEqual({ stopped: "confirmed", session: "reusable" });
  });
});

describe("usage: x-usage cost is the cost of the turn, from the running total of the session", () => {
  const turn = (sid: string, total: number, input = 10) => ({
    messages: [init(sid), text("t"), result("t", { total_cost_usd: total, usage: { input_tokens: input, output_tokens: 1 }, session_id: sid, modelUsage: { m1: { inputTokens: input, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: total } } })] as never,
  });
  const cost = (summary: any[]) => (summary.find((e) => e.k === "status" && e.state === "completed") as any).usage.cost as number;
  const tokens = (summary: any[]) => (summary.find((e) => e.k === "status" && e.state === "completed") as any).usage.inputTokens as number;

  it("the first turn of a session costs its total; the next costs the difference, not the whole total again", async () => {
    const { server } = serve(ctx.config, [turn("s", 0.0075), turn("s", 0.0089), turn("s", 0.0093)]);

    const a = await streamText(server, "1", "ctx-u");
    const b = await streamText(server, "2", "ctx-u");
    const c = await streamText(server, "3", "ctx-u");

    expect(cost(a.summary)).toBeCloseTo(0.0075, 9);
    expect(cost(b.summary)).toBeCloseTo(0.0014, 9);
    expect(cost(c.summary)).toBeCloseTo(0.0004, 9);
    expect(tokens(b.summary)).toBe(10); // tokens are the turn's own, as they always were
  });

  it("the difference survives a restart (the previous total is kept with the binding)", async () => {
    const store = new InMemoryRunStore();
    const first = serve(ctx.config, [turn("s", 0.0075)], { runStore: store });
    await streamText(first.server, "1", "ctx-u");
    await first.server.registry.drain();

    const second = serve(ctx.config, [turn("s", 0.0089)], { runStore: store });
    const b = await streamText(second.server, "2", "ctx-u");

    expect(cost(b.summary)).toBeCloseTo(0.0014, 9);
    const binding = await store.getBinding("ctx-u");
    expect((binding?.session.meta as any).usageTotals.costUsd).toBeCloseTo(0.0089, 9);
  });

  it("a total that goes back down (the session was reset) is a new total, never a negative cost", async () => {
    const { server } = serve(ctx.config, [turn("s", 0.5), turn("s", 0.02)]);

    await streamText(server, "1", "ctx-u");
    const b = await streamText(server, "2", "ctx-u");

    expect(cost(b.summary)).toBeCloseTo(0.02, 9);
  });

  it("another session starts another total", async () => {
    const { server } = serve(ctx.config, [turn("s1", 0.5), turn("s2", 0.02)]);

    await streamText(server, "1", "ctx-1");
    const b = await streamText(server, "2", "ctx-2");

    expect(cost(b.summary)).toBeCloseTo(0.02, 9);
  });

  it("core's usage key carries the per-model breakdown of the turn (the difference of two modelUsage readings)", async () => {
    const store = new InMemoryRunStore();
    const { server } = serve(ctx.config, [turn("s", 0.0075, 10), turn("s", 0.0089, 4)], { runStore: store });
    await streamText(server, "1", "ctx-u");
    const live = await server.stream({ text: "2", contextId: "ctx-u" });
    const completed: any = live.events.map((e: any) => e.payload?.value).find((v: any) => v?.status?.state === 3 || v?.metadata?.["urn:a2a-wrapper:usage:v1"]);
    const core = completed.metadata["urn:a2a-wrapper:usage:v1"];
    expect(JSON.stringify(core)).toContain("m1");
    expect(JSON.stringify(core)).toContain("0.0014");
  });
});
