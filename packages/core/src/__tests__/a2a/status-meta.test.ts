/**
 * `run.status({ meta })` (#124 e): a non-terminal status that carries metadata and NO text, so a provider that holds a task
 * open can publish `backgroundTasks` without a round's text appearing twice. Through the real `DefaultRequestHandler`.
 */

import { describe, it, expect } from "vitest";
import { createProviderTestServer, summarizeEvent, type CoreTaskRun, type ProviderExecutor } from "../../index.js";

function provider(body: (run: CoreTaskRun) => void | Promise<void>): ProviderExecutor {
  return {
    info: () => ({ id: "fake", displayName: "Fake", inputModes: ["text/plain"], outputModes: ["text/plain"] }),
    initialize: async () => {},
    shutdown: async () => {},
    async run(_req, run) {
      await body(run);
    },
  };
}

describe("run.status({ meta })", () => {
  it("publishes a working status with the metadata and no text; progress(text, meta) carries both (the difference)", async () => {
    const server = createProviderTestServer(
      provider((run) => {
        run.progress("round text", { viaProgress: true });
        run.status({ meta: { backgroundTasks: [{ id: "bg1" }] } });
        run.complete({ text: "done" });
      }),
    );
    const { events, error } = await server.stream({ text: "go" });
    expect(error).toBeUndefined();
    const statuses = events.map(summarizeEvent).filter((e) => e.k === "status");
    const viaProgress = statuses.find((s: any) => s.metaKeys.includes("viaProgress")) as any;
    const viaStatus = statuses.find((s: any) => s.metaKeys.includes("backgroundTasks")) as any;
    expect(viaProgress).toMatchObject({ state: "working", text: "round text" });
    expect(viaStatus).toMatchObject({ state: "working" });
    expect(viaStatus.text).toBeUndefined();
    const raw = events.map((e) => e.payload?.value).find((v) => v?.metadata?.backgroundTasks);
    expect(raw.metadata.backgroundTasks).toEqual([{ id: "bg1" }]);
  });

  it("an empty meta publishes nothing, and a call after the turn ended is dropped", async () => {
    let late: CoreTaskRun | undefined;
    const server = createProviderTestServer(
      provider((run) => {
        late = run;
        run.status({ meta: {} });
        run.complete({ text: "done" });
        run.status({ meta: { afterEnd: true } });
      }),
    );
    const { events } = await server.stream({ text: "go" });
    const statuses = events.map(summarizeEvent).filter((e) => e.k === "status") as any[];
    expect(statuses.filter((s) => s.state === "working")).toHaveLength(0); // nothing for the empty meta
    expect(statuses.some((s) => s.metaKeys.includes("afterEnd"))).toBe(false);
    expect(() => late!.status({ meta: { more: 1 } })).not.toThrow();
  });
});
