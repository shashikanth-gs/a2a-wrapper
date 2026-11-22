/**
 * Golden parity: the provider publishes what the executor it replaced published.
 *
 * `golden/old-executor.golden.json` was recorded by running `helpers/scenarios.ts` through the a2a-codex 1.7.2 executor (an
 * `AgentExecutor` publishing on the event bus) and the real SDK request handler. This test replays the same scenarios through
 * the provider and the same handler (via core's test server) and compares what an A2A client receives: status sequence and
 * text, artifact names, flags, extensions and parts, `x-usage`, the stored task.
 *
 * Intentional differences, each asserted below and not hidden by the comparison:
 *  1. The redundant `submitted` status event after the initial Task snapshot is not published.
 *  2. The completed status also carries core's `urn:a2a-wrapper:usage:v1` metadata next to `x-usage`.
 *  3. A failed status also carries `code` metadata (`backend`, `auth`, `rate_limit`, `unavailable`).
 *  4. A turn that ends with a thrown error closes its lifecycle with one `agent_error` (`trace.lifecycle`) event, which the
 *     old executor never emitted for a thrown error (it only did for a `turn.failed` event).
 *  5. A stream that reports `turn.failed` and then ends cleanly FAILS the task with the turn's error (the old executor completed
 *     it with an empty answer).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProviderTestServer, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { CodexProvider } from "../codex/provider.js";
import { FakeClient, SCENARIOS, configFor, type Scenario } from "./helpers/scenarios.js";

const golden = JSON.parse(readFileSync(new URL("./golden/old-executor.golden.json", import.meta.url), "utf-8")) as Record<
  string,
  { stream: any[]; streamError?: string; blocking: any }
>;

/** Random ids differ per run (event ids in trace data); everything else must match exactly. */
const noIds = (v: unknown): any => JSON.parse(JSON.stringify(v, (k, x) => (k === "event_id" ? "<id>" : x)));

function serve(s: Scenario) {
  const client = new FakeClient(s);
  const provider = new CodexProvider(configFor(s), { clientFactory: () => client });
  return { client, server: createProviderTestServer(provider) };
}

/** Scenarios whose outcome is a documented difference rather than an equal result (asserted in their own tests below). */
const DIFFERENT = new Set(["turn-failed-event"]);
/** Scenarios whose stream throws: the new provider closes the lifecycle with `agent_error` (difference 4). */
const THROWS = new Set(["cli-exits-nonzero", "cli-cannot-spawn"]);

/** Apply the documented intentional differences to the golden (old) summaries so the rest is compared exactly. */
function expectedStream(name: string, oldEvents: any[]): any[] {
  const out = oldEvents
    .filter((e) => !(e.k === "status" && e.state === "submitted"))
    .map((e) => {
      if (e.k !== "status") return e;
      if (e.state === "completed") return { ...e, metaKeys: ["urn:a2a-wrapper:usage:v1", ...e.metaKeys].sort() };
      if (e.state === "failed") return { ...e, metaKeys: ["code"] };
      return e;
    });
  if (THROWS.has(name)) {
    // the closing lifecycle event goes before the failed status
    const at = out.findIndex((e) => e.k === "status" && e.state === "failed");
    out.splice(at, 0, { k: "artifact", name: "trace.lifecycle", append: false, lastChunk: true, parts: [expect.anything()], extensions: ["urn:x-a2a:trace:v1"], metaKeys: ["eventId", "timestamp", "traceType"], traceType: "trace.lifecycle" });
  }
  return out;
}

describe("provider output equals the executor it replaced (golden)", () => {
  for (const s of SCENARIOS.filter((x) => !DIFFERENT.has(x.name))) {
    it(`${s.name}: streamed events`, async () => {
      const { server } = serve(s);
      const got = await server.stream({ text: "hello", contextId: "ctx-g" });
      expect(got.error ? String(got.error) : undefined).toBe(golden[s.name].streamError);
      const events = got.events.map(summarizeEvent).map((e) => noIds(e));
      expect(events).toEqual(expectedStream(s.name, noIds(golden[s.name].stream)));
    });

    it(`${s.name}: blocking result and stored task`, async () => {
      const { server } = serve(s);
      const task = summarizeTask(await server.send({ text: "hello", contextId: "ctx-g2" }));
      const want = golden[s.name].blocking;
      // differences 2 (the core usage key), 3 (`code` on a failed task) and 4 are the only ones allowed
      expect({ ...task, metaKeys: task.metaKeys.filter((k) => k !== "urn:a2a-wrapper:usage:v1") }).toEqual({
        ...want,
        ...(want.state === "failed" ? { metaKeys: ["code"] } : {}),
        // difference 4: the closing `agent_error` is one more stored trace artifact
        ...(THROWS.has(s.name) ? { artifacts: [...want.artifacts, { name: "trace.lifecycle", text: "", parts: 1 }] } : {}),
      });
    });
  }

  it("turn-failed-event: the old executor completed with an empty answer, the provider fails with the turn's error (difference 5)", async () => {
    expect(golden["turn-failed-event"].blocking.state).toBe("completed");
    const { server } = serve(SCENARIOS.find((x) => x.name === "turn-failed-event")!);
    const task = summarizeTask(await server.send({ text: "hello", contextId: "ctx-g3" }));
    expect(task.state).toBe("failed");
    expect(task.text).toBe("model overloaded");
  });
});
