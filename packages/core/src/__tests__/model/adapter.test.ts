/** A2A v1 adapter: parts, task state, messages, request, status/artifact/usage events. */
import { describe, it, expect } from "vitest";
import { Role, TaskState, TaskStatusUpdateEvent, TaskArtifactUpdateEvent, Message } from "@a2a-js/sdk";
import type { Part } from "@a2a-js/sdk";
import { RequestContext, ServerCallContext } from "@a2a-js/sdk/server";
import {
  CORE_STATE_META_KEY,
  DELIVERY_META_KEY,
  FILE_URI_META_KEY,
  UNKNOWN_PART_META_KEY,
  USAGE_META_KEY,
  fromA2AArtifact,
  fromA2AMessage,
  fromA2APart,
  fromA2ATaskState,
  fromStatusUpdate,
  classifyState,
  isInterruptedState,
  isRepresentableState,
  isTerminalState,
  coreRequestFromContext,
  callerFromContext,
  toA2AMessage,
  toA2APart,
  toA2ATaskState,
  toArtifactUpdate,
  toStatusUpdate,
  usageFromMetadata,
  usageToMetadata,
  type CorePart,
  type CoreUsage,
} from "../../index.js";

const textPart = (text: string, extra: Partial<Part> = {}): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: "",
  ...extra,
});

