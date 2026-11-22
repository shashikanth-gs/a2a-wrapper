import { describe, it, expect, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { ClaudeProvider } from "../claude/provider.js";
import { DEFAULTS } from "../config/defaults.js";
import { FakeClaudeClient, happyTurn, structuredTurn } from "./helpers/fake-client.js";
import { artifacts, serve, states, streamText, until, useWorkspace } from "./helpers/harness.js";

const ctx = useWorkspace();

const init = { type: "system", subtype: "init", session_id: "s", model: "m" };

describe("ClaudeProvider.run", () => {
  it("publishes submitted → working → artifact → completed", async () => {
    const { server, client } = serve(ctx.config, [happyTurn("sess-1", "hello world")]);

    const { summary } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "completed"]);
    expect(JSON.stringify(artifacts(summary))).toContain("hello world");
    expect(client.calls[0].options.cwd).toBe(ctx.ws);
    expect(client.calls[0].options.resume).toBeUndefined();
  });

  it("publishes structured_output as a JSON data part on the response artifact", async () => {
    const { server } = serve(ctx.config, [structuredTurn("s", '{"answer":"42"}', { answer: "42" })]);

    const { summary } = await streamText(server);

    const response = artifacts(summary).find((a) => a.name === "response")!;
    expect(response.parts.find((p) => p.data !== undefined)?.data).toEqual({ answer: "42" });
  });

  it("threads the session id into the next task of the context as resume", async () => {
    const { server, client } = serve(ctx.config, [happyTurn("sess-1", "one"), happyTurn("sess-1", "two")]);

    await streamText(server, "first", "ctx-1");
    await streamText(server, "second", "ctx-1");

    expect(client.calls[0].options.resume).toBeUndefined();
    expect(client.calls[1].options.resume).toBe("sess-1");
  });

  it("does not share a session between contexts", async () => {
    const { server, client } = serve(ctx.config, [happyTurn("sess-a", "one"), happyTurn("sess-b", "two")]);

    await streamText(server, "first", "ctx-a");
    await streamText(server, "second", "ctx-b");

    expect(client.calls[1].options.resume).toBeUndefined();
  });

  it("serializes concurrent tasks on the same context", async () => {
    const { server, client } = serve(ctx.config, [{ ...happyTurn("s", "one"), delayMs: 30 }, happyTurn("s", "two")]);

    const a = server.startStream({ text: "a", contextId: "ctx-1" });
    const b = server.startStream({ text: "b", contextId: "ctx-1" });
    const [ra, rb] = await Promise.all([a.done, b.done]);

    expect(states(ra.events.map(summarizeEvent))).toContain("completed");
    expect(states(rb.events.map(summarizeEvent))).toContain("completed");
    expect(client.calls.length).toBe(2);
    // the second query resumes the session the first one opened: it never ran alongside it
    expect(client.calls[1].options.resume).toBe("s");
  });

  it("publishes failed with a sanitized message on result error", async () => {
    const { server } = serve(ctx.config, [
      { messages: [init, { type: "result", subtype: "error_max_turns", errors: [], num_turns: 5, is_error: true }] as never },
    ]);

    const { summary } = await streamText(server);

    expect(states(summary)).toContain("failed");
    const failed = summary.find((e) => e.k === "status" && e.state === "failed") as { text?: string };
    expect(failed.text).toBe("Turn limit reached (max_turns).");
  });

  it("publishes failed on a model refusal without echoing refusal details", async () => {
    const { server } = serve(ctx.config, [
      {
        messages: [
          init,
          { type: "system", subtype: "model_refusal_no_fallback", original_model: "m", content: "detailed internal refusal text" },
          { type: "result", subtype: "success", result: "", usage: {}, total_cost_usd: 0, num_turns: 1 },
        ] as never,
      },
    ]);

    const { summary, events } = await streamText(server);

    expect(states(summary)).toContain("failed");
    expect(JSON.stringify(events)).not.toContain("detailed internal refusal text");
  });

  it("fails the task when the prompt timeout elapses", async () => {
    ctx.config.timeouts = { prompt: 50 };
    const { server } = serve(ctx.config, [{ messages: [], hangAfter: true }]);

    const { summary } = await streamText(server);

    expect(states(summary)).toContain("failed");
    expect((summary.find((e) => e.k === "status" && e.state === "failed") as { text?: string }).text).toBe("Prompt timed out after 50ms.");
  });

  it("does not time out when the prompt timeout is 0", async () => {
    ctx.config.timeouts = { prompt: 0 };
    const { server } = serve(ctx.config, [{ ...happyTurn("s1", "done"), delayMs: 30 }]);

    const { summary } = await streamText(server);

    expect(states(summary)).toContain("completed");
    expect(states(summary)).not.toContain("failed");
  });

  it("does not time out when the prompt timeout is negative", async () => {
    ctx.config.timeouts = { prompt: -1 };
    const { server } = serve(ctx.config, [{ ...happyTurn("s1", "done"), delayMs: 30 }]);

    const { summary } = await streamText(server);

    expect(states(summary)).toContain("completed");
    expect(states(summary)).not.toContain("failed");
  });
});

