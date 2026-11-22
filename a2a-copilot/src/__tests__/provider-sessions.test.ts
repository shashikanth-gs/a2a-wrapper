/**
 * Session binding and resume: the provider binds the Copilot session id to the contextId (`run.bind`) before the first
 * output, resumes it from `request.session` (also after a restart), reports a session the runtime lost as
 * `session-not-found`, and keeps its in-process handles in step with what core discards.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryRunStore,
  SESSION_NOT_FOUND,
  createProviderTestServer,
  stateName,
  summarizeEvent,
  summarizeTask,
} from "@a2a-wrapper/core";
import { CopilotProvider, SESSION_FORMAT, isSessionNotFound } from "../copilot/provider.js";
import { makeConfig, type ConfigOptions } from "./helpers/config.js";
import { ManualClient, ManualSession } from "./helpers/manual-session.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A session that answers every prompt with `text` and goes idle. */
function answering(id: string, text = "ok"): ManualSession {
  const s = new ManualSession(id);
  s.send.mockImplementation(async () => {
    queueMicrotask(() => {
      s.emit("assistant.message_delta", { deltaContent: text });
      s.emit("session.idle");
    });
    return "m";
  });
  return s;
}

function boot(sessions: ManualSession[], config: ConfigOptions = {}, shared: { runStore?: InMemoryRunStore; client?: ManualClient } = {}) {
  const client = shared.client ?? new ManualClient(sessions);
  const provider = new CopilotProvider(makeConfig(config), { clientFactory: () => client as never });
  const runStore = shared.runStore ?? new InMemoryRunStore();
  const server = createProviderTestServer(provider, { registry: { store: runStore } });
  return { client, provider, runStore, server };
}

const done = async (h: ReturnType<typeof boot>, contextId = "ctx") => summarizeTask(await h.server.send({ text: "hi", contextId }));

describe("the provider declares itself", () => {
  it("has a stable id and a session format (the ref is the Copilot session id)", () => {
    const info = boot([answering("s")]).provider.info();
    expect(info).toMatchObject({ id: "copilot", sessionFormat: SESSION_FORMAT, inputModes: ["text/plain"], outputModes: ["text/plain"] });
    expect(SESSION_FORMAT).toBe("1");
  });

  it("offers steer, abort, abortOrphan, release and probeSession, and no flags", () => {
    const p = boot([answering("s")]).provider;
    for (const m of ["steer", "abort", "abortOrphan", "release", "probeSession", "run", "initialize", "shutdown"]) {
      expect(typeof (p as any)[m], m).toBe("function");
    }
    expect(Object.keys(p.info()).some((k) => /^supports/.test(k))).toBe(false);
  });
});

