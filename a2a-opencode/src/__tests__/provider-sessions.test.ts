/**
 * Context binding: the OpenCode session id bound to the contextId (`run.bind`) and resumed from `request.session`, also after a
 * restart; a session the server no longer has starts a fresh one; `session.ttl` is an idle expiry (as it always was) and
 * `session.maxAge` a hard maximum age; the system prompt goes into the first message of a session only; `probeSession` and
 * `release`.
 */

import { describe, expect, it } from "vitest";
import { InMemoryRunStore } from "@a2a-wrapper/core";
import { FakeBackend, reply, idle, text } from "./helpers/fake-backend.js";
import { registryOptionsOf } from "../server/index.js";
import { OpenCodeAuthError } from "../opencode/backend.js";
import { serve, sleep, states, streamText, useConfig } from "./helpers/harness.js";

const ctx = useConfig();

describe("bind and resume", () => {
  it("creates a titled session, binds it to the contextId with the provider's identity, and reuses it for the next message", async () => {
    const store = new InMemoryRunStore();
    ctx.config.opencode.model = "opencode/big-pickle";
    ctx.config.opencode.agent = "build";
    const { server, backend } = serve(ctx.config, { scripts: [reply("one"), reply("two")] }, { runStore: store });

    await streamText(server, "hi", "ctx-abcdefgh-1");
    await server.registry.drain();

    const b = await store.getBinding("ctx-abcdefgh-1");
    expect(b?.session).toMatchObject({ ref: "ses_1", issuer: "opencode@1", meta: { api: "v1", model: "opencode/big-pickle" } });
    expect(backend.sessions.get("ses_1")?.title).toBe("A2A Session - ctx-abcd");
    expect(backend.sessions.get("ses_1")?.opts).toMatchObject({ model: { providerID: "opencode", modelID: "big-pickle" }, agent: "build" });

    await streamText(server, "again", "ctx-abcdefgh-1");
    expect(backend.calls.filter((c) => c === "sessionCreate")).toHaveLength(1);
    expect(backend.prompts.map((p) => p.sessionId)).toEqual(["ses_1", "ses_1"]);
    expect(backend.calls).toContain("sessionGet:ses_1");
  });

  it("binds before the first output (a restart in the middle of a turn can resume)", async () => {
    const store = new InMemoryRunStore();
    const { server, backend } = serve(ctx.config, { scripts: [({ sessionId, emit }) => emit(text("x", sessionId))] }, { runStore: store });
    const live = server.startStream({ text: "hi", contextId: "ctx-a" });
    for (let i = 0; i < 200 && backend.prompts.length === 0; i++) await sleep(5);
    expect((await store.getBinding("ctx-a"))?.session.ref).toBe("ses_1");
    backend.emit(idle("ses_1"));
    await live.done;
  });

  it("a restart keeps the conversation with a persistent store: the new process resumes the bound session", async () => {
    const store = new InMemoryRunStore();
    const first = serve(ctx.config, { scripts: [reply("one")] }, { runStore: store });
    await streamText(first.server, "remember 7", "ctx-r");
    await first.server.registry.drain();
    await first.provider.shutdown();

    // "restart": a new provider, runtime and request handler over the same store, against the same OpenCode server
    const second = serve(ctx.config, { scripts: [reply("seven")], existingSessions: ["ses_1"] }, { runStore: store });
    const { summary } = await streamText(second.server, "what was it?", "ctx-r");

    expect(states(summary)).toContain("completed");
    expect(second.backend.calls).not.toContain("sessionCreate");
    expect(second.backend.prompts.map((p) => p.sessionId)).toEqual(["ses_1"]);
  });

  it("with the default in-memory store a restart starts the context afresh (the sessions stay on the server)", async () => {
    const first = serve(ctx.config, { scripts: [reply("one")] });
    await streamText(first.server, "remember 7", "ctx-r");
    const second = serve(ctx.config, { scripts: [reply("none")], existingSessions: ["ses_1"] });
    await streamText(second.server, "what was it?", "ctx-r");
    expect(second.backend.calls).toContain("sessionCreate");
  });

  it("session.reuseByContext false binds nothing and creates a session for every task", async () => {
    ctx.config.session.reuseByContext = false;
    const store = new InMemoryRunStore();
    const { server, backend } = serve(ctx.config, { scripts: [reply("one"), reply("two")] }, { runStore: store });

    await streamText(server, "a", "ctx-n");
    await streamText(server, "b", "ctx-n");
    await server.registry.drain();

    expect(await store.getBinding("ctx-n")).toBeUndefined();
    expect(backend.calls.filter((c) => c === "sessionCreate")).toHaveLength(2);
    expect(backend.prompts.map((p) => p.sessionId)).toEqual(["ses_1", "ses_2"]);
  });

  it("works the same against a 2.x server", async () => {
    const store = new InMemoryRunStore();
    const { server, backend } = serve(ctx.config, { kind: "v2", scripts: [reply("one"), reply("two")] }, { runStore: store });
    await streamText(server, "hi", "ctx-v2");
    await streamText(server, "again", "ctx-v2");
    expect((await store.getBinding("ctx-v2"))?.session).toMatchObject({ ref: "ses_1", meta: { api: "v2" } });
    expect(backend.calls.filter((c) => c === "sessionCreate")).toHaveLength(1);
  });
});

