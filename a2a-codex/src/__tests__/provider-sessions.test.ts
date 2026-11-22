/**
 * Context binding (#100): the Codex thread id bound to the contextId (`run.bind`) and resumed from `request.session`
 * (`resumeThread`), also after a restart; a thread Codex does not have starts a fresh one; `session.ttl` is a hard maximum age;
 * the thread options are passed on resume too; `probeSession` looks at the rollout files on disk.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryRunStore, summarizeEvent } from "@a2a-wrapper/core";
import { registryOptionsOf } from "../server/index.js";
import { isThreadNotFound, threadExistsOnDisk } from "../codex/thread-store.js";
import { FakeCodex, T1, T2, T3, answer, serve, sleep, started, states, streamText, turn, until, useWorkspace } from "./helpers/harness.js";

const ctx = useWorkspace();

describe("bind and resume", () => {
  it("binds the thread id to the contextId, stamped with the provider's identity", async () => {
    const store = new InMemoryRunStore();
    const { server } = serve(ctx.config, [turn(T1, "one")], { runStore: store });

    await streamText(server, "hi", "ctx-a");
    await server.registry.drain();

    const b = await store.getBinding("ctx-a");
    expect(b?.session).toMatchObject({ ref: T1, issuer: "codex@1", meta: { model: "test-model" } });
    expect(await store.getBinding("ctx-b")).toBeUndefined();
  });

  it("binds as soon as the CLI reports the thread (thread.started), before any output", async () => {
    const store = new InMemoryRunStore();
    const { server, client } = serve(ctx.config, ["manual"], { runStore: store });
    const live = server.startStream({ text: "hi", contextId: "ctx-a" });
    await until(() => client.calls.length === 1);

    client.calls[0].live!.push(...started(T1).slice(0, 1)); // only thread.started: no turn.started, no text
    await until(() => store.getBinding("ctx-a").then((b) => b?.session.ref === T1) as unknown as boolean, 50).catch(() => {});
    await sleep(30);

    expect((await store.getBinding("ctx-a"))?.session.ref).toBe(T1);
    client.calls[0].live!.push(...started(T1).slice(1), ...answer("x"));
    client.calls[0].live!.end();
    await live.done;
  });

  it("the next message of the context resumes the SAME thread (resumeThread, not startThread), with the thread options", async () => {
    ctx.config.codex.sandboxMode = "read-only";
    ctx.config.codex.networkAccessEnabled = true;
    ctx.config.codex.webSearchMode = "cached";
    ctx.config.codex.additionalDirectories = ["/extra"];
    const { server, client } = serve(ctx.config, [turn(T1, "one"), turn(T1, "two")]);

    await streamText(server, "remember 7", "ctx-r");
    await streamText(server, "what was it?", "ctx-r");

    expect(client.opened.map((o) => [o.how, o.id])).toEqual([["start", undefined], ["resume", T1]]);
    for (const o of client.opened) {
      expect(o.options).toMatchObject({
        model: "test-model",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: true,
        webSearchMode: "cached",
        additionalDirectories: ["/extra"],
        workingDirectory: ctx.ws,
      });
    }
  });

  it("another context gets its own thread", async () => {
    const { server, client } = serve(ctx.config, [turn(T1, "a"), turn(T2, "b"), turn(T1, "a2")]);
    await streamText(server, "a", "ctx-a");
    await streamText(server, "b", "ctx-b");
    await streamText(server, "a again", "ctx-a");
    expect(client.opened.map((o) => [o.how, o.id])).toEqual([["start", undefined], ["start", undefined], ["resume", T1]]);
  });

  it("a restart keeps the conversation with a persistent store: the new process resumes the bound thread", async () => {
    const store = new InMemoryRunStore();
    const first = serve(ctx.config, [turn(T1, "one")], { runStore: store });
    await streamText(first.server, "remember 7", "ctx-r");
    await first.server.registry.drain();
    await first.provider.shutdown();

    // "restart": a new provider, runtime and request handler over the same store
    const second = serve(ctx.config, [turn(T1, "seven")], { runStore: store });
    const { summary } = await streamText(second.server, "what was it?", "ctx-r");

    expect(states(summary)).toContain("completed");
    expect(second.client.opened.map((o) => [o.how, o.id])).toEqual([["resume", T1]]);
  });

  it("with the default in-memory store a restart starts the context afresh (the threads stay on disk)", async () => {
    const first = serve(ctx.config, [turn(T1, "one")]);
    await streamText(first.server, "remember 7", "ctx-r");

    const second = serve(ctx.config, [turn(T2, "none")]);
    await streamText(second.server, "what was it?", "ctx-r");

    expect(second.client.opened.map((o) => o.how)).toEqual(["start"]);
  });

  it("session.reuseByContext false binds nothing and never resumes", async () => {
    ctx.config.session.reuseByContext = false;
    const store = new InMemoryRunStore();
    const { server, client } = serve(ctx.config, [turn(T1, "one"), turn(T2, "two")], { runStore: store });

    await streamText(server, "a", "ctx-n");
    await streamText(server, "b", "ctx-n");
    await server.registry.drain();

    expect(await store.getBinding("ctx-n")).toBeUndefined();
    expect(client.opened.map((o) => o.how)).toEqual(["start", "start"]);
  });

  it("session.ttl <= 0 has always meant never reuse: nothing is bound", async () => {
    ctx.config.session.ttl = 0;
    const store = new InMemoryRunStore();
    const { server, client } = serve(ctx.config, [turn(T1, "one"), turn(T2, "two")], { runStore: store });
    await streamText(server, "a", "ctx-n");
    await streamText(server, "b", "ctx-n");
    await server.registry.drain();
    expect(await store.getBinding("ctx-n")).toBeUndefined();
    expect(client.opened.map((o) => o.how)).toEqual(["start", "start"]);
  });

  it("rebinds when the CLI reports a different thread id on a fresh start", async () => {
    const store = new InMemoryRunStore();
    const { server } = serve(ctx.config, [turn(T1, "one")], { runStore: store });
    await streamText(server, "a", "ctx-a");
    await server.registry.drain();
    expect((await store.getBinding("ctx-a"))?.session.ref).toBe(T1);
  });
});

describe("a thread Codex does not have", () => {
  it("a resume answered `no rollout found` starts a fresh thread once, with nothing published by the failed attempt", async () => {
    ctx.config.events = { enabled: true } as typeof ctx.config.events;
    const captured: unknown[] = [];
    const store = new InMemoryRunStore();
    const { server, client } = serve(
      ctx.config,
      [
        turn(T1, "one"),
        { throwBefore: `Codex Exec exited with code 1: Error: thread/resume: thread/resume failed: no rollout found for thread id ${T1} (code -32600)` },
        turn(T2, "fresh"),
      ],
      {
        runStore: store,
        eventTransport: async (e) => {
          captured.push(e);
        },
      },
    );
    await streamText(server, "first", "ctx-g");
    await server.registry.drain();
    captured.length = 0;

    const { summary } = await streamText(server, "second", "ctx-g");
    await server.registry.drain();

    expect(client.opened.map((o) => [o.how, o.id])).toEqual([["start", undefined], ["resume", T1], ["start", undefined]]);
    // progress is not output, so the retry publishes its "Processing request..." again
    expect(states(summary)).toEqual(["submitted", "working", "working", "completed"]);
    expect(JSON.stringify(summary)).toContain("fresh");
    expect((await store.getBinding("ctx-g"))?.session.ref).toBe(T2);
    // the failed attempt published no lifecycle events: only the fresh attempt's bookends (agent_started, agent_finished)
    expect(captured.map((e: any) => e.eventType)).toEqual(["agent_started", "agent_finished"]);
  });

  it("a ref that is not a thread id is never handed to the CLI (it would take it for a thread name or the prompt)", async () => {
    const store = new InMemoryRunStore();
    // a binding another build wrote with the same issuer but a garbage ref
    const first = serve(ctx.config, [turn("not-a-uuid", "one")], { runStore: store });
    await streamText(first.server, "a", "ctx-x");
    await first.server.registry.drain();
    const second = serve(ctx.config, [turn(T2, "fresh")], { runStore: store });
    const { summary } = await streamText(second.server, "b", "ctx-x");
    expect(states(summary)).toContain("completed");
    expect(second.client.opened.map((o) => o.how)).toEqual(["start"]);
    expect((await store.getBinding("ctx-x"))?.session.ref).toBe(T2);
  });

  it("a resume that starts ANOTHER thread is stopped before it publishes anything and retried fresh", async () => {
    const { server, client } = serve(ctx.config, [turn(T1, "one"), "manual", turn(T3, "fresh")]);
    await streamText(server, "first", "ctx-m");

    const live = server.startStream({ text: "second", contextId: "ctx-m" });
    await until(() => client.calls.length === 2);
    client.calls[1].live!.push({ type: "thread.started", thread_id: T2 }, { type: "turn.started" }); // not T1
    const got = await live.done;

    expect(states(got.events.map(summarizeEvent))).toContain("completed");
    expect(client.calls[1].signal?.aborted).toBe(true); // the wrong CLI turn was killed
    expect(client.opened.map((o) => o.how)).toEqual(["start", "resume", "start"]);
  });

  it("any other failure of a resumed turn is an ordinary failure, not a lost thread", async () => {
    const { server, client } = serve(ctx.config, [turn(T1, "one"), { throwBefore: "Codex Exec exited with code 1: network unreachable" }]);
    await streamText(server, "first", "ctx-g");

    const { summary } = await streamText(server, "second", "ctx-g");

    expect(states(summary)).toContain("failed");
    expect(client.opened).toHaveLength(2);
  });

  it("a not-found AFTER output is final: the turn cannot be replayed", async () => {
    const { server, client } = serve(ctx.config, [
      turn(T1, "one"),
      { events: [...started(T1)], throwAfter: "thread not found" },
    ]);
    await streamText(server, "first", "ctx-g");
    const { summary } = await streamText(server, "second", "ctx-g");
    expect(states(summary)).toContain("failed");
    expect(client.opened).toHaveLength(2);
  });
});

describe("error text", () => {
  it("recognises what `codex exec resume` says for an unknown thread", () => {
    expect(isThreadNotFound(new Error("Codex Exec exited with code 1: Error: thread/resume: thread/resume failed: no rollout found for thread id x (code -32600)"))).toBe(true);
    expect(isThreadNotFound(new Error("Thread not found"))).toBe(true);
    expect(isThreadNotFound(new Error("Codex Exec exited with code 1: network unreachable"))).toBe(false);
    expect(isThreadNotFound(new Error("model not found"))).toBe(false);
  });
});

describe("session lifetime options", () => {
  it("ttl is the hard maximum age (bindingMaxAgeMs), idleTtl is the optional idle expiry", () => {
    expect(registryOptionsOf(ctx.config)).toEqual({ bindingMaxAgeMs: 3_600_000 });
    ctx.config.session.ttl = 60_000;
    ctx.config.session.idleTtl = 5_000;
    expect(registryOptionsOf(ctx.config)).toEqual({ bindingMaxAgeMs: 60_000, bindingTtlMs: 5_000 });
    ctx.config.session.ttl = 0;
    expect(registryOptionsOf(ctx.config)).toEqual({ bindingTtlMs: 5_000 });
    ctx.config.session.reuseByContext = false;
    ctx.config.session.idleTtl = undefined;
    ctx.config.session.ttl = 60_000;
    expect(registryOptionsOf(ctx.config)).toEqual({});
  });

  it("a binding older than ttl is not resumed: a new thread starts", async () => {
    const store = new InMemoryRunStore();
    const first = serve(ctx.config, [turn(T1, "one")], { runStore: store });
    await streamText(first.server, "a", "ctx-t");
    await first.server.registry.drain();
    const b = (await store.getBinding("ctx-t"))!;
    await store.putBinding({ ...b, createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } as never);

    const second = serve(ctx.config, [turn(T2, "two")], { runStore: store });
    await streamText(second.server, "b", "ctx-t");
    expect(second.client.opened.map((o) => o.how)).toEqual(["start"]);
  });
});

describe("probeSession and the thread store", () => {
  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), "a2a-codex-home-"));
    mkdirSync(join(dir, "sessions", "2026", "11", "22"), { recursive: true });
    writeFileSync(join(dir, "sessions", "2026", "11", "22", `rollout-2026-11-22T10-00-00-${T1}.jsonl`), "{}\n");
    return dir;
  }

  it("alive when the rollout exists, gone when it does not", async () => {
    const dir = home();
    try {
      const { provider } = serve(ctx.config, [], { codexHome: dir });
      expect(await provider.probeSession({ ref: T1 })).toBe("alive");
      expect(await provider.probeSession({ ref: T2 })).toBe("gone");
      expect(await provider.probeSession({ ref: "not-a-uuid" })).toBe("gone");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unknown when the sessions directory cannot be read (it may be another CODEX_HOME than the CLI's)", async () => {
    const { provider } = serve(ctx.config, [], { codexHome: join(ctx.ws, "nowhere") });
    expect(await provider.probeSession({ ref: T1 })).toBe("unknown");
    expect(await threadExistsOnDisk(T1, join(ctx.ws, "nowhere"))).toBeUndefined();
  });

  it("validateBindingsOnStart style sweep: a gone thread's binding is deleted, an alive one kept", async () => {
    const dir = home();
    try {
      const store = new InMemoryRunStore();
      const first = serve(ctx.config, [turn(T1, "a"), turn(T2, "b")], { runStore: store, codexHome: dir });
      await streamText(first.server, "a", "ctx-alive");
      await streamText(first.server, "b", "ctx-gone");
      await first.server.registry.drain();
      const report = await (first.server.registry as any).validateBindings();
      const alive = await store.getBinding("ctx-alive");
      const gone = await store.getBinding("ctx-gone");
      expect(alive?.session.ref).toBe(T1);
      expect(gone).toBeUndefined();
      expect(report).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release and abortOrphan are honest no-ops: a thread is a file, the CLI child dies with the wrapper", async () => {
    const { provider } = serve(ctx.config, []);
    await expect(provider.release({ ref: T1 })).resolves.toBeUndefined();
    await expect(
      provider.abortOrphan({ runId: "r", turnId: "t", taskId: "k", contextId: "c", reason: "cancel", session: { ref: T1 } }),
    ).resolves.toEqual({ stopped: "confirmed", session: "reusable" });
  });
});

describe("FakeCodex", () => {
  it("is exercised: a missing script is reported", async () => {
    const c = new FakeCodex([]);
    await expect(c.startThread().runStreamed("x")).rejects.toThrow(/no script/);
  });
});