describe("parts", () => {
  it("round-trips text, with media type and meta", () => {
    const p: CorePart = { kind: "text", text: "hi", mediaType: "text/markdown", meta: { a: 1 } };
    expect(fromA2APart(toA2APart(p))).toEqual(p);
  });

  it("round-trips plain text with no optional fields", () => {
    const p: CorePart = { kind: "text", text: "hi" };
    expect(fromA2APart(toA2APart(p))).toEqual(p);
  });

  it("round-trips data of any JSON shape", () => {
    for (const data of [{ a: [1, 2] }, [1, "x"], "s", 7, true, null]) {
      const p: CorePart = { kind: "data", data, mediaType: "application/json", meta: { m: 1 } };
      expect(fromA2APart(toA2APart(p))).toEqual(p);
    }
  });

  it("maps a url file part", () => {
    const p: CorePart = { kind: "file", name: "a.pdf", mediaType: "application/pdf", uri: "https://x/a.pdf" };
    const wire = toA2APart(p);
    expect(wire.content).toEqual({ $case: "url", value: "https://x/a.pdf" });
    expect(wire.filename).toBe("a.pdf");
    expect(fromA2APart(wire)).toEqual(p);
  });

  it("maps a bytes file part to raw and back", () => {
    const p: CorePart = { kind: "file", name: "b.bin", bytes: new Uint8Array([1, 2, 3]) };
    const wire = toA2APart(p);
    expect(wire.content?.$case).toBe("raw");
    const back = fromA2APart(wire);
    expect(back.kind).toBe("file");
    expect([...(back as any).bytes]).toEqual([1, 2, 3]);
    expect((back as any).name).toBe("b.bin");
  });

  it("keeps the uri when a file has both bytes and uri", () => {
    const p: CorePart = { kind: "file", uri: "https://x/y", bytes: new Uint8Array([9]), meta: { k: 1 } };
    const wire = toA2APart(p);
    expect(wire.metadata?.[FILE_URI_META_KEY]).toBe("https://x/y");
    const back = fromA2APart(wire) as any;
    expect(back.uri).toBe("https://x/y");
    expect([...back.bytes]).toEqual([9]);
    expect(back.meta).toEqual({ k: 1 }); // reserved key removed
  });

  it("never emits an empty url: a url part with no value is kept as unknown, unchanged", () => {
    const empty = { content: { $case: "url", value: "" }, metadata: undefined, filename: "e.txt", mediaType: "text/plain" } as Part;
    const core = fromA2APart(empty);
    expect(core).toEqual({ kind: "unknown", raw: empty });
    expect(toA2APart(core)).toBe(empty);
    // A file part always has a source, so every file part core emits has a non-empty url or raw bytes.
    for (const p of [{ kind: "file", uri: "https://x/y" }, { kind: "file", bytes: new Uint8Array([1]) }] as CorePart[]) {
      const w = toA2APart(p);
      expect(w.content?.$case === "url" ? (w.content.value as string).length : 1).toBeGreaterThan(0);
    }
  });

  it("preserves an A2A part core cannot model as unknown, and emits it again unchanged", () => {
    const exotic = { content: { $case: "hologram", value: { x: 1 } }, metadata: { k: 1 }, filename: "", mediaType: "" } as unknown as Part;
    const core = fromA2APart(exotic);
    expect(core).toEqual({ kind: "unknown", raw: exotic });
    expect(toA2APart(core)).toBe(exotic);
  });

  it("treats a part with no content as unknown, not as empty text", () => {
    const empty = { content: undefined, metadata: undefined, filename: "", mediaType: "" } as Part;
    expect(fromA2APart(empty)).toEqual({ kind: "unknown", raw: empty });
  });

  it("round-trips an unknown part whose raw is arbitrary JSON via a marked data part", () => {
    for (const raw of [{ kind: "widget", n: 1 }, "str", 42, [1, 2], null]) {
      const wire = toA2APart({ kind: "unknown", raw });
      expect(wire.content?.$case).toBe("data");
      expect(wire.metadata?.[UNKNOWN_PART_META_KEY]).toBe(true);
      expect(fromA2APart(wire)).toEqual({ kind: "unknown", raw });
    }
  });

  it("does not confuse an ordinary data part with an unknown wrapper", () => {
    const wire = toA2APart({ kind: "data", data: { a: 1 } });
    expect(wire.metadata?.[UNKNOWN_PART_META_KEY]).toBeUndefined();
    expect(fromA2APart(wire)).toEqual({ kind: "data", data: { a: 1 } });
  });

  it("is safe on garbage input", () => {
    expect(fromA2APart(null as any)).toEqual({ kind: "unknown", raw: null });
    expect(fromA2APart("x" as any)).toEqual({ kind: "unknown", raw: "x" });
  });

  it("emits parts the SDK accepts (JSON round trip through the SDK codec)", () => {
    const msg = toA2AMessage(
      {
        id: "m1",
        role: "user",
        from: { id: "u", kind: "user" },
        at: "t",
        parts: [
          { kind: "text", text: "a" },
          { kind: "data", data: { b: 1 } },
          { kind: "file", uri: "https://x", name: "n" },
          { kind: "file", bytes: new Uint8Array([1, 2]) },
          { kind: "unknown", raw: { z: 1 } },
        ],
      },
      { taskId: "t1", contextId: "c1" },
    );
    const back = Message.fromJSON(JSON.parse(JSON.stringify(Message.toJSON(msg))));
    expect(back.parts.map((p) => p.content?.$case)).toEqual(["text", "data", "url", "raw", "data"]);
    const core = back.parts.map(fromA2APart);
    expect(core[4]).toEqual({ kind: "unknown", raw: { z: 1 } });
  });

  describe("v0.3 shapes (tolerated inbound)", () => {
    it("reads text, data and file parts", () => {
      expect(fromA2APart({ kind: "text", text: "t", metadata: { a: 1 } } as any)).toEqual({ kind: "text", text: "t", meta: { a: 1 } });
      expect(fromA2APart({ kind: "data", data: { d: 1 } } as any)).toEqual({ kind: "data", data: { d: 1 } });
      expect(fromA2APart({ kind: "file", file: { uri: "u", name: "n", mimeType: "m" } } as any)).toEqual({
        kind: "file", uri: "u", name: "n", mediaType: "m",
      });
      const b = fromA2APart({ kind: "file", file: { bytes: Buffer.from("hi").toString("base64") } } as any) as any;
      expect(Buffer.from(b.bytes).toString()).toBe("hi");
    });

    it("keeps unrecognised v0.3 kinds and malformed ones as unknown", () => {
      const weird = { kind: "video", url: "x" };
      expect(fromA2APart(weird as any)).toEqual({ kind: "unknown", raw: weird });
      const bad = { kind: "file", file: {} };
      expect(fromA2APart(bad as any)).toEqual({ kind: "unknown", raw: bad });
    });
  });
});

