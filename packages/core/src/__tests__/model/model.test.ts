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
      { state: "held" },
      { state: "rejected", reason: "not-steerable", detail: "review turn" },
      { state: "rejected", reason: "some-future-reason" },
    ];
    const delivery: DeliveryResult[] = [...steer, { state: "interrupted" }];
    const abort: AbortOutcome = { stopped: "confirmed", session: "reusable" };
    const message: CoreMessage = {
      id: "m", role: "user", parts: [{ kind: "text", text: "x" }], from: ANONYMOUS_CALLER, delivery: "steer", at: "T",
    };
    const interaction: CoreInteraction = { id: "i", kind: "permission", title: "t" };
    const pending: PendingInteraction = {
      interaction, taskId: "t", contextId: "c", runId: "r", state: "pending", createdAt: "T", expiresAt: "T2", handle: "h",
    };
    const binding: ContextBinding = { contextId: "c", session: { ref: "s" }, updatedAt: "T" };
    const run: RunRecord = { runId: "r", taskId: "t", contextId: "c", state: "working", startedAt: "T" };
    const usage: CoreUsage = { scope: "cumulative", tokens: { input: 1 }, costUsd: null };
    expect([delivery.length, abort.stopped, message.delivery, pending.state, binding.contextId, run.state, usage.scope]).toEqual([
      5, "confirmed", "steer", "pending", "c", "working", "cumulative",
    ]);
  });
});
