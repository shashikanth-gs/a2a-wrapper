/**
 * Golden parity: the provider publishes what the executor it replaced published.
 *
 * `golden/old-executor.golden.json` was recorded by running `helpers/scenarios.ts` through the a2a-claude 0.4.1 executor (an
 * `AgentExecutor` publishing on the event bus, on `integration/core-boundary-impl` at 4041054) and the real SDK request
 * handler. This test replays the same scripted Claude sessions through the provider and the same handler (via core's test
 * server) and compares what an A2A client receives: status sequence and text, artifact names, flags, extensions and parts
 * (including every trace artifact's data), `x-usage`, the stored task.
 *
 * Intentional differences, each applied below to the OLD recording (never hidden by a loose comparison):
 *  1. The redundant `submitted` status event after the initial Task snapshot is not published.
 *  2. The completed status also carries core's `urn:a2a-wrapper:usage:v1` metadata next to `x-usage`.
 *  3. A failed status also carries `code` metadata (`backend`, `timeout`, `rate_limit`) and, for a rate limit, `retryable`; the
 *     rate-limit details (`reason`, `rateLimitType`, `resetsAt`, ...) stay.
 *  4. `x-usage` cost is what the turn spent: `total_cost_usd` is a running total of the session, and the old executor reported
 *     it as the cost of every result, so a task that spans several results (held for background work) counted it once per
 *     result. Single-result tasks are unchanged (the first reading of a session is the cost of the turn).
 *  5. A task that FAILED after Claude reported a result (`error_*` results, a refusal, a timeout while held open) also carries
 *     what it spent, as `x-usage` and core's usage key on the failed status. The old executor recorded no usage from an error
 *     result, so that cost landed on the next successful task of the session.
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createProviderTestServer, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { ClaudeProvider } from "../claude/provider.js";
import { FakeClaudeClient } from "./helpers/fake-client.js";
import { SCENARIOS, configFor, type Scenario } from "./helpers/scenarios.js";

const golden = JSON.parse(readFileSync(new URL("./golden/old-executor.golden.json", import.meta.url), "utf-8")) as Record<
  string,
  { stream: any[]; streamError?: string; blocking: any }
>;

const ws = mkdtempSync(join(tmpdir(), "a2a-claude-golden-"));
afterAll(() => rmSync(ws, { recursive: true, force: true }));

/** Random ids differ per run (event ids in trace data); everything else must match exactly. */
const noIds = (v: unknown): any => JSON.parse(JSON.stringify(v, (k, x) => (k === "event_id" ? "<id>" : x)));

function serve(s: Scenario) {
  const client = new FakeClaudeClient([s.script]);
  const provider = new ClaudeProvider(configFor(s, ws), { clientFactory: () => client });
  return { client, server: createProviderTestServer(provider) };
}

/**
 * Difference 4. Every scripted result reports the same running total (0.0123), so the first result of a task cost 0.0123 and the
 * ones after it cost nothing more. The old executor recorded the running total as the cost of every result.
 */
function withTurnCosts(usage: any): any {
  if (!usage?.calls) return usage;
  const calls = usage.calls.map((c: any, i: number) => (i === 0 ? c : { ...c, cost: 0 }));
  const cost = calls.reduce((n: number, c: any) => n + (c.cost ?? 0), 0);
  return { ...usage, calls, cost: usage.cost === null ? null : Math.round(cost * 1e9) / 1e9 };
}

/** Scenarios whose failed status carries usage (difference 5): a result (or an earlier round) had been seen. */
const FAILED_WITH_USAGE = new Set(["error-max-turns", "error-during-execution", "model-refusal-no-fallback", "held-timeout", "held-error-result"]);

/** Difference 5 on a RECEIVED event: the failed status's usage is asserted here and removed, the rest is compared exactly. */
function withoutFailedUsage(name: string, events: any[]): any[] {
  return events.map((e) => {
    if (e.k !== "status" || e.state !== "failed" || !FAILED_WITH_USAGE.has(name)) return e;
    expect(e.usage?.llmCalls, `${name}: the failed status carries x-usage`).toBeGreaterThanOrEqual(1);
    // (the scripted error results carry no cost, so it is not reported; the dedicated tests cover a cost)
    expect(e.usage.cost === null || e.usage.cost >= 0, `${name}: the cost is not reported or not negative`).toBe(true);
    const { usage: _u, ...rest } = e;
    void _u;
    return rest;
  });
}

/** Apply the documented intentional differences to the golden (old) summaries so the rest is compared exactly. */
function expectedStream(name: string, oldEvents: any[]): any[] {
  return oldEvents
    .filter((e) => !(e.k === "status" && e.state === "submitted"))
    .map((e) => {
      if (e.k !== "status") return e;
      if (e.state === "completed") {
        const usage = e.usage ? withTurnCosts(e.usage) : e.usage;
        return { ...e, ...(usage ? { usage } : {}), metaKeys: ["urn:a2a-wrapper:usage:v1", ...e.metaKeys].sort() };
      }
      if (e.state === "failed") {
        const rate = e.metaKeys.includes("reason");
        const usage = FAILED_WITH_USAGE.has(name) ? ["x-usage", "urn:a2a-wrapper:usage:v1"] : [];
        return { ...e, metaKeys: [...new Set([...e.metaKeys, "code", ...usage, ...(rate ? ["retryable"] : [])])].sort() };
      }
      return e;
    });
}

describe("provider output equals the executor it replaced (golden)", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: streamed events`, async () => {
      const { server } = serve(s);
      const got = await server.stream({ text: "hello", contextId: "ctx-g" });
      expect(got.error ? String(got.error) : undefined).toBe(golden[s.name].streamError);
      const events = withoutFailedUsage(s.name, got.events.map(summarizeEvent).map((e) => noIds(e)));
      const want = expectedStream(s.name, noIds(golden[s.name].stream));
      expect(events).toEqual(want);
    });

    it(`${s.name}: blocking result and stored task`, async () => {
      const { server } = serve(s);
      const task = summarizeTask(await server.send({ text: "hello", contextId: "ctx-g2" }));
      const want = golden[s.name].blocking;
      expect({ ...task, metaKeys: task.metaKeys.filter((k: string) => k !== "urn:a2a-wrapper:usage:v1") }).toEqual({
        ...want,
        ...(want.state === "failed"
          ? {
              metaKeys: [
                ...new Set([
                  ...want.metaKeys,
                  "code",
                  ...(FAILED_WITH_USAGE.has(s.name) ? ["x-usage"] : []),
                  ...(want.metaKeys.includes("reason") ? ["retryable"] : []),
                ]),
              ].sort(),
            }
          : {}),
      });
    });
  }
});
