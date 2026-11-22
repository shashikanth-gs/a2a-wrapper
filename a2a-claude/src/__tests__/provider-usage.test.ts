/**
 * Usage on the core contract (#124): the provider hands core the CUMULATIVE reading of each result (`total_cost_usd`,
 * `modelUsage`, series = the Claude session id) and core reports the per-turn delta. An error result's cost is that task's;
 * a resume whose baseline was lost reports nothing instead of the whole session total; a task spanning several results is
 * not double counted even with no binding (`session.reuseByContext: false`).
 */

import { describe, expect, it } from "vitest";
import { InMemoryRunStore, summarizeEvent } from "@a2a-wrapper/core";
import { init, result, text } from "./helpers/manual-client.js";
import { serve, streamText, useWorkspace } from "./helpers/harness.js";

const ctx = useWorkspace();

const turn = (sid: string, total: number, sub = "success") => ({
  messages: [
    init(sid),
    text("t"),
    sub === "success"
      ? result("t", { total_cost_usd: total, session_id: sid, usage: { input_tokens: 10, output_tokens: 1 }, modelUsage: { m1: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: total } } })
      : { type: "result", subtype: sub, errors: [], num_turns: 3, session_id: sid, total_cost_usd: total, usage: { input_tokens: 4, output_tokens: 2 } },
  ] as never,
});

const final = (summary: any[]) => summary.filter((e) => e.k === "status" && (e.state === "completed" || e.state === "failed")).pop() as any;
const cost = (summary: any[]) => final(summary).usage?.cost as number | null | undefined;

describe("usage of a result that ends in an error", () => {
  it("is the cost of THAT task (on its failed status), and the next task's cost is its own delta", async () => {
    const { server } = serve(ctx.config, [turn("s", 0.1), turn("s", 0.5, "error_max_budget_usd"), turn("s", 0.7)]);

    const a = await streamText(server, "1", "ctx-e");
    const b = await streamText(server, "2", "ctx-e");
    const c = await streamText(server, "3", "ctx-e");

    expect(cost(a.summary)).toBeCloseTo(0.1, 9);
    expect(final(b.summary)).toMatchObject({ state: "failed", metaKeys: expect.arrayContaining(["x-usage", "urn:a2a-wrapper:usage:v1", "code"]) });
    expect(cost(b.summary)).toBeCloseTo(0.4, 9); // what the failed task cost
    expect(final(b.summary).usage.inputTokens).toBe(4);
    expect(cost(c.summary)).toBeCloseTo(0.2, 9); // not 0.6: the error result's cost is not charged to the next task
  });

  it("a failure before any result carries no usage", async () => {
    const { server } = serve(ctx.config, [{ messages: [init("s")] as never, throwAfter: "boom" }]);
    const a = await streamText(server, "1", "ctx-e");
    expect(final(a.summary)).toMatchObject({ state: "failed" });
    expect(final(a.summary).metaKeys).not.toContain("x-usage");
  });
});

describe("a resume whose baseline was lost", () => {
  it("restart between the init bind and the first result: the resumed turn reports no cost (not the whole session total), the next is exact", async () => {
    const store = new InMemoryRunStore();
    const first = serve(ctx.config, [turn("s", 0.5)], { runStore: store });
    await streamText(first.server, "1", "ctx-w");
    await first.server.registry.drain();
    // the process died after the init bind and before the first result: the session is bound, no reading was kept
    const b = (await store.getBinding("ctx-w"))!;
    await store.putBinding({ ...b, usageBaseline: undefined });

    const second = serve(ctx.config, [turn("s", 0.8), turn("s", 0.9)], { runStore: store });
    const resumed = await streamText(second.server, "2", "ctx-w");
    expect(second.client.calls[0].options.resume).toBe("s");
    expect(cost(resumed.summary)).toBeNull(); // not 0.8: that total includes a turn this process never saw
    expect(final(resumed.summary)).toMatchObject({ state: "completed" });
    const next = await streamText(second.server, "3", "ctx-w");
    expect(cost(next.summary)).toBeCloseTo(0.1, 9);
  });

  it("the first turn of a context is fresh: its reading is the whole total, also on a context whose binding has no baseline yet", async () => {
    const { server } = serve(ctx.config, [turn("s-new", 0.25)]);
    expect(cost((await streamText(server, "1", "ctx-f")).summary)).toBeCloseTo(0.25, 9);
  });
});

describe("no binding (session.reuseByContext: false)", () => {
  it("a task that spans several results is not counted once per result", async () => {
    ctx.config.session.reuseByContext = false;
    const messages = [init("s"), { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", task_type: "shell", description: "bg" }] }, result("one", { total_cost_usd: 0.3, session_id: "s" }), { type: "system", subtype: "background_tasks_changed", tasks: [] }, result("two", { total_cost_usd: 0.5, session_id: "s" })] as never;
    const { server } = serve(ctx.config, [{ messages }]);
    const a = await streamText(server, "1", "ctx-n");
    const done = a.events.map(summarizeEvent).filter((e: any) => e.k === "status" && e.state === "completed").pop() as any;
    expect(done.usage.cost).toBeCloseTo(0.5, 9); // 0.3 + 0.2, not 0.3 + 0.5
  });
});
