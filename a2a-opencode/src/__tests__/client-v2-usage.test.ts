import { describe, it, expect } from "vitest";
import { OpenCodeClientV2 } from "../opencode/client-v2.js";
import { usageRecordFromMessage } from "../opencode/usage.js";

const client = () => new OpenCodeClientV2({ baseUrl: "http://127.0.0.1:1", healthCheckInterval: 0 });

describe("2.x step events become completed assistant messages (usage)", () => {
  const c = client();
  const names = new Map<string, string>();
  const starts = new Map<string, number>();
  const steps = new Map<string, { modelID?: string; providerID?: string; started?: number }>();
  const tr = (ev: unknown) => c.translateEvent(ev as never, names, starts, steps) as Array<Record<string, any>>;

  it("session.step.started is remembered, not emitted", () => {
    expect(
      tr({
        type: "session.step.started", created: 1_000,
        data: { sessionID: "s", assistantMessageID: "msg_1", model: { id: "big-pickle", providerID: "opencode" }, started: 1_000 },
      }),
    ).toEqual([]);
  });

  it("session.step.ended becomes a message.updated that yields a usage record", () => {
    const [e] = tr({
      type: "session.step.ended", created: 1_800,
      data: {
        sessionID: "s", assistantMessageID: "msg_1", finish: "stop",
        tokens: { input: 6398, output: 4, reasoning: 12, cache: { read: 1792, write: 0 } }, cost: 0,
      },
    });
    expect(e.type).toBe("message.updated");
    expect(e.properties.sessionID).toBe("s");
    expect(e.properties.info).toMatchObject({ id: "msg_1", role: "assistant", modelID: "big-pickle", providerID: "opencode", cost: 0 });

    // The provider turns it into the same record it builds for a 1.x message.
    expect(usageRecordFromMessage(e.properties.info)).toEqual({
      model: "opencode/big-pickle", inputTokens: 6398, outputTokens: 4, reasoningTokens: 12,
      cacheReadTokens: 1792, cacheWriteTokens: 0, durationMs: 800, timeToFirstTokenMs: null,
      cost: 0, apiEndpoint: null, initiator: null,
    });
  });

  it("still produces a record when the step start was not seen (model unknown)", () => {
    const fresh = new Map<string, { modelID?: string; providerID?: string; started?: number }>();
    const [e] = c.translateEvent(
      { type: "session.step.ended", created: 5, data: { sessionID: "s", assistantMessageID: "msg_x", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } } as never,
      names, starts, fresh,
    ) as Array<Record<string, any>>;
    const rec = usageRecordFromMessage(e.properties.info)!;
    expect(rec.inputTokens).toBe(1);
    expect(rec.model).toBe("");
  });
});
