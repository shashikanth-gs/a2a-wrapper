/**
 * Tests: lifecycle and usage events reach the configured event transport.
 *
 * Before this change a2a-opencode emitted only tool_call_start / tool_call_end
 * through the transport (no agent_started / agent_finished / agent_error and no
 * usage), even though its README claimed lifecycle events. These tests drive
 * OpenCodeExecutor against a scripted fake backend, so they run offline and
 * cover the canonical (1.x-shaped) event stream that both the 1.x client and
 * the 2.x client produce.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import type { Message as A2AMessage } from "@a2a-js/sdk";
import type { AgentEvent } from "@a2a-wrapper/core";

import { DEFAULTS } from "../config/defaults.js";
import { OpenCodeExecutor, usageRecordFromMessage } from "../opencode/executor.js";

// ─── Scripted fake backend ───────────────────────────────────────────────────

type Script = (emit: (e: unknown) => void, sessionId: string) => void | Promise<void>;
const state: { script: Script; failPrompt?: Error } = { script: () => {} };

vi.mock("../opencode/backend-factory.js", () => ({
  createBackend: async () => makeFakeBackend(),
}));

function makeFakeBackend(): any {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  const push = (e: unknown) => { queue.push(e); wake?.(); };
  let closed = false;
  return {
    kind: "v1",
    health: async () => ({ healthy: true, version: "test" }),
    startHealthCheck: () => {}, stopHealthCheck: () => {}, cleanup: () => {},
    projectCurrent: async () => ({ id: "p" }),
    agentList: async () => [],
    sessionCreate: async () => ({ id: "ses_1", title: "t" }),
    sessionGet: async () => ({ id: "ses_1" }),
    sessionAbort: async () => true,
    sessionIdle: async () => true,
    sessionMessages: async () => [],
    sessionPromptAsync: async (sessionId: string) => {
      if (state.failPrompt) throw state.failPrompt;
      setTimeout(() => { void state.script(push, sessionId); }, 5);
    },
    permissionList: async () => [], permissionReply: async () => {},
    questionList: async () => [], questionReply: async () => {}, questionReject: async () => {},
    mcpStatus: async () => ({}), mcpAdd: async () => undefined, mcpConnect: async () => undefined, mcpDisconnect: async () => undefined,
    subscribeEvents: async () => ({
      abort: () => { closed = true; wake?.(); },
      stream: (async function* () {
        while (!closed) {
          if (queue.length === 0) await new Promise<void>((r) => { wake = r; });
          while (queue.length) yield queue.shift();
        }
      })(),
    }),
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

function makeConfig(events: Record<string, unknown> = { enabled: true, transport: "a2a" }): any {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.events = events;
  cfg.timeouts = { ...cfg.timeouts, prompt: 5_000 };
  cfg.logging = { level: "error" };
  return cfg;
}

function makeContext(): RequestContext {
  const userMessage = {
    messageId: "m1", contextId: "ctx-1", taskId: "", role: 1,
    parts: [{ content: { $case: "text", value: "hello" }, metadata: undefined }],
    metadata: undefined, extensions: [], referenceTaskIds: [],
  } as unknown as A2AMessage;
  return { taskId: "task-1", contextId: "ctx-1", userMessage, task: null } as RequestContext;
}

function makeBus() {
  const events: any[] = [];
  const bus = { publish: vi.fn((e: any) => { events.push(e); }), finished: vi.fn(), events };
  return bus as typeof bus & ExecutionEventBus;
}

/** An assistant message as 1.x reports it (and as the 2.x client translates a finished step). */
function assistant(id: string, over: Record<string, unknown> = {}) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "ses_1",
      info: {
        id, sessionID: "ses_1", role: "assistant", modelID: "big-pickle", providerID: "opencode", cost: 0,
        tokens: { input: 100, output: 10, reasoning: 2, cache: { read: 40, write: 0 } },
        time: { created: 1_000, completed: 1_500 },
        ...over,
      },
    },
  };
}
const text = (delta: string) => ({ type: "message.part.updated", properties: { sessionID: "ses_1", delta, part: { type: "text", text: delta } } });
const idle = { type: "session.idle", properties: { sessionID: "ses_1" } };

async function run(opts: { script: Script; failPrompt?: Error; events?: Record<string, unknown> }) {
  state.script = opts.script;
  state.failPrompt = opts.failPrompt;
  const executor = new OpenCodeExecutor(makeConfig(opts.events));
  const seen: AgentEvent[] = [];
  executor.customTransport = async (e: AgentEvent) => { seen.push(e); };
  const bus = makeBus();
  await executor.execute(makeContext(), bus as any);
  await executor.shutdown();
  return { seen, bus };
}

const types = (es: AgentEvent[]) => es.map((e) => e.eventType);