describe("a session the server does not have", () => {
  it("is reported session-not-found before anything is published: a fresh session runs the same turn, once", async () => {
    ctx.config.events = { enabled: true } as typeof ctx.config.events;
    const captured: unknown[] = [];
    const store = new InMemoryRunStore();
    const { server, backend } = serve(ctx.config, { scripts: [reply("one"), reply("fresh")] }, {
      runStore: store,
      eventTransport: async (e) => {
        captured.push(e);
      },
    });
    await streamText(server, "first", "ctx-g");
    await server.registry.drain();
    captured.length = 0;
    backend.sessions.delete("ses_1"); // deleted on the server behind our back

    const { summary } = await streamText(server, "second", "ctx-g");
    await server.registry.drain();

    expect(backend.prompts.map((p) => p.sessionId)).toEqual(["ses_1", "ses_2"]);
    // progress is not output, so the retry publishes its "Processing request..." again
    expect(states(summary)).toEqual(["submitted", "working", "working", "completed"]);
    expect(JSON.stringify(summary)).toContain("fresh");
    expect((await store.getBinding("ctx-g"))?.session.ref).toBe("ses_2");
    // the failed attempt published no lifecycle events: only the fresh attempt's bookends
    expect(captured.map((e: any) => e.eventType)).toEqual(["agent_started", "agent_finished"]);
  });

  it("another failure while opening the session is an ordinary failure and keeps the binding", async () => {
    const store = new InMemoryRunStore();
    const { server, backend } = serve(ctx.config, { scripts: [reply("one")] }, { runStore: store });
    await streamText(server, "first", "ctx-g");
    await server.registry.drain();
    backend.sessionGet = async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    };

    const { summary } = await streamText(server, "second", "ctx-g");
    expect(states(summary).at(-1)).toBe("failed");
    expect(JSON.stringify(summary)).toContain("Cannot reach OpenCode server");
    expect((await store.getBinding("ctx-g"))?.session.ref).toBe("ses_1");
  });

  it("a session that cannot be created fails the task with the lifecycle pair a collector expects", async () => {
    ctx.config.events = { enabled: true } as typeof ctx.config.events;
    const captured: any[] = [];
    const { server, backend } = serve(ctx.config, { scripts: [reply("x")] }, { eventTransport: async (e) => void captured.push(e) });
    backend.sessionCreate = async () => {
      throw new Error("boom");
    };
    const { summary } = await streamText(server);
    expect(states(summary).at(-1)).toBe("failed");
    expect(captured.map((e) => e.eventType)).toEqual(["agent_started", "agent_error"]);
  });
});

