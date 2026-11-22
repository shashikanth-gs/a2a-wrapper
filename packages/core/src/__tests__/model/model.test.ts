/** Domain types: SDK-free, no provider names, contract shape, and no existing export changed. */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../../index.js";
import {
  ABORT_FAILED_OUTCOME,
  ANONYMOUS_CALLER,
  CANCELED,
  TaskRunRegistry,
  type AbortOutcome,
  type CoreInteraction,
  type CoreMessage,
  type CoreRequest,
  type CoreTaskRun,
  type CoreUsage,
  type ContextBinding,
  type DeliveryResult,
  type PendingInteraction,
  type ProviderExecutor,
  type RunRecord,
  type SteerOutcome,
} from "../../index.js";

const modelDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "model");
const modelFiles = readdirSync(modelDir).filter((f) => f.endsWith(".ts"));

describe("model/ source", () => {
  it("has files to check", () => {
    expect(modelFiles.length).toBeGreaterThan(5);
  });

  it("never imports the SDK-importing executor module (the CANCELED symbol lives in model/)", () => {
    for (const f of modelFiles) {
      const src = readFileSync(join(modelDir, f), "utf8");
      expect(src, f).not.toMatch(/from\s+["']\.\.\/executor\//);
    }
  });

  it("never imports or mentions the A2A SDK (provider-facing types are SDK-free)", () => {
    for (const f of modelFiles) {
      const src = readFileSync(join(modelDir, f), "utf8");
      expect(src, f).not.toMatch(/@a2a-js\/sdk/);
    }
  });

  it("names no provider and declares no capability flags", () => {
    for (const f of modelFiles) {
      const code = readFileSync(join(modelDir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/copilot|claude|codex|opencode|antigravity/i);
      expect(code, f).not.toMatch(/\bsupports[A-Z]\w*|\bcan(Steer|Abort|Resume)\b/);
    }
  });
});

describe("public exports", () => {
  it("keeps every pre-existing export", () => {
    for (const name of [
      "TaskRunRegistry", "CANCELED", "DEFAULT_ABORT_TIMEOUT_MS", "TaskState", "publishStatus", "publishTask",
      "extractUserText", "createA2AServer", "buildAgentCard", "BaseSessionManager", "LlmUsageAccumulator",
    ]) {
      expect((core as Record<string, unknown>)[name], name).toBeDefined();
    }
  });

  it("exposes the new runtime values", () => {
    expect(ANONYMOUS_CALLER).toEqual({ id: "anonymous", kind: "anonymous" });
    expect(Object.isFrozen(ANONYMOUS_CALLER)).toBe(true);
    expect(ABORT_FAILED_OUTCOME).toEqual({ stopped: "unconfirmed", session: "discard" });
    expect(typeof core.isApproval).toBe("function");
    expect(typeof core.isTerminalState).toBe("function");
  });

  it("leaves TaskRunRegistry behaviour alone (still hands out its own TaskRun)", () => {
    const reg = new TaskRunRegistry();
    expect(typeof reg.begin).toBe("function");
    expect(typeof CANCELED).toBe("symbol");
  });
});

describe("contract shape (compile-checked)", () => {
  it("a minimal provider needs only info, initialize, run and shutdown", async () => {
    const calls: string[] = [];
    const minimal: ProviderExecutor = {
      info: () => ({ id: "p", displayName: "P", inputModes: ["text/plain"], outputModes: ["text/plain"] }),
      initialize: async () => {},
      run: async (_req: CoreRequest, run: CoreTaskRun) => {
        calls.push(run.taskId);
      },
      shutdown: async () => {},
    };
    // Optional handlers are simply absent: capabilities are handlers present.
    expect(minimal.steer).toBeUndefined();
    expect(minimal.abort).toBeUndefined();
    expect(minimal.abortOrphan).toBeUndefined();
    expect(minimal.reattach).toBeUndefined();
    expect(minimal.release).toBeUndefined();
    expect(minimal.info().inputModes).toEqual(["text/plain"]);
    expect(calls).toEqual([]);
  });

  it("outcomes and records have the designed shapes", () => {
    const steer: SteerOutcome[] = [
      { state: "inserted" },
      { state: "queued", handle: "q1" },
      { state: "rejected", reason: "not-steerable", detail: "review turn" },
      { state: "rejected", reason: "some-future-reason" },
    ];
    const delivery: DeliveryResult[] = [
      { state: "inserted", taskId: "t", messageId: "m" },
      { state: "queued", taskId: "t", messageId: "m", holder: "core", position: 2 },
      { state: "queued", taskId: "t", messageId: "m", holder: "provider" },
      { state: "interrupted", taskId: "t", messageId: "m" },
      { state: "rejected", taskId: "t", messageId: "m", reason: "no-active-turn", detail: "x" },
    ];
    const abort: AbortOutcome = { stopped: "confirmed", session: "reusable" };
    const message: CoreMessage = {
      id: "m", role: "user", parts: [{ kind: "text", text: "x" }], from: ANONYMOUS_CALLER, delivery: "steer", at: "T",
    };
    const interaction: CoreInteraction = { id: "i", kind: "permission", title: "t", options: [{ id: "a", label: "A", kind: "allow_once" }] };
    const header = { v: 1 as const, owner: { id: "u", kind: "user" }, createdAt: "T", updatedAt: "T" };
    const pending: PendingInteraction = {
      ...header, interaction, taskId: "t", contextId: "c", runId: "r", seq: 1, state: "presented", expiresAt: "T2", handle: "h",
    };
    const binding: ContextBinding = { ...header, contextId: "c", session: { ref: "s", issuer: "p@1" } };
    const run: RunRecord = {
      ...header, runId: "r", taskId: "t", contextId: "c", turnId: "u1", state: "working", startedAt: "T",
      cancel: { requestedAt: "T", by: "u", abort },
    };
    const usage: CoreUsage = { scope: "cumulative", series: "s", tokens: { input: 1 }, costUsd: null };
    expect([steer.length, delivery.length, abort.stopped, message.delivery, pending.state, binding.contextId, run.state, usage.scope]).toEqual([
      4, 5, "confirmed", "steer", "presented", "c", "working", "cumulative",
    ]);
  });

  it("a provider that queues a steer announces the held turn, or drops it, through the run", async () => {
    const turns: string[] = [];
    const ended: string[] = [];
    const makeRun = (turnId: string): CoreTaskRun => ({
      runId: "r", turnId, taskId: "t", contextId: "c",
      signal: new AbortController().signal as unknown as CoreTaskRun["signal"],
      progress() {}, event() {}, artifact() {},
      ask: async () => ({ outcome: "expired" }), bind() {}, race: async (w) => w,
      complete: () => void ended.push(`complete:${turnId}`), fail() {}, reject() {},
      beginHeldTurn: (handle) => { turns.push(`begin:${handle}`); return makeRun(`held-${handle}`); },
      dropHeld: (handle) => void turns.push(`drop:${handle}`),
    });
    const p: ProviderExecutor = {
      info: () => ({ id: "p", displayName: "P", inputModes: [], outputModes: [] }),
      initialize: async () => {},
      run: async () => {},
      steer: async () => ({ state: "queued", handle: "h1" }),
      shutdown: async () => {},
    };
    const run = makeRun("u1");
    expect(await p.steer!(run, { id: "m", role: "user", parts: [], from: ANONYMOUS_CALLER, at: "T" })).toEqual({ state: "queued", handle: "h1" });
    const held = run.beginHeldTurn("h1");
    expect(held.turnId).toBe("held-h1");
    expect(held.taskId).toBe(run.taskId); // same task
    held.complete({ text: "done" });
    run.dropHeld("h2");
    expect(turns).toEqual(["begin:h1", "drop:h2"]);
    expect(ended).toEqual(["complete:held-h1"]);
  });

  it("the abort signal carries a typed reason, and abortOrphan is told run, turn and reason", async () => {
    const reasons: (string | undefined)[] = [];
    const ac = new AbortController();
    const signal = ac.signal as unknown as CoreTaskRun["signal"];
    ac.abort("interrupt");
    reasons.push(signal.reason);
    expect(reasons).toEqual(["interrupt"]);
    const p: ProviderExecutor = {
      info: () => ({ id: "p", displayName: "P", inputModes: [], outputModes: [] }),
      initialize: async () => {}, run: async () => {}, shutdown: async () => {},
      abortOrphan: async (info) => {
        expect([info.runId, info.turnId, info.reason]).toEqual(["r", "u", "cancel"]);
        return { stopped: "confirmed", session: "discard" };
      },
    };
    await p.abortOrphan!({ runId: "r", turnId: "u", taskId: "t", contextId: "c", reason: "cancel" });
  });

  it("a provider can implement the revised handlers (abort takes a reason, abortOrphan returns an outcome)", async () => {
    const reasons: string[] = [];
    const p: ProviderExecutor = {
      info: () => ({ id: "p", displayName: "P", inputModes: [], outputModes: [] }),
      initialize: async () => {},
      run: async () => {},
      abort: async (_info, reason) => {
        reasons.push(reason);
        return { stopped: "confirmed", session: "reusable" };
      },
      abortOrphan: async () => ({ stopped: "unconfirmed", session: "discard" }),
      shutdown: async () => {},
    };
    const info = { runId: "r", turnId: "u", taskId: "t", contextId: "c" };
    await p.abort!(info, "interrupt");
    await p.abort!(info, "cancel");
    expect(reasons).toEqual(["interrupt", "cancel"]);
    expect(await p.abortOrphan!({ runId: "r", turnId: "u", taskId: "t", contextId: "c", reason: "shutdown" })).toEqual({ stopped: "unconfirmed", session: "discard" });
  });
});
