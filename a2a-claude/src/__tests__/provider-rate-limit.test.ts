import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@a2a-wrapper/core";
import type { SDKMessageLike } from "../claude/client-factory.js";
import { FakeClaudeClient } from "./helpers/fake-client.js";
import { serve, states, streamText, useWorkspace } from "./helpers/harness.js";

const ctx = useWorkspace();

/** The last status update of a stream: its state, text and metadata, as the wire carries them. */
function terminal(events: unknown[]): { text: string; metadata: Record<string, unknown> } {
  const updates = events.filter((e: any) => e.payload?.$case === "statusUpdate") as any[];
  const v = updates[updates.length - 1].payload.value;
  const part = v.status?.message?.parts?.[0]?.content;
  return { text: part?.$case === "text" ? part.value : "", metadata: v.metadata ?? {} };
}

/** The tracker drops a reset time that is not in the future, so the fixture is relative to now. */
const RESETS_AT = Date.now() + 3_600_000;
const RESETS_AT_ISO = new Date(RESETS_AT).toISOString();

const REJECTED: SDKMessageLike = {
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: RESETS_AT, utilization: 1 },
};

/** init -> assistant text -> rate limit rejection -> then hangs until aborted. */
function rateLimitedTurn() {
  return {
    messages: [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-test" },
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "partial" }] } },
      REJECTED,
    ] as SDKMessageLike[],
    hangAfter: true,
  };
}

describe("rate limit handling", () => {
  it("ends the turn as failed with reset details", async () => {
    const { server } = serve(ctx.config, [rateLimitedTurn()]);

    const { summary, events } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "failed"]);
    const end = terminal(events);
    expect(end.text).toContain("Rate limit reached (5-hour limit)");
    expect(end.text).toContain(RESETS_AT_ISO);
    expect(end.metadata).toMatchObject({ reason: "rate_limit", rateLimitType: "five_hour", utilization: 1, code: "rate_limit", retryable: true });
  });

  it("tears down the SDK subprocess by aborting the turn", async () => {
    const { server, client } = serve(ctx.config, [rateLimitedTurn()]);

    await streamText(server);

    expect(client.calls[0].options.abortController?.signal.aborted).toBe(true);
  });

  it("still ends as failed when the iterator teardown throws", async () => {
    // `break` awaits iterator.return(); a rejection there lands in the catch block, which must not discard an
    // already-detected rate limit.
    for (const teardownError of ["stream closed unexpectedly", "the stream was aborted"]) {
      const { server } = serve(ctx.config, [{ ...rateLimitedTurn(), throwOnReturn: teardownError }]);

      const { summary, events } = await streamText(server);

      expect(states(summary)).toEqual(["submitted", "working", "failed"]);
      expect(terminal(events).text).toContain("Rate limit reached (5-hour limit)");
      expect(terminal(events).metadata).toMatchObject({ reason: "rate_limit" });
    }
  });

  it("does not publish a response artifact for the interrupted turn", async () => {
    const { server } = serve(ctx.config, [rateLimitedTurn()]);

    const { summary } = await streamText(server);

    expect(summary.filter((e) => e.k === "artifact" && e.name === "response")).toHaveLength(0);
  });

  it("resumes the same Claude session on a new task after the failure", async () => {
    const { server, client } = serve(ctx.config, [
      rateLimitedTurn(),
      {
        messages: [
          { type: "system", subtype: "init", session_id: "sess-1", model: "claude-test" },
          { type: "result", subtype: "success", result: "done", session_id: "sess-1" },
        ] as SDKMessageLike[],
      },
    ]);

    await streamText(server, "one", "ctx-1");
    await streamText(server, "two", "ctx-1");

    expect(client.calls[1].options.resume).toBe("sess-1");
  });

  it("points the client at the contextId rather than the closed task", async () => {
    const { server } = serve(ctx.config, [rateLimitedTurn()]);

    const { events } = await streamText(server);

    expect(terminal(events).text).toContain("same contextId");
    expect(terminal(events).text).not.toContain("this task");
  });

  it("omits the reset clause when the SDK reports no reset time", async () => {
    const { server } = serve(ctx.config, [
      {
        messages: [
          { type: "system", subtype: "init", session_id: "s", model: "m" },
          { type: "assistant", error: "rate_limit", parent_tool_use_id: null, message: { content: [] } },
        ] as SDKMessageLike[],
        hangAfter: true,
      },
    ]);

    const { summary, events } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "failed"]);
    expect(terminal(events).text).toBe("Rate limit reached. Retry on the same contextId to continue this conversation.");
    expect(terminal(events).metadata).not.toHaveProperty("resetsAt");
  });

  it("lets a warning through without ending the turn", async () => {
    const { server } = serve(ctx.config, [
      {
        messages: [
          { type: "system", subtype: "init", session_id: "s", model: "m" },
          { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.9 } },
          { type: "result", subtype: "success", result: "finished anyway", session_id: "s" },
        ] as SDKMessageLike[],
      },
    ]);

    const { summary, events } = await streamText(server);

    expect(states(summary)).toEqual(["submitted", "working", "completed"]);
    expect(JSON.stringify(events)).toContain("finished anyway");
  });

  it("emits a rate_limit sideband event", async () => {
    ctx.config.events = { enabled: true } as typeof ctx.config.events;
    const captured: AgentEvent[] = [];
    const { server } = serve(ctx.config, [rateLimitedTurn()], {
      eventTransport: async (e: AgentEvent) => {
        captured.push(e);
      },
      client: new FakeClaudeClient([rateLimitedTurn()]),
    });

    await streamText(server);

    const rl = captured.filter((e) => e.eventType === "rate_limit");
    expect(rl).toHaveLength(1);
    expect(rl[0].data).toMatchObject({ status: "rejected", action: "ended_turn" });
  });

  it("terminates a streaming artifact that was already in flight", async () => {
    ctx.config.features.streamArtifactChunks = true;
    const { server } = serve(ctx.config, [
      {
        messages: [
          { type: "system", subtype: "init", session_id: "s", model: "m" },
          { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial " } } },
          REJECTED,
        ] as SDKMessageLike[],
        hangAfter: true,
      },
    ]);

    const { events } = await streamText(server);

    const arts = events.filter((e: any) => e.payload?.$case === "artifactUpdate" && e.payload.value.artifact.name === "response") as any[];
    expect(arts.length).toBeGreaterThan(1);
    expect(arts[arts.length - 1].payload.value.lastChunk).toBe(true);
  });
});
