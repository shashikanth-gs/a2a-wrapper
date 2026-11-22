/**
 * Tests: lifecycle and usage events reach the configured event transport.
 *
 * These drive `OpenCodeProvider` against a scripted fake OpenCode server through the real request handler, so they run offline
 * and cover the canonical (1.x-shaped) event stream that both the 1.x client and the 2.x client produce.
 */

import { describe, it, expect } from "vitest";
import { summarizeEvent, type AgentEvent } from "@a2a-wrapper/core";
import { assistant, idle, text, type Script } from "./helpers/fake-backend.js";
import { serve, useConfig, type Config } from "./helpers/harness.js";
import { usageRecordFromMessage } from "../opencode/usage.js";

const ctx = useConfig();

async function run(opts: { script: Script; failPrompt?: Error; events?: Record<string, unknown> }) {
  const config: Config = ctx.config;
  config.events = (opts.events ?? { enabled: true, transport: "a2a" }) as Config["events"];
  const seen: AgentEvent[] = [];
  const { server, provider } = serve(
    config,
    { scripts: [opts.script], ...(opts.failPrompt ? { failPrompt: opts.failPrompt } : {}) },
    {
      eventTransport: async (e: AgentEvent) => {
        seen.push(e);
      },
    },
  );
  const got = await server.stream({ text: "hello", contextId: "ctx-1" });
  await provider.shutdown();
  return { seen, events: got.events };
}

const types = (es: AgentEvent[]) => es.map((e) => e.eventType);

describe("OpenCode lifecycle and usage events", () => {
  it("emits agent_started first and agent_finished last, with the summed usage", async () => {
    const { seen } = await run({
      script: ({ emit }) => {
        emit(assistant("msg_a", { tokens: { input: 100, output: 10, reasoning: 2, cache: { read: 40, write: 0 } } }));
        emit(text("done"));
        emit(assistant("msg_b", { tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 7 } }, cost: 0.5, time: { created: 2_000, completed: 2_300 } }));
        emit(idle());
      },
    });

    expect(types(seen)[0]).toBe("agent_started");
    expect(types(seen)[types(seen).length - 1]).toBe("agent_finished");
    expect(types(seen).filter((t) => t === "agent_finished")).toHaveLength(1);
    expect(types(seen)).not.toContain("agent_error");

    const finished = seen[seen.length - 1]!;
    expect(finished.data.backend).toBe("opencode");
    expect(finished.data.usage).toMatchObject({
      llmCalls: 2, inputTokens: 120, outputTokens: 15, cacheReadTokens: 40, cacheWriteTokens: 7,
      reasoningTokens: 2, durationMs: 800, cost: 0.5, model: "opencode/big-pickle",
    });
    expect((finished.data.usage as any).calls).toHaveLength(2);
  });

  it("counts a message once even though 1.x repeats message.updated for it", async () => {
    const { seen } = await run({
      script: ({ emit }) => { emit(assistant("msg_a")); emit(assistant("msg_a")); emit(assistant("msg_a")); emit(text("ok")); emit(idle()); },
    });
    expect((seen[seen.length - 1]!.data.usage as any).llmCalls).toBe(1);
  });

  it("ignores messages that are not completed assistant messages", async () => {
    const { seen } = await run({
      script: ({ emit }) => {
        emit(assistant("msg_user", { role: "user" }));
        emit(assistant("msg_partial", { time: { created: 1_000 } })); // not completed yet
        emit(assistant("msg_ok"));
        emit(idle());
      },
    });
    expect((seen[seen.length - 1]!.data.usage as any).llmCalls).toBe(1);
  });

  it("keeps cost null when the message reports none (never estimated)", async () => {
    const { seen } = await run({
      script: ({ emit }) => { emit(assistant("msg_a", { cost: undefined })); emit(idle()); },
    });
    expect((seen[seen.length - 1]!.data.usage as any).cost).toBeNull();
  });

  it("reports usage: null when no LLM call was observed", async () => {
    const { seen } = await run({ script: ({ emit }) => { emit(text("hi")); emit(idle()); } });
    const finished = seen.find((e) => e.eventType === "agent_finished")!;
    expect(finished.data.usage).toBeNull();
  });

  it("on failure emits agent_error with the usage spent so far, and no agent_finished", async () => {
    const { seen } = await run({
      script: ({ emit }) => {
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
    const config: Config = ctx.config;
    config.events = { enabled: true, transport: "a2a" } as Config["events"];
    const { server } = serve(config, { scripts: [({ emit }) => { emit(assistant("msg_a")); emit(idle()); }] });
    const got = await server.stream({ text: "hello", contextId: "ctx-1" });
    const lifecycle = got.events
      .map(summarizeEvent)
      .filter((e) => e.k === "artifact" && e.name === "trace.lifecycle")
      .map((e: any) => e.parts[0].data);
    expect(lifecycle.map((d: any) => d.state)).toEqual(["started", "finished"]);
    expect(lifecycle[1].usage.llmCalls).toBe(1);
  });

  it("puts the same usage on the completed status as x-usage and as core's usage key", async () => {
    const { events } = await run({
      script: ({ emit }) => { emit(assistant("m1")); emit(text("ok")); emit(idle()); },
    });
    const completed = events.map(summarizeEvent).find((e) => e.k === "status" && e.state === "completed") as any;
    expect(completed.metaKeys).toEqual(["urn:a2a-wrapper:usage:v1", "x-usage"]);
    expect(completed.usage).toMatchObject({ llmCalls: 1, inputTokens: 100, outputTokens: 10, cost: 0, model: "opencode/big-pickle" });
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