describe("task state", () => {
  const pairs: [string, TaskState][] = [
    ["submitted", TaskState.TASK_STATE_SUBMITTED],
    ["working", TaskState.TASK_STATE_WORKING],
    ["input-required", TaskState.TASK_STATE_INPUT_REQUIRED],
    ["auth-required", TaskState.TASK_STATE_AUTH_REQUIRED],
    ["completed", TaskState.TASK_STATE_COMPLETED],
    ["failed", TaskState.TASK_STATE_FAILED],
    ["canceled", TaskState.TASK_STATE_CANCELED],
    ["rejected", TaskState.TASK_STATE_REJECTED],
  ];

  it.each(pairs)("maps %s both ways", (core, v1) => {
    expect(toA2ATaskState(core)).toBe(v1);
    expect(fromA2ATaskState(v1)).toBe(core);
    expect(isRepresentableState(core)).toBe(true);
  });

  it("accepts v1 wire names and v0.3 strings inbound", () => {
    expect(fromA2ATaskState("TASK_STATE_INPUT_REQUIRED")).toBe("input-required");
    expect(fromA2ATaskState("input-required")).toBe("input-required");
    expect(toA2ATaskState("TASK_STATE_WORKING")).toBe(TaskState.TASK_STATE_WORKING);
  });

  it("maps UNSPECIFIED, UNRECOGNIZED, missing and unknown numbers to 'unknown'", () => {
    expect(fromA2ATaskState(TaskState.TASK_STATE_UNSPECIFIED)).toBe("unknown");
    expect(fromA2ATaskState(TaskState.UNRECOGNIZED)).toBe("unknown");
    expect(fromA2ATaskState(undefined)).toBe("unknown");
    expect(fromA2ATaskState(99)).toBe("unknown");
    expect(fromA2ATaskState("TASK_STATE_UNSPECIFIED")).toBe("unknown");
  });

  it("returns an unknown string state unchanged (open type) and never maps it to UNSPECIFIED outbound", () => {
    expect(fromA2ATaskState("paused")).toBe("paused");
    expect(toA2ATaskState("paused")).toBe(TaskState.TASK_STATE_WORKING);
    expect(toA2ATaskState("unknown")).toBe(TaskState.TASK_STATE_WORKING);
    expect(toA2ATaskState("constructor")).toBe(TaskState.TASK_STATE_WORKING); // prototype keys are not states
    expect(isRepresentableState("paused")).toBe(false);
    expect(isRepresentableState("constructor")).toBe(false);
    expect(fromA2ATaskState("constructor")).toBe("constructor");
  });

  it("classifyState makes callers handle unknown explicitly", () => {
    expect(classifyState("working")).toBe("active");
    expect(classifyState("submitted")).toBe("active");
    expect(classifyState("input-required")).toBe("interrupted");
    expect(classifyState("auth-required")).toBe("interrupted");
    for (const s of ["completed", "failed", "canceled", "rejected"]) expect(classifyState(s)).toBe("terminal");
    for (const s of ["unknown", "paused", "TASK_STATE_UNSPECIFIED", ""]) expect(classifyState(s)).toBe("unknown");
  });

  it("classifies terminal and interrupted states; unknown is neither", () => {
    for (const s of ["completed", "failed", "canceled", "rejected"]) {
      expect(isTerminalState(s)).toBe(true);
      expect(isInterruptedState(s)).toBe(false);
    }
    for (const s of ["input-required", "auth-required"]) {
      expect(isInterruptedState(s)).toBe(true);
      expect(isTerminalState(s)).toBe(false);
    }
    for (const s of ["submitted", "working", "unknown", "paused"]) {
      expect(isTerminalState(s)).toBe(false);
      expect(isInterruptedState(s)).toBe(false);
    }
  });
});