describe("binding", () => {
  it("binds the session id (with the model) for the context", async () => {
    const h = boot([answering("sess-A")], { copilot: { model: "gpt-4.1" } });
    await done(h, "ctx-bind");
    const binding = await h.runStore.getBinding("ctx-bind");
    expect(binding?.session).toEqual({ ref: "sess-A", meta: { model: "gpt-4.1" }, issuer: `copilot@${SESSION_FORMAT}` });
  });

  it("calls run.bind before anything is published, so a restart mid-turn can resume (the wrapper contract)", async () => {
    const calls: string[] = [];
    const run: any = {
      progress: (t?: string) => calls.push(`progress:${t}`),
      bind: (b: any) => calls.push(`bind:${b.ref}`),
      artifact: (a: any) => calls.push(`artifact:${a.name}`),
      event: () => calls.push("event"),
      complete: () => calls.push("complete"),
      fail: () => calls.push("fail"),
      ask: async () => ({ outcome: "unavailable" }),
      signal: { aborted: false, addEventListener() {} },
    };
    const h = boot([answering("sess-A")]);
    await h.provider.run(
      { taskId: "t", contextId: "c", turnId: "u", runId: "r", input: [{ kind: "text", text: "hi" }], history: [], caller: { id: "a", kind: "anonymous" }, correlation: { eventId: "e", metadata: {} }, extensions: new Map() } as never,
      run,
    );
    expect(calls[0]).toBe("progress:Processing request...");
    expect(calls[1]).toBe("bind:sess-A");
    expect(calls.findIndex((c) => c.startsWith("artifact:"))).toBeGreaterThan(1);
    expect(calls.at(-1)).toBe("complete");
  });

  it("the next turn of the context reuses the live session: no new session, no resume", async () => {
    const s = answering("sess-A");
    const h = boot([s]);
    await done(h, "ctx-1");
    await done(h, "ctx-1");
    expect(h.client.created).toHaveLength(1);
    expect(h.client.resumed).toEqual([]);
    expect(s.send).toHaveBeenCalledTimes(2);
  });

  it("different contexts get different sessions", async () => {
    const h = boot([answering("s1"), answering("s2")]);
    await done(h, "ctx-a");
    await done(h, "ctx-b");
    expect(h.client.created.map((x) => x.sessionId)).toEqual(["s1", "s2"]);
  });

  it("after a restart (new provider, registry and client over the same store) the context RESUMES the same session", async () => {
    const runStore = new InMemoryRunStore();
    const first = boot([answering("sess-A")], {}, { runStore });
    await done(first, "ctx-restart");
    await first.provider.shutdown();

    // the new process: a runtime that still knows the session on disk
    const client2 = new ManualClient([]);
    const revived = answering("sess-A", "i remember");
    client2.known.set("sess-A", revived);
    const second = boot([], { copilot: { model: "gpt-4.1" }, mcp: { probe: { type: "stdio", command: "node", args: ["x"] } } }, { runStore, client: client2 });
    const task = await done(second, "ctx-restart");

    expect(task.state).toBe("completed");
    expect(client2.resumed).toEqual(["sess-A"]);
    expect(client2.created).toHaveLength(0);
    // the resumed session has the same setup as a new one (model, MCP servers, hooks, handlers)
    const opts = client2.createOptions[0];
    expect(opts.model).toBe("gpt-4.1");
    expect(Object.keys(opts.mcpServers as object)).toEqual(["probe"]);
    expect(typeof opts.onPermissionRequest).toBe("function");
    expect(opts.hooks).toBeDefined();
    expect(task.artifacts.find((a) => a.name === "response")?.text).toBe("i remember");
  });

  it("a session the runtime no longer has is session-not-found: core forgets it and runs the SAME turn on a fresh session", async () => {
    const runStore = new InMemoryRunStore();
    const first = boot([answering("sess-A")], {}, { runStore });
    await done(first, "ctx-gone");
    await first.provider.shutdown();

    const client2 = new ManualClient([answering("sess-B", "fresh")]); // knows nothing about sess-A
    const second = boot([], {}, { runStore, client: client2 });
    const { events } = await second.server.stream({ text: "again", contextId: "ctx-gone" });
    const summary = events.map(summarizeEvent);

    expect(client2.resumed).toEqual(["sess-A"]);
    expect(client2.created.map((s) => s.sessionId)).toEqual(["sess-B"]);
    expect(summary.at(-1)).toMatchObject({ k: "status", state: "completed" });
    // the failed attempt published nothing a replay would repeat: one lifecycle start, no failure
    expect(summary.filter((e) => e.k === "artifact" && e.name === "trace.lifecycle" && (e as any).parts[0].data.state === "started")).toHaveLength(1);
    expect(summary.some((e) => e.k === "status" && e.state === "failed")).toBe(false);
    expect((await runStore.getBinding("ctx-gone"))?.session?.ref).toBe("sess-B");
  });

  it("a resume that fails for another reason fails the task (and is not mistaken for a lost session)", async () => {
    const runStore = new InMemoryRunStore();
    const first = boot([answering("sess-A")], {}, { runStore });
    await done(first, "ctx-x");
    await first.provider.shutdown();
    const client2 = new ManualClient([]);
    client2.resumeSession = async () => {
      throw new Error("connection lost");
    };
    const second = boot([], {}, { runStore, client: client2 });
    const task = await done(second, "ctx-x");
    expect(task.state).toBe("failed");
    expect(task.text).toContain("connection lost");
    expect((await runStore.getBinding("ctx-x"))?.session?.ref).toBe("sess-A"); // kept: the first resume decides, not this
  });

  it("isSessionNotFound recognises the runtime's wording and nothing broader", () => {
    expect(isSessionNotFound(new Error("Request session.resume failed with message: Failed to load session events: Session not found: abc"))).toBe(true);
    expect(isSessionNotFound(new Error("no such session"))).toBe(true);
    expect(isSessionNotFound(new Error("connection lost"))).toBe(false);
    expect(isSessionNotFound(new Error("Failed to load session events: permission denied"))).toBe(false);
    expect(SESSION_NOT_FOUND).toBe("session-not-found");
  });
});

