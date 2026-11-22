/**
 * Scripted OpenCode sessions shared by the golden parity test and the recorder that produced its fixture.
 *
 * A scenario is what an OpenCode server would emit for one prompt, as canonical (1.x-shaped) events: both the 1.x client and the
 * 2.x client produce them, so the same scenarios cover both server generations. The fixture (`../golden/old-executor.golden.json`)
 * was recorded by running these SAME scenarios through the `OpenCodeExecutor` that existed before the provider migration (an
 * `AgentExecutor` publishing on the event bus, a2a-opencode 1.7.2 on `integration/core-boundary-impl` at 0d58392) and the real
 * SDK request handler; the parity test replays them through `OpenCodeProvider`.
 */

import { DEFAULTS } from "../../config/defaults.js";
import {
  assistant, idle, sessionError, text, toolCompleted, toolError, toolRunning, userMessage,
  type FakeBackendOptions, type Script,
} from "./fake-backend.js";

export interface Scenario {
  name: string;
  script: Script;
  /** Config overrides. */
  chunks?: boolean;
  events?: boolean;
  promptTimeoutMs?: number;
  failPrompt?: Error;
  /** What `sessionMessages` returns (the fallback when no text arrived). */
  messages?: FakeBackendOptions["messages"];
  systemPrompt?: string;
}

const done = (emit: (e: unknown) => void) => emit(idle());

export const SCENARIOS: Scenario[] = [
  {
    name: "simple-buffered",
    script: ({ emit }) => { emit(assistant("m1")); emit(text("hello ")); emit(text("world")); done(emit); },
  },
  {
    name: "simple-chunked",
    chunks: true,
    script: ({ emit }) => { emit(assistant("m1")); emit(text("hello ")); emit(text("world")); done(emit); },
  },
  {
    name: "text-tool-text",
    script: ({ emit }) => {
      emit(text("Let me check. "));
      emit(toolRunning("c1", "read", { path: "/w/a.txt" }));
      emit(toolCompleted("c1", "read", "file contents"));
      emit(assistant("m1"));
      emit(text("The answer is 42"));
      emit(assistant("m2", { tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 7 } }, cost: 0.5, time: { created: 2_000, completed: 2_300 } }));
      done(emit);
    },
  },
  {
    name: "text-tool-text-chunked",
    chunks: true,
    script: ({ emit }) => {
      emit(text("Let me check. "));
      emit(toolRunning("c1", "read", { path: "/w/a.txt" }));
      emit(toolCompleted("c1", "read", "file contents"));
      emit(text("The answer is 42"));
      done(emit);
    },
  },
  {
    name: "tool-error",
    script: ({ emit }) => {
      emit(toolRunning("c1", "bash", { command: "false" }));
      emit(toolError("c1", "bash", "exit code 1"));
      emit(assistant("m1"));
      emit(text("It failed"));
      done(emit);
    },
  },
  {
    name: "tool-sensitive-and-large",
    script: ({ emit }) => {
      emit(toolRunning("c1", "mcp_probe", { token: "abc123", nested: { password: "hunter2", ok: 1 } }));
      emit(toolCompleted("c1", "mcp_probe", "x".repeat(120_000)));
      emit(text("done"));
      done(emit);
    },
  },
  {
    name: "parallel-tools",
    script: ({ emit }) => {
      emit(toolRunning("c1", "read", { path: "a" }));
      emit(toolRunning("c2", "grep", { pattern: "b" }));
      emit(toolCompleted("c2", "grep", "hit"));
      emit(toolCompleted("c1", "read", "A"));
      emit(text("both done"));
      done(emit);
    },
  },
  {
    name: "user-message-parts-ignored",
    script: ({ emit }) => {
      emit(userMessage("mu"));
      emit({ type: "message.part.updated", properties: { sessionID: "ses_1", delta: "SECRET USER TEXT", part: { type: "text", messageID: "mu", text: "x" } } });
      emit(assistant("m1"));
      emit({ type: "message.part.updated", properties: { sessionID: "ses_1", delta: "answer", part: { type: "text", messageID: "m1", text: "x" } } });
      done(emit);
    },
  },
  {
    name: "usage-repeated-message-updates",
    script: ({ emit }) => { emit(assistant("m1")); emit(assistant("m1")); emit(assistant("m1")); emit(text("ok")); done(emit); },
  },
  {
    name: "usage-ignores-incomplete-and-user",
    script: ({ emit }) => {
      emit(assistant("mu", { role: "user" }));
      emit(assistant("mp", { time: { created: 1_000 } }));
      emit(assistant("m1"));
      emit(text("ok"));
      done(emit);
    },
  },
  {
    name: "usage-cost-unreported",
    script: ({ emit }) => { emit(assistant("m1", { cost: undefined })); emit(text("ok")); done(emit); },
  },
  {
    name: "no-usage",
    script: ({ emit }) => { emit(text("hi")); done(emit); },
  },
  {
    name: "session-error",
    script: ({ emit }) => { emit(assistant("m1")); emit(text("partial")); emit(sessionError({ name: "ProviderAuthError", data: { message: "provider exploded" } })); },
  },
  {
    name: "session-error-no-detail",
    script: ({ emit }) => { emit({ type: "session.error", properties: { sessionID: "ses_1" } }); },
  },
  {
    name: "prompt-fails-connection",
    failPrompt: new Error("fetch failed: ECONNREFUSED"),
    script: () => {},
  },
  {
    name: "prompt-fails-other",
    failPrompt: new Error("boom"),
    script: () => {},
  },
  {
    name: "empty-text-falls-back-to-messages",
    script: ({ emit }) => { emit(assistant("m1")); done(emit); },
    messages: () => [
      { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "question" }] },
      { info: { role: "assistant", id: "a1" }, parts: [{ type: "text", text: "from the transcript" }, { type: "tool", tool: "x" }, { type: "text", text: "second part" }] },
    ],
  },
  {
    name: "no-text-at-all",
    script: ({ emit }) => { emit(assistant("m1")); done(emit); },
  },
  {
    name: "prompt-timeout-with-partial-text",
    promptTimeoutMs: 150,
    script: ({ emit }) => { emit(assistant("m1")); emit(text("partial answer")); },
  },
  {
    name: "prompt-timeout-without-text-uses-messages",
    promptTimeoutMs: 150,
    script: () => {},
    messages: () => [{ info: { role: "assistant", id: "a1" }, parts: [{ type: "text", text: "late answer" }] }],
  },
  {
    name: "events-disabled",
    events: false,
    script: ({ emit }) => { emit(assistant("m1")); emit(text("quiet")); done(emit); },
  },
  {
    name: "system-prompt-first-message",
    systemPrompt: "You are a pirate.",
    script: ({ emit }) => { emit(text("arr")); done(emit); },
  },
];

/** The config a scenario runs under. */
export function configFor(s: Scenario): any {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.events = s.events === false ? { enabled: false } : { enabled: true, transport: "a2a" };
  cfg.features.streamArtifactChunks = s.chunks === true;
  cfg.timeouts = { ...cfg.timeouts, prompt: s.promptTimeoutMs ?? 5_000 };
  cfg.logging = { level: "error" };
  if (s.systemPrompt) cfg.opencode.systemPrompt = s.systemPrompt;
  return cfg;
}