describe("messages", () => {
  const sdkMsg = (over: Partial<Message> = {}): Message => ({
    messageId: "m1", contextId: "c1", taskId: "t1", role: Role.ROLE_USER,
    parts: [textPart("hello")], metadata: undefined, extensions: [], referenceTaskIds: [], ...over,
  });

  it("converts an inbound message", () => {
    const m = fromA2AMessage(sdkMsg(), { at: "2026-01-01T00:00:00Z" });
    expect(m).toEqual({
      id: "m1", role: "user", parts: [{ kind: "text", text: "hello" }],
      from: { id: "anonymous", kind: "anonymous" }, at: "2026-01-01T00:00:00Z",
    });
  });

  it("maps the agent role, and an unspecified role to user", () => {
    expect(fromA2AMessage(sdkMsg({ role: Role.ROLE_AGENT })).role).toBe("agent");
    expect(fromA2AMessage(sdkMsg({ role: Role.ROLE_UNSPECIFIED })).role).toBe("user");
  });

  it("reads delivery from metadata, strips the key, ignores non-strings", () => {
    const steer = fromA2AMessage(sdkMsg({ metadata: { [DELIVERY_META_KEY]: "steer", k: 1 } }));
    expect(steer.delivery).toBe("steer");
    expect(steer.meta).toEqual({ k: 1 });
    const custom = fromA2AMessage(sdkMsg({ metadata: { [DELIVERY_META_KEY]: "teleport" } }));
    expect(custom.delivery).toBe("teleport"); // open enum round-trips
    expect(custom.meta).toBeUndefined();
    expect(fromA2AMessage(sdkMsg({ metadata: { [DELIVERY_META_KEY]: 5 } })).delivery).toBeUndefined();
  });

  it("round-trips through toA2AMessage", () => {
    const core = fromA2AMessage(sdkMsg({ metadata: { [DELIVERY_META_KEY]: "interrupt", x: 2 } }), { at: "T" });
    const wire = toA2AMessage(core, { taskId: "t1", contextId: "c1" });
    expect(wire.role).toBe(Role.ROLE_USER);
    expect(wire.taskId).toBe("t1");
    expect(wire.metadata).toEqual({ x: 2, [DELIVERY_META_KEY]: "interrupt" });
    expect(fromA2AMessage(wire, { at: "T" })).toEqual(core);
  });

  it("writes no delivery key when the caller stated none", () => {
    const wire = toA2AMessage({ id: "a", role: "agent", parts: [], from: { id: "x", kind: "agent" }, at: "T" });
    expect(wire.role).toBe(Role.ROLE_AGENT);
    expect(wire.metadata).toBeUndefined();
  });
});

describe("coreRequestFromContext", () => {
  const request = (message: Message, metadata?: Record<string, any>) =>
    ({ tenant: "", message, configuration: undefined, metadata }) as any;
  const userMessage: Message = {
    messageId: "m1", contextId: "c1", taskId: "t1", role: Role.ROLE_USER,
    parts: [textPart("do it"), { content: { $case: "data", value: { a: 1 } }, metadata: undefined, filename: "", mediaType: "" }],
    metadata: { parent_agent_id: "orchestrator", conversation_id: "conv-1", session_id: "s-1", propagated_metadata: { tenant: "x" } },
    extensions: ["urn:ext:one"], referenceTaskIds: [],
  };

  it("builds a request: input, ids, anonymous caller, correlation, extensions", () => {
    const sctx = new ServerCallContext();
    const ctx = new RequestContext(request(userMessage), "t1", "c1", sctx);
    const req = coreRequestFromContext(ctx, { runId: "run-1", eventId: "ev-1" });
    expect(req.runId).toBe("run-1");
    expect(req.taskId).toBe("t1");
    expect(req.contextId).toBe("c1");
    expect(req.input).toEqual([{ kind: "text", text: "do it" }, { kind: "data", data: { a: 1 } }]);
    expect(req.caller).toEqual({ id: "anonymous", kind: "anonymous" });
    expect(req.history).toEqual([]);
    expect(req.session).toBeUndefined();
    expect(req.correlation.eventId).toBe("ev-1");
    expect(req.correlation.parentAgentId).toBe("orchestrator");
    expect(req.correlation.trace).toMatchObject({ conversationId: "conv-1", sessionId: "s-1" });
    expect(req.correlation.metadata).toEqual({ tenant: "x" });
    expect(req.extensions.get("urn:ext:one")).toBe(true);
  });

  it("includes requested extensions, the bound session and the stored history", () => {
    const sctx = new ServerCallContext({ requestedExtensions: ["urn:ext:two"] });
    const task: any = {
      id: "t1", contextId: "c1", status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
      artifacts: [], metadata: undefined,
      history: [
        { messageId: "h1", contextId: "c1", taskId: "t1", role: Role.ROLE_USER, parts: [textPart("earlier")], metadata: undefined, extensions: [], referenceTaskIds: [] },
        { messageId: "h2", contextId: "c1", taskId: "t1", role: Role.ROLE_AGENT, parts: [textPart("reply")], metadata: undefined, extensions: [], referenceTaskIds: [] },
      ],
    };
    const ctx = new RequestContext(request(userMessage), "t1", "c1", sctx, task);
    const req = coreRequestFromContext(ctx, { runId: "r", session: { ref: "sess-9", meta: { a: 1 } } });
    expect(req.session).toEqual({ ref: "sess-9", meta: { a: 1 } });
    expect(req.extensions.has("urn:ext:two")).toBe(true);
    // Stored messages carry no sender and no time: neither is invented.
    expect(req.history.map((m) => [m.id, m.role, m.from, m.at])).toEqual([
      ["h1", "user", undefined, undefined],
      ["h2", "agent", undefined, undefined],
    ]);
    expect(req.history.every((m) => !("from" in m) && !("at" in m))).toBe(true);
    expect(typeof req.turnId).toBe("string");
    expect(typeof req.correlation.eventId).toBe("string");
  });

  it("derives an authenticated caller from the call context", () => {
    const user = { isAuthenticated: true, userName: "alice" };
    const ctx = new RequestContext(request(userMessage), "t1", "c1", new ServerCallContext({ user }));
    expect(callerFromContext(ctx)).toEqual({ id: "alice", kind: "user" });
    const anon = new RequestContext(request(userMessage), "t1", "c1", new ServerCallContext({ user: { isAuthenticated: false, userName: "" } }));
    expect(callerFromContext(anon).kind).toBe("anonymous");
  });

  it("lets the caller option override", () => {
    const ctx = new RequestContext(request(userMessage), "t1", "c1", new ServerCallContext());
    const req = coreRequestFromContext(ctx, { runId: "r", caller: { id: "svc", kind: "service" } });
    expect(req.caller).toEqual({ id: "svc", kind: "service" });
  });
});