beforeEach(() => { state.script = () => {}; state.failPrompt = undefined; });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("OpenCode lifecycle and usage events", () => {
  it("emits agent_started first and agent_finished last, with the summed usage", async () => {
    const { seen } = await run({
      script: (emit) => {
        emit(assistant("msg_a", { tokens: { input: 100, output: 10, reasoning: 2, cache: { read: 40, write: 0 } } }));
        emit(text("done"));
        emit(assistant("msg_b", { tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 7 } }, cost: 0.5, time: { created: 2_000, completed: 2_300 } }));
        emit(idle);
      },
    });

    expect(types(seen)[0]).toBe("agent_started");
    expect(types(seen)[types(seen).length - 1]).toBe("agent_finished");
    expect(types(seen).filter((t) => t === "agent_finished")).toHaveLength(1);
    expect(types(seen)).not.toContain("agent_error");

    const finished = seen[seen.length - 1];
    expect(finished.data.backend).toBe("opencode");
    expect(finished.data.usage).toMatchObject({
      llmCalls: 2, inputTokens: 120, outputTokens: 15, cacheReadTokens: 40, cacheWriteTokens: 7,
      reasoningTokens: 2, durationMs: 800, cost: 0.5, model: "opencode/big-pickle",
    });
    expect((finished.data.usage as any).calls).toHaveLength(2);
  });

  it("counts a message once even though 1.x repeats message.updated for it", async () => {
    const { seen } = await run({
      script: (emit) => { emit(assistant("msg_a")); emit(assistant("msg_a")); emit(assistant("msg_a")); emit(text("ok")); emit(idle); },
    });
    expect((seen[seen.length - 1].data.usage as any).llmCalls).toBe(1);
  });

  it("ignores messages that are not completed assistant messages", async () => {
    const { seen } = await run({
      script: (emit) => {
        emit(assistant("msg_user", { role: "user" }));
        emit(assistant("msg_partial", { time: { created: 1_000 } })); // not completed yet
        emit(assistant("msg_ok"));
        emit(idle);
      },
    });
    expect((seen[seen.length - 1].data.usage as any).llmCalls).toBe(1);
  });

  it("keeps cost null when the message reports none (never estimated)", async () => {
    const { seen } = await run({
      script: (emit) => { emit(assistant("msg_a", { cost: undefined })); emit(idle); },
    });
    expect((seen[seen.length - 1].data.usage as any).cost).toBeNull();
  });

  it("reports usage: null when no LLM call was observed", async () => {
    const { seen } = await run({ script: (emit) => { emit(text("hi")); emit(idle); } });
    const finished = seen.find((e) => e.eventType === "agent_finished")!;
    expect(finished.data.usage).toBeNull();
  });

  it("on failure emits agent_error with the usage spent so far, and no agent_finished", async () => {
    const { seen } = await run({
      script: (emit) => {
        emit(assistant("msg_a"));
        emit({ type: "session.error", properties: { sessionID: "ses_1", error: { message: "provider exploded" } } });
      },
    });
    expect(types(seen)[0]).toBe("agent_started");
    expect(types(seen)).toContain("agent_error");
    expect(types(seen)).not.toContain("agent_finished");
    const err = seen.find((e) => e.eventType === "agent_error")!;
    expect(err.data.backend).toBe("opencode");
    expect(String(err.data.message)).toContain("provider exploded");
    expect((err.data.usage as any).llmCalls).toBe(1);
  });

  it("emits agent_error with usage: null when the prompt could not be sent", async () => {
    const { seen } = await run({ script: () => {}, failPrompt: new Error("HTTP 0") });
    const err = seen.find((e) => e.eventType === "agent_error")!;
    expect(err.data.usage).toBeNull();
    expect(types(seen).filter((t) => t === "agent_error")).toHaveLength(1);
  });

  it("publishes trace.lifecycle artifacts on the default A2A transport", async () => {
    state.script = (emit) => { emit(assistant("msg_a")); emit(idle); };
    state.failPrompt = undefined;
    const executor = new OpenCodeExecutor(makeConfig({ enabled: true, transport: "a2a" }));
    const bus = makeBus();
    await executor.execute(makeContext(), bus as any);
    await executor.shutdown();
    const lifecycle = bus.events
      .filter((e: any) => e?.kind === "artifactUpdate" && e.data?.artifact?.name === "trace.lifecycle")
      .map((e: any) => e.data.artifact.parts[0].content.value);
    expect(lifecycle.map((d: any) => d.state)).toEqual(["started", "finished"]);
    expect(lifecycle[1].usage.llmCalls).toBe(1);
  });
});

describe("usageRecordFromMessage", () => {
  it("returns null until the message is completed", () => {
    expect(usageRecordFromMessage({ tokens: { input: 1 }, time: { created: 1 } })).toBeNull();
    expect(usageRecordFromMessage({ time: { created: 1, completed: 2 } })).toBeNull();
  });

  it("maps OpenCode tokens to the shared UsageCallRecord", () => {
    expect(
      usageRecordFromMessage({
        providerID: "anthropic", modelID: "claude", cost: 0.12,
        tokens: { input: 5, output: 6, reasoning: 7, cache: { read: 8, write: 9 } },
        time: { created: 10, completed: 25 },
      }),
    ).toEqual({
      model: "anthropic/claude", inputTokens: 5, outputTokens: 6, reasoningTokens: 7,
      cacheReadTokens: 8, cacheWriteTokens: 9, durationMs: 15, timeToFirstTokenMs: null,
      cost: 0.12, apiEndpoint: null, initiator: null,
    });
  });
});