describe("session lifetime", () => {
  it("session.ttl is an idle expiry (bindingTtlMs), session.maxAge a hard maximum age, as the runtime options say", () => {
    ctx.config.session.ttl = 120_000;
    expect(registryOptionsOf(ctx.config)).toMatchObject({ bindingTtlMs: 120_000 });
    expect(registryOptionsOf(ctx.config)).not.toHaveProperty("bindingMaxAgeMs");
    ctx.config.session.maxAge = 900_000;
    expect(registryOptionsOf(ctx.config)).toMatchObject({ bindingTtlMs: 120_000, bindingMaxAgeMs: 900_000 });
    ctx.config.session.ttl = 0;
    expect(registryOptionsOf(ctx.config)).not.toHaveProperty("bindingTtlMs");
  });

  it("a context unused for longer than ttl starts a new session; a context in use keeps its own", async () => {
    ctx.config.session.ttl = 120;
    const { server, backend } = serve(ctx.config, { scripts: [reply("a"), reply("b"), reply("c")] }, { runStore: new InMemoryRunStore() });
    await streamText(server, "1", "ctx-t");
    await sleep(60);
    await streamText(server, "2", "ctx-t"); // 60 ms idle: renewed
    await sleep(60);
    await streamText(server, "3", "ctx-t"); // 60 ms idle again, though older than ttl in total: still the same session
    expect(backend.prompts.map((p) => p.sessionId)).toEqual(["ses_1", "ses_1", "ses_1"]);
    await sleep(200);
    await streamText(server, "4", "ctx-t");
    expect(backend.prompts.at(-1)?.sessionId).toBe("ses_2");
  });

  it("session.maxAge ends a session however often it is used", async () => {
    ctx.config.session.ttl = 0;
    ctx.config.session.maxAge = 120;
    const { server, backend } = serve(ctx.config, { scripts: [reply("a"), reply("b"), reply("c")] }, { runStore: new InMemoryRunStore() });
    await streamText(server, "1", "ctx-m");
    await sleep(70);
    await streamText(server, "2", "ctx-m");
    expect(backend.prompts.map((p) => p.sessionId)).toEqual(["ses_1", "ses_1"]);
    await sleep(80);
    await streamText(server, "3", "ctx-m");
    expect(backend.prompts.at(-1)?.sessionId).toBe("ses_2");
  });
});

describe("the system prompt", () => {
  it("goes into the first message of a session only, also across a restart", async () => {
    ctx.config.opencode.systemPrompt = "You are a pirate.";
    const store = new InMemoryRunStore();
    const first = serve(ctx.config, { scripts: [reply("a"), reply("b")] }, { runStore: store });
    await streamText(first.server, "one", "ctx-s");
    await streamText(first.server, "two", "ctx-s");
    expect(first.backend.prompts.map((p) => p.body.parts[0].text)).toEqual(["You are a pirate.\n\n---\nUser request:\none", "two"]);
    expect((await store.getBinding("ctx-s"))?.session.meta).toMatchObject({ systemPromptSent: true });

    await first.provider.shutdown();
    const second = serve(ctx.config, { scripts: [reply("c")], existingSessions: ["ses_1"] }, { runStore: store });
    await streamText(second.server, "three", "ctx-s");
    expect(second.backend.prompts.map((p) => p.body.parts[0].text)).toEqual(["three"]);
  });

  it("a session that never got it (the prompt was configured later) gets it with its next message, once", async () => {
    const store = new InMemoryRunStore();
    const first = serve(ctx.config, { scripts: [reply("a")] }, { runStore: store });
    await streamText(first.server, "one", "ctx-s");
    await first.provider.shutdown();

    ctx.config.opencode.systemPrompt = "Be brief.";
    const second = serve(ctx.config, { scripts: [reply("b"), reply("c")], existingSessions: ["ses_1"] }, { runStore: store });
    await streamText(second.server, "two", "ctx-s");
    await streamText(second.server, "three", "ctx-s");
    expect(second.backend.prompts.map((p) => p.body.parts[0].text)).toEqual(["Be brief.\n\n---\nUser request:\ntwo", "three"]);
  });

  it("replace mode prepends the production preamble", async () => {
    ctx.config.opencode.systemPrompt = "You are a pirate.";
    ctx.config.opencode.systemPromptMode = "replace";
    const { server, backend } = serve(ctx.config, { scripts: [reply("a")] });
    await streamText(server, "one");
    const sent = backend.prompts[0]!.body.parts[0].text as string;
    expect(sent).toContain("You are a deployed AI agent.");
    expect(sent).toContain("AGENT PERSONA AND INSTRUCTIONS:\nYou are a pirate.");
    expect(sent.endsWith("User request:\none")).toBe(true);
  });
});