describe("status updates", () => {
  it("builds a status update with a text message", () => {
    const ev = toStatusUpdate({ taskId: "t", contextId: "c", state: "working", text: "going", timestamp: "T" });
    expect(ev.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(ev.status?.timestamp).toBe("T");
    expect(ev.status?.message?.role).toBe(Role.ROLE_AGENT);
    expect(ev.status?.message?.parts[0]?.content).toEqual({ $case: "text", value: "going" });
    expect(ev.status?.message?.taskId).toBe("t");
    expect(ev.metadata).toBeUndefined();
  });

  it("builds a status with no message when no text or parts are given", () => {
    expect(toStatusUpdate({ taskId: "t", contextId: "c", state: "completed" }).status?.message).toBeUndefined();
    expect(toStatusUpdate({ taskId: "t", contextId: "c", state: "completed", text: "" }).status?.message).toBeUndefined();
  });

  it("produces events the SDK codec accepts, for every representable state", () => {
    for (const s of ["submitted", "working", "input-required", "auth-required", "completed", "failed", "canceled", "rejected"]) {
      const ev = toStatusUpdate({ taskId: "t", contextId: "c", state: s, text: "x" });
      const json = JSON.parse(JSON.stringify(TaskStatusUpdateEvent.toJSON(ev)));
      const back = TaskStatusUpdateEvent.fromJSON(json);
      expect(fromA2ATaskState(back.status?.state)).toBe(s);
    }
  });

  it("sends a state with no v1 equivalent as working, keeps it in versioned metadata and restores it", () => {
    const ev = toStatusUpdate({ taskId: "t", contextId: "c", state: "paused", metadata: { k: 1 } });
    expect(ev.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(ev.metadata).toEqual({ k: 1, [CORE_STATE_META_KEY]: "paused" });
    expect(CORE_STATE_META_KEY).toBe("urn:a2a-wrapper:core-state:v1");
    const back = fromStatusUpdate(ev);
    expect(back.state).toBe("paused");
    expect(back.metadata).toEqual({ k: 1 });
  });

  it("never puts TASK_STATE_UNSPECIFIED on the wire, whatever the core state", () => {
    for (const state of ["paused", "unknown", "", "TASK_STATE_UNSPECIFIED", "constructor", "working", "completed"]) {
      expect(toStatusUpdate({ taskId: "t", contextId: "c", state }).status?.state).not.toBe(TaskState.TASK_STATE_UNSPECIFIED);
    }
  });

  it("round-trips 'unknown' through working, and reads the old unversioned key and UNSPECIFIED wire state", () => {
    const ev = toStatusUpdate({ taskId: "t", contextId: "c", state: "unknown" });
    expect(ev.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(fromStatusUpdate(ev).state).toBe("unknown");
    const legacy = {
      taskId: "t", contextId: "c",
      status: { state: TaskState.TASK_STATE_UNSPECIFIED, message: undefined, timestamp: undefined },
      metadata: { "urn:a2a-wrapper:core-state": "paused", k: 1 },
    } as TaskStatusUpdateEvent;
    expect(fromStatusUpdate(legacy)).toMatchObject({ state: "paused", metadata: { k: 1 } });
  });

  it("ignores a carried state that contradicts the wire state", () => {
    const ev = toStatusUpdate({ taskId: "t", contextId: "c", state: "completed" });
    const forged = { ...ev, metadata: { [CORE_STATE_META_KEY]: "paused" } } as TaskStatusUpdateEvent;
    expect(fromStatusUpdate(forged).state).toBe("completed");
    const knownOnWorking = { ...ev, status: { ...ev.status!, state: TaskState.TASK_STATE_WORKING }, metadata: { [CORE_STATE_META_KEY]: "completed" } } as TaskStatusUpdateEvent;
    expect(fromStatusUpdate(knownOnWorking).state).toBe("working");
  });

  it("reads a status update back into core terms", () => {
    const ev = toStatusUpdate({ taskId: "t", contextId: "c", state: "failed", text: "boom", timestamp: "T" });
    const back = fromStatusUpdate(ev, { at: "A" });
    expect(back).toMatchObject({ taskId: "t", contextId: "c", state: "failed", timestamp: "T" });
    expect(back.message?.parts).toEqual([{ kind: "text", text: "boom" }]);
    expect(back.message?.role).toBe("agent");
  });
});

describe("artifacts", () => {
  it("builds an artifact update, generating an id when absent", () => {
    const ev = toArtifactUpdate("t", "c", { parts: [{ kind: "text", text: "out" }], name: "n" });
    expect(ev.artifact?.artifactId).toMatch(/[0-9a-f-]{36}/);
    expect(ev.artifact?.name).toBe("n");
    expect(ev.append).toBe(false);
    expect(ev.lastChunk).toBe(false);
  });

  it("round-trips an artifact, including chunk flags, meta and unknown parts", () => {
    const art = {
      id: "a1", name: "report", description: "d",
      parts: [{ kind: "text", text: "x" }, { kind: "unknown", raw: { q: 1 } }] as CorePart[],
      append: true, lastChunk: true, meta: { m: 1 },
    };
    const ev = toArtifactUpdate("t", "c", art);
    expect(ev.append).toBe(true);
    expect(ev.lastChunk).toBe(true);
    const wire = TaskArtifactUpdateEvent.fromJSON(JSON.parse(JSON.stringify(TaskArtifactUpdateEvent.toJSON(ev))));
    expect(fromA2AArtifact(wire.artifact!, { append: wire.append, lastChunk: wire.lastChunk })).toEqual(art);
  });
});

describe("usage", () => {
  it("round-trips through metadata, keeping null cost", () => {
    const u: CoreUsage = {
      scope: "cumulative", tokens: { input: 10, output: 5, cacheRead: 2 }, costUsd: null,
      contextWindow: { used: 100, limit: 1000 }, model: "m",
    };
    const meta = usageToMetadata(u);
    expect(Object.keys(meta)).toEqual([USAGE_META_KEY]);
    expect(usageFromMetadata(JSON.parse(JSON.stringify(meta)))).toEqual(u);
  });

  it("omits undefined cost and drops non-numeric token fields", () => {
    const meta = usageToMetadata({ scope: "delta", tokens: { input: 1, output: undefined } });
    expect((meta[USAGE_META_KEY] as any).costUsd).toBeUndefined();
    expect("costUsd" in (meta[USAGE_META_KEY] as any)).toBe(false);
    expect((meta[USAGE_META_KEY] as any).tokens).toEqual({ input: 1 });
  });

  it("rides on a status update and comes back", () => {
    const u: CoreUsage = { scope: "delta", tokens: { total: 3 }, costUsd: 0.01 };
    const ev = toStatusUpdate({ taskId: "t", contextId: "c", state: "working", metadata: usageToMetadata(u) });
    expect(usageFromMetadata(fromStatusUpdate(ev).metadata ?? ev.metadata)).toEqual(u);
  });

  it("rejects malformed usage metadata", () => {
    expect(usageFromMetadata(undefined)).toBeUndefined();
    expect(usageFromMetadata({})).toBeUndefined();
    expect(usageFromMetadata({ [USAGE_META_KEY]: { scope: "weird", tokens: {} } })).toBeUndefined();
    expect(usageFromMetadata({ [USAGE_META_KEY]: { scope: "delta" } })).toBeUndefined();
  });
});
