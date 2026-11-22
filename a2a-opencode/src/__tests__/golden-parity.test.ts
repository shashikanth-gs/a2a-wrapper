/**
 * Golden parity: the provider publishes what the executor it replaced published.
 *
 * `golden/old-executor.golden.json` was recorded by running `helpers/scenarios.ts` through the a2a-opencode 1.7.2 executor (an
 * `AgentExecutor` publishing on the event bus, on `integration/core-boundary-impl` at 0d58392) and the real SDK request handler.
 * This test replays the same scripted OpenCode sessions through the provider and the same handler (via core's test server), on a
 * 1.x and on a 2.x fake server, and compares what an A2A client receives: status sequence and text, artifact names, flags,
 * extensions and parts (including every trace artifact's data), the stored task, and the prompt the server was sent.
 *
 * Intentional differences, each applied below to the OLD recording (never hidden by a loose comparison):
 *  1. The redundant `submitted` status event after the initial Task snapshot is not published.
 *  2. The completed status now carries `x-usage` (the per-task usage summary, the same totals the `agent_finished` lifecycle event
 *     has always carried: asserted equal to it) and core's `urn:a2a-wrapper:usage:v1` metadata. The old executor published no usage
 *     metadata on the status at all.
 *  3. A failed status also carries `code` metadata (`backend`, `unavailable`).
 *  4. The measured duration of a tool call in its trace (`durationMs`) is wall-clock time: compared as a number, not as a value.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProviderTestServer, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { OpenCodeProvider } from "../opencode/provider.js";
import { FakeBackend } from "./helpers/fake-backend.js";
import { SCENARIOS, configFor, type Scenario } from "./helpers/scenarios.js";

const golden = JSON.parse(readFileSync(new URL("./golden/old-executor.golden.json", import.meta.url), "utf-8")) as Record<
  string,
  { stream: any[]; streamError?: string; blocking: any; prompts: any[] }
>;

/** Random ids and wall-clock durations differ per run; everything else must match exactly. */
const norm = (v: unknown): any =>
  JSON.parse(JSON.stringify(v, (k, x) => (k === "event_id" ? "<id>" : k === "durationMs" && typeof x === "number" && x < 1000 ? "<ms>" : x)));

function serve(s: Scenario, kind: "v1" | "v2") {
  const backend = new FakeBackend({
    kind,
    scripts: [s.script],
    ...(s.failPrompt ? { failPrompt: s.failPrompt } : {}),
    ...(s.messages ? { messages: s.messages } : {}),
  });
  const provider = new OpenCodeProvider(configFor(s), { backendFactory: async () => backend as never });
  return { backend, server: createProviderTestServer(provider) };
}

/** The `usage` of the `agent_finished` lifecycle artifact of the old recording (null when no call was made). */
function finishedUsage(oldEvents: any[]): any {
  const done = oldEvents.find((e) => e.k === "artifact" && e.name === "trace.lifecycle" && e.parts?.[0]?.data?.state === "finished");
  return done?.parts[0].data.usage ?? null;
}

const hasLifecycle = (oldEvents: any[]): boolean => oldEvents.some((e) => e.k === "artifact" && e.name === "trace.lifecycle");

/** Apply the documented intentional differences to the golden (old) summaries so the rest is compared exactly. */
function expectedStream(name: string, oldEvents: any[]): any[] {
  const usage = finishedUsage(oldEvents);
  return oldEvents
    .filter((e) => !(e.k === "status" && e.state === "submitted"))
    .map((e) => {
      if (e.k !== "status") return e;
      if (e.state === "completed") {
        // difference 2: x-usage is the summary the lifecycle event reports; with no call recorded it is the empty summary
        // (with events disabled the old recording has no lifecycle event to read it from: only its presence is compared)
        const x = hasLifecycle(oldEvents) ? usage ?? { __empty: true } : { __any: true };
        return { ...e, usage: x, metaKeys: ["urn:a2a-wrapper:usage:v1", "x-usage", ...e.metaKeys].sort() };
      }
      if (e.state === "failed") return { ...e, metaKeys: [...new Set([...e.metaKeys, "code"])].sort() };
      return e;
    });
}

/** The received completed status: an empty summary (no call recorded) is compared as `__empty`. */
function receivedStream(events: any[], lifecycle: boolean): any[] {
  return events.map((e) => {
    if (e.k === "status" && e.state === "completed" && e.usage) {
      if (!lifecycle) return { ...e, usage: { __any: true } };
      if (e.usage.llmCalls === 0) return { ...e, usage: { __empty: true } };
    }
    return e;
  });
}

for (const kind of ["v1", "v2"] as const) {
  describe(`provider output equals the executor it replaced (golden, ${kind} server)`, () => {
    for (const s of SCENARIOS) {
      it(`${s.name}: streamed events`, async () => {
        const { server, backend } = serve(s, kind);
        const got = await server.stream({ text: "hello", contextId: "ctx-g" });
        expect(got.error ? String(got.error) : undefined).toBe(golden[s.name].streamError);
        const events = receivedStream(got.events.map(summarizeEvent).map((e) => norm(e)), hasLifecycle(golden[s.name].stream));
        const want = expectedStream(s.name, norm(golden[s.name].stream));
        expect(events).toEqual(want);
        // The prompt the server was sent is what it always was (system prompt, model, agent included).
        expect(backend.prompts.map((p) => p.body.parts)).toEqual(golden[s.name].prompts);
      });

      it(`${s.name}: blocking result and stored task`, async () => {
        const { server } = serve(s, kind);
        const task = summarizeTask(await server.send({ text: "hello", contextId: "ctx-g2" }));
        const want = golden[s.name].blocking;
        expect({ ...task, metaKeys: task.metaKeys.filter((k: string) => k !== "urn:a2a-wrapper:usage:v1" && k !== "x-usage") }).toEqual({
          ...want,
          ...(want.state === "failed" ? { metaKeys: [...new Set([...want.metaKeys, "code"])].sort() } : {}),
        });
      });
    }
  });
}