describe("probeSession and release", () => {
  it("probeSession asks the server: alive for a session it has, gone for one it does not, unknown when it cannot say", async () => {
    const { provider, backend } = serve(ctx.config, { existingSessions: ["ses_9"] });
    expect(await provider.probeSession({ ref: "ses_9" })).toBe("alive");
    expect(await provider.probeSession({ ref: "ses_missing" })).toBe("gone");
    backend.sessionGet = async () => {
      throw new Error("fetch failed");
    };
    expect(await provider.probeSession({ ref: "ses_9" })).toBe("unknown");
  });

  it("release keeps the server session (the wrapper has never deleted them)", async () => {
    const { provider, backend } = serve(ctx.config, { existingSessions: ["ses_9"] });
    await provider.release({ ref: "ses_9" });
    expect(backend.sessions.has("ses_9")).toBe(true);
    expect(backend.calls.filter((c) => /delete|remove/i.test(c))).toEqual([]);
  });

  it("validateBindings drops the binding of a session the server lost (probeSession gone)", async () => {
    const store = new InMemoryRunStore();
    const first = serve(ctx.config, { scripts: [reply("one")] }, { runStore: store });
    await streamText(first.server, "hi", "ctx-p");
    await first.server.registry.drain();
    const second = serve(ctx.config, { existingSessions: [] }, { runStore: store });
    await second.provider.initialize();
    const report = await second.server.registry.validateBindings();
    expect(report.gone).toEqual(["ctx-p"]);
    expect(await store.getBinding("ctx-p")).toBeUndefined();
  });
});

describe("what the stream does when it never connects", () => {
  it("a lost event stream falls back to polling the transcript (features.enablePollingFallback)", async () => {
    ctx.config.timeouts.pollingInterval = 20;
    const backend = new FakeBackend({
      failSubscribe: true,
      scripts: [({ backend: b, sessionId }) => b.busy.add(sessionId)],
      messages: () => [{ info: { role: "assistant", id: "a1", time: { completed: 1 } }, parts: [{ type: "text", text: "from the transcript" }] }],
    });
    const { server } = serve(ctx.config, backend, { streamReconnect: { maxRetries: 2, initialDelay: 10 } });
    const got = await streamText(server, "go");
    expect(states(got.summary).at(-1)).toBe("completed");
    expect(JSON.stringify(got.summary)).toContain("from the transcript");
  }, 20_000);
});

describe("initialization", () => {
  it("a server that rejects the credentials fails the task with the authentication message, and the next task tries again", async () => {
    const backend = new FakeBackend({ scripts: [reply("hello")] });
    let healthy = false;
    backend.health = async () => {
      if (!healthy) throw new OpenCodeAuthError("http://127.0.0.1:4096", false);
      return { healthy: true as const, version: "2.3.2" };
    };
    const { server } = serve(ctx.config, backend);

    const first = await streamText(server, "one");
    expect(states(first.summary).at(-1)).toBe("failed");
    expect(JSON.stringify(first.summary)).toContain("requires authentication");

    healthy = true;
    const second = await streamText(server, "two");
    expect(states(second.summary).at(-1)).toBe("completed");
  });

  it("a health check that merely fails is logged and the provider goes on (the server may come up later)", async () => {
    const backend = new FakeBackend({ scripts: [reply("hello")] });
    backend.health = async () => {
      throw new Error("fetch failed");
    };
    const { server } = serve(ctx.config, backend);
    const got = await streamText(server, "one");
    expect(states(got.summary).at(-1)).toBe("completed");
  });
});