describe("session reuse settings", () => {
  it("reuseByContext:false: every turn gets its own session, released afterwards, and nothing is bound", async () => {
    const a = answering("s1");
    const b = answering("s2");
    const h = boot([a, b], { session: { reuseByContext: false } });
    await done(h, "ctx");
    await done(h, "ctx");
    expect(h.client.created.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    expect(a.disconnect).toHaveBeenCalledTimes(1);
    expect(b.disconnect).toHaveBeenCalledTimes(1);
    expect(await h.runStore.getBinding("ctx")).toBeUndefined();
  });

  it("ttl <= 0 has always meant never reuse", async () => {
    const h = boot([answering("s1"), answering("s2")], { session: { ttl: 0 } });
    await done(h, "ctx");
    await done(h, "ctx");
    expect(h.client.created).toHaveLength(2);
    expect(await h.runStore.getBinding("ctx")).toBeUndefined();
  });

  it("the idle sweep releases the in-process handle only; the binding then resumes it", async () => {
    vi.useFakeTimers();
    const s = answering("sess-A");
    const h = boot([s], { session: { cleanupInterval: 1000, ttl: 5000 } });
    await h.provider.initialize();
    await done(h, "ctx");
    await vi.advanceTimersByTimeAsync(7000);
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(await h.runStore.getBinding("ctx")).toBeDefined(); // the conversation is still bound

    vi.useRealTimers();
    await done(h, "ctx");
    expect(h.client.resumed).toEqual(["sess-A"]); // resumed from disk, not recreated
    expect(h.client.created).toHaveLength(1);
    await h.provider.shutdown();
  });
});

describe("release, probeSession and abortOrphan", () => {
  it("release drops the live handle (disconnect) and is safe for an unknown session", async () => {
    const s = answering("sess-A");
    const h = boot([s]);
    await done(h, "ctx");
    await h.provider.release({ ref: "sess-A" });
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    await expect(h.provider.release({ ref: "nope" })).resolves.toBeUndefined();
    await done(h, "ctx");
    expect(h.client.resumed).toEqual(["sess-A"]); // the next turn resumes it
  });

  it("probeSession: alive when live or known to the runtime, gone when it does not know it, unknown when it cannot say", async () => {
    const s = answering("sess-A");
    const h = boot([s]);
    await done(h, "ctx");
    expect(await h.provider.probeSession({ ref: "sess-A" })).toBe("alive");
    await h.provider.release({ ref: "sess-A" });
    expect(await h.provider.probeSession({ ref: "sess-A" })).toBe("alive"); // still on disk
    expect(await h.provider.probeSession({ ref: "never" })).toBe("gone");
    (h.client as any).getSessionMetadata = async () => {
      throw new Error("boom");
    };
    expect(await h.provider.probeSession({ ref: "never" })).toBe("unknown");
    (h.client as any).getSessionMetadata = undefined;
    expect(await h.provider.probeSession({ ref: "never" })).toBe("unknown");
  });

  it("core validates bindings at start-up through probeSession and drops the gone ones", async () => {
    const runStore = new InMemoryRunStore();
    const first = boot([answering("sess-A")], {}, { runStore });
    await done(first, "ctx-v");
    await first.provider.shutdown();
    const client2 = new ManualClient([]); // the runtime lost it
    const provider2 = new CopilotProvider(makeConfig(), { clientFactory: () => client2 as never });
    const server2 = createProviderTestServer(provider2, { registry: { store: runStore, validateBindingsOnStart: true } });
    await provider2.initialize();
    const report = await server2.registry.sweep();
    expect(report.bindings?.gone).toEqual(["ctx-v"]);
    expect(await runStore.getBinding("ctx-v")).toBeUndefined();
  });

  it("abortOrphan with a spawned runtime: it died with the old process, nothing is running", async () => {
    const h = boot([answering("s")]);
    expect(await h.provider.abortOrphan({ runId: "r", turnId: "t", taskId: "k", contextId: "c", reason: "cancel", session: { ref: "s" } })).toEqual({
      stopped: "confirmed",
      session: "reusable",
    });
  });

  it("abortOrphan with an external runtime resumes the session and aborts it; a failure is unconfirmed/discard", async () => {
    const s = answering("sess-A");
    const client = new ManualClient([]);
    client.known.set("sess-A", s);
    const provider = new CopilotProvider(makeConfig({ copilot: { cliUrl: "localhost:4321" } }), { clientFactory: () => client as never });
    await provider.initialize();
    const info = { runId: "r", turnId: "t", taskId: "k", contextId: "c", reason: "cancel" as const, session: { ref: "sess-A" } };
    expect(await provider.abortOrphan(info)).toEqual({ stopped: "confirmed", session: "reusable" });
    expect(s.abort).toHaveBeenCalledTimes(1);
    s.abort.mockRejectedValueOnce(new Error("gone"));
    expect(await provider.abortOrphan(info)).toEqual({ stopped: "unconfirmed", session: "discard" });
  });
});

describe("failures", () => {
  it("a session that cannot be created fails the task with the usual wording and a code", async () => {
    const client = new ManualClient([new ManualSession()]);
    client.failCreate = new Error("ECONNREFUSED 127.0.0.1:4321");
    const provider = new CopilotProvider(makeConfig({ copilot: { cliUrl: "localhost:4321" } }), { clientFactory: () => client as never });
    const server = createProviderTestServer(provider);
    const { events } = await server.stream({ text: "hi" });
    const last = events.at(-1);
    expect(stateName(last.payload.value.status.state)).toBe("failed");
    expect(summarizeEvent(last)).toMatchObject({ text: "Cannot reach GitHub Copilot CLI server at localhost:4321. Is it running?", metaKeys: ["code"] });
    expect(last.payload.value.metadata.code).toBe("unavailable");
  });

  it("a permission error reads as the missing-token hint (auth)", async () => {
    const client = new ManualClient([new ManualSession()]);
    client.failCreate = new Error("onPermissionRequest handler is required");
    const server = createProviderTestServer(new CopilotProvider(makeConfig(), { clientFactory: () => client as never }));
    const { events } = await server.stream({ text: "hi" });
    expect(events.at(-1).payload.value.metadata.code).toBe("auth");
    expect(summarizeEvent(events.at(-1))).toMatchObject({ text: "GITHUB_TOKEN not set. Run `gh auth login` or set GITHUB_TOKEN env var." });
  });

  it("a client that fails to start reports how to fix it", async () => {
    const client = new ManualClient([]);
    client.start.mockRejectedValue(new Error("spawn copilot ENOENT"));
    const provider = new CopilotProvider(makeConfig(), { clientFactory: () => client as never });
    await expect(provider.initialize()).rejects.toThrow(/GitHub Copilot CLI not found/);
    client.start.mockRejectedValue(new Error("401 unauthorized"));
    await expect(provider.initialize()).rejects.toThrow(/not authenticated/);
    client.start.mockRejectedValue(new Error("kaboom"));
    await expect(provider.initialize()).rejects.toThrow(/Failed to start GitHub Copilot CLI: kaboom/);
  });

  it("initialize is idempotent and shutdown stops the client", async () => {
    const h = boot([answering("s")]);
    await Promise.all([h.provider.initialize(), h.provider.initialize()]);
    await h.provider.initialize();
    expect(h.client.start).toHaveBeenCalledTimes(1);
    await h.provider.shutdown();
    expect(h.client.stop).toHaveBeenCalledTimes(1);
  });
});