describe("cancel", () => {
  it("aborts the running query and ends the task canceled without failed", async () => {
    const { server, client } = serve(ctx.config, [{ messages: [init] as never, hangAfter: true }]);

    const live = server.startStream({ text: "go", contextId: "ctx-1" });
    await until(() => client.calls.length === 1 && live.events.length >= 2, 2000, "the run to start");
    const taskId = (live.events[0] as { payload: { value: { id: string } } }).payload.value.id;

    const canceled = summarizeTask(await server.cancel(taskId));
    const { events } = await live.done;

    expect(canceled.state).toBe("canceled");
    expect(states(events.map(summarizeEvent))).not.toContain("failed");
    expect(client.queries[0].interrupted).toBe(true);
    expect(client.calls[0].options.abortController?.signal.aborted).toBe(true);
    expect(client.calls[0].inputClosed).toBe(true);
  });

  it("a follow-up on the same context after a cancel resumes the session", async () => {
    const { server, client } = serve(ctx.config, [
      { messages: [{ ...init, session_id: "sess-c" }] as never, hangAfter: true },
      happyTurn("sess-c", "pong"),
    ]);

    const live = server.startStream({ text: "go", contextId: "ctx-1" });
    await until(() => live.events.length >= 2, 2000, "the run to start");
    const taskId = (live.events[0] as { payload: { value: { id: string } } }).payload.value.id;
    await server.cancel(taskId);
    await live.done;

    const { summary } = await streamText(server, "ping", "ctx-1");

    expect(states(summary)).toContain("completed");
    expect(client.calls[1].options.resume).toBe("sess-c");
  });
});

describe("validation", () => {
  const provider = (script = happyTurn("s", "x")) => new ClaudeProvider(ctx.config, { clientFactory: () => new FakeClaudeClient([script]) });

  it("rejects a missing workingDirectory", async () => {
    ctx.config.claude.workingDirectory = "";
    await expect(provider().initialize()).rejects.toThrow(/workingDirectory/);
  });

  it("rejects a nonexistent workingDirectory", async () => {
    ctx.config.claude.workingDirectory = join(ctx.ws, "does-not-exist");
    await expect(provider().initialize()).rejects.toThrow(/does not exist/);
  });

  it("rejects permissionMode default without a way to answer", async () => {
    ctx.config.claude.permissionMode = "default";
    await expect(provider().initialize()).rejects.toThrow(/interactive|headless/i);
  });

  it("accepts permissionMode default with interactions.mode ask, or with auto-answer rules", async () => {
    ctx.config.claude.permissionMode = "default";
    ctx.config.interactions = { mode: "ask" };
    await expect(provider().initialize()).resolves.toBeUndefined();
    ctx.config.interactions = { autoAnswer: [{ match: { tool: "Bash" }, answer: { decline: true } }] };
    await expect(provider().initialize()).resolves.toBeUndefined();
  });

  it("still rejects permissionMode auto under ask", async () => {
    (ctx.config.claude as Record<string, unknown>).permissionMode = "auto";
    ctx.config.interactions = { mode: "ask" };
    await expect(provider().initialize()).rejects.toThrow(/interactive|headless/i);
  });

  it("rejects bypassPermissions without the explicit opt-in flag", async () => {
    ctx.config.claude.permissionMode = "bypassPermissions";
    ctx.config.claude.dangerouslyAllowBypassPermissions = false;
    await expect(provider().initialize()).rejects.toThrow(/dangerouslyAllowBypassPermissions/);
  });

  it("rejects both customSystemPrompt and systemPromptAppend", async () => {
    ctx.config.claude.customSystemPrompt = "a";
    ctx.config.claude.systemPromptAppend = "b";
    await expect(provider().initialize()).rejects.toThrow(/mutually exclusive/i);
  });

  it("rejects a workingDirectory that points at a file, not a directory", async () => {
    const filePath = join(ctx.ws, "not-a-dir.txt");
    writeFileSync(filePath, "hi");
    ctx.config.claude.workingDirectory = filePath;
    await expect(provider().initialize()).rejects.toThrow(/not a directory/);
  });

  it("only warns (does not throw) when ANTHROPIC_API_KEY is absent", async () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      await expect(provider().initialize()).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });

  it("logs a warning when settingSources is non-empty", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      ctx.config.claude.settingSources = ["project"];
      await provider().initialize();

      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("settingSources"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("identifies itself with the session format that binds are stamped with", () => {
    const info = provider().info();
    expect(info).toMatchObject({ id: "claude", sessionFormat: "1" });
  });
});

describe("buildContext", () => {
  it("runs a read-only turn and writes the context file", async () => {
    const client = new FakeClaudeClient([happyTurn("s", "# Repo overview")]);
    const provider = new ClaudeProvider(ctx.config, { clientFactory: () => client });

    const text = await provider.buildContext();

    expect(text).toBe("# Repo overview");
    expect(client.calls[0].options.permissionMode).toBe("plan");
    expect(client.calls[0].options.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit", "NotebookEdit", "Bash"]));
    expect(await provider.getContextContent()).toBe("# Repo overview");
  });
});

describe("rate limit defaults", () => {
  it("enables rate-limit sideband events", () => {
    expect(DEFAULTS.features.emitRateLimitEvents).toBe(true);
  });
});

