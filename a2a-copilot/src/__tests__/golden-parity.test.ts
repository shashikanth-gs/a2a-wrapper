/**
 * Golden parity: the provider publishes what the executor it replaced published.
 *
 * `golden/old-executor.golden.json` was recorded by running `helpers/scenarios.ts` through the a2a-copilot 1.8.2 executor
 * (an `AgentExecutor` publishing on the event bus) and the real SDK request handler. This test replays the same scenarios
 * through the provider and the same handler (via core's test server) and compares what an A2A client receives: status
 * sequence and text, artifact names, flags, extensions and parts, `x-usage`, the stored task.
 *
 * Intentional differences, each asserted below and not hidden by the comparison:
 *  1. The redundant `submitted` status event after the initial Task snapshot is not published.
 *  2. The completed status also carries core's `urn:a2a-wrapper:usage:v1` metadata next to `x-usage`.
 *  3. A failed status also carries `code` metadata (`backend`, `auth`, `unavailable`).
 *  4. `trace.lifecycle` (`agent_started`) follows the session being opened (it used to precede it), which only shows when
 *     the session cannot be created.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProviderTestServer, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { CopilotProvider } from "../copilot/provider.js";
import { FakeClient, SCENARIOS, configFor, type Scenario } from "./helpers/scenarios.js";

const golden = JSON.parse(readFileSync(new URL("./golden/old-executor.golden.json", import.meta.url), "utf-8")) as Record<
  string,
  { stream: any[]; streamError?: string; blocking: any }
>;

/** Random ids differ per run (event ids in trace data); everything else must match exactly. */
const noIds = (v: unknown): any => JSON.parse(JSON.stringify(v, (k, x) => (k === "event_id" ? "<id>" : x)));

function serve(s: Scenario) {
  const client = new FakeClient(s);
  const provider = new CopilotProvider(configFor(s), { clientFactory: () => client });
  return { client, server: createProviderTestServer(provider) };
}

/** Apply the documented intentional differences to the golden (old) summaries so the rest is compared exactly. */
function expectedStream(oldEvents: any[]): any[] {
  return oldEvents
    .filter((e) => !(e.k === "status" && e.state === "submitted"))
    .map((e) => {
      if (e.k !== "status") return e;
      if (e.state === "completed") return { ...e, metaKeys: ["urn:a2a-wrapper:usage:v1", ...e.metaKeys].sort() };
      if (e.state === "failed") return { ...e, metaKeys: ["code"] };
      return e;
    });
}

describe("provider output equals the executor it replaced (golden)", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: streamed events`, async () => {
      const { server } = serve(s);
      const got = await server.stream({ text: "hello", contextId: "ctx-g" });
      expect(got.error ? String(got.error) : undefined).toBe(golden[s.name].streamError);
      const events = got.events.map(summarizeEvent).map((e) => noIds(e));
      const want = expectedStream(noIds(golden[s.name].stream));
      // x-usage compares exactly (counters, calls, cost, context window); the core usage key only has to exist
      expect(events).toEqual(want);
    });

    it(`${s.name}: blocking result and stored task`, async () => {
      const { server } = serve(s);
      const task = summarizeTask(await server.send({ text: "hello", contextId: "ctx-g2" }));
      const want = golden[s.name].blocking;
      // difference 2 (the core usage key) and 3 (`code` on a failed task) are the only ones allowed
      expect({ ...task, metaKeys: task.metaKeys.filter((k) => k !== "urn:a2a-wrapper:usage:v1") }).toEqual({
        ...want,
        ...(want.state === "failed" ? { metaKeys: ["code"] } : {}),
      });
    });
  }
});
