/**
 * The A2A pieces of steering that need no request handler: the wire form of a DeliveryResult and which bus
 * `RunEventBusManager` hands to which request (design doc 3.12).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Role, TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import {
  DELIVERY_RESULT_META_KEY,
  RunEventBusManager,
  RunRegistry,
  WIRE_EXTENSIONS,
  agentExtensionDeclarations,
  deliveryResultFromMetadata,
  deliveryResultText,
  deliveryResultToMetadata,
  fromA2AMessage,
  toDeliveryAckMessage,
  toStatusUpdate,
  type DeliveryResult,
} from "../../index.js";
import { isPrivateBus, takeReplyClaim } from "../../a2a/bus-manager.js";
import { makeInit, makeProvider, tick } from "../runtime/harness.js";

afterEach(() => {
  vi.useRealTimers();
});

const results: DeliveryResult[] = [
  { state: "inserted", taskId: "t", messageId: "m" },
  { state: "queued", taskId: "t", messageId: "m", holder: "core", position: 2 },
  { state: "queued", taskId: "t", messageId: "m", holder: "core", position: 1, reason: "steer-unsupported: the provider has no steer handler" },
  { state: "queued", taskId: "t", messageId: "m", holder: "provider" },
  { state: "interrupted", taskId: "t", messageId: "m" },
  { state: "rejected", taskId: "t", messageId: "m", reason: "not-steerable", detail: "compacting" },
];

describe("DeliveryResult on the wire", () => {
  it("is a versioned message-metadata key, declared in WIRE_EXTENSIONS and optional on the agent card", () => {
    expect(DELIVERY_RESULT_META_KEY).toBe("urn:a2a-wrapper:delivery-result:v1");
    expect(WIRE_EXTENSIONS.map((e) => e.uri)).toContain(DELIVERY_RESULT_META_KEY);
    expect(agentExtensionDeclarations({ only: [DELIVERY_RESULT_META_KEY] })).toEqual([
      expect.objectContaining({ uri: DELIVERY_RESULT_META_KEY, required: false, params: { kind: "metadata-key" } }),
    ]);
  });

  it("round-trips every state through metadata (JSON-safe), and ignores anything that is not a delivery result", () => {
    for (const r of results) {
      const meta = deliveryResultToMetadata(r);
      expect(deliveryResultFromMetadata(JSON.parse(JSON.stringify(meta)))).toEqual(r);
    }
    expect(deliveryResultFromMetadata(undefined)).toBeUndefined();
    expect(deliveryResultFromMetadata({})).toBeUndefined();
    expect(deliveryResultFromMetadata({ [DELIVERY_RESULT_META_KEY]: "queued" })).toBeUndefined();
    expect(deliveryResultFromMetadata({ [DELIVERY_RESULT_META_KEY]: { state: "queued" } })).toBeUndefined();
  });

  it("renders a human line for every state, for a client that ignores the metadata", () => {
    expect(deliveryResultText(results[0])).toMatch(/added to the running turn/);
    expect(deliveryResultText(results[1])).toMatch(/position 2/);
    expect(deliveryResultText(results[2])).toMatch(/steer-unsupported/);
    expect(deliveryResultText(results[3])).toMatch(/provider's queue/);
    expect(deliveryResultText(results[4])).toMatch(/interrupted/);
    expect(deliveryResultText(results[5])).toMatch(/not delivered: not-steerable \(compacting\)/);
  });

  it("the answer to a message is an agent Message for the task, carrying the result and its text", () => {
    const m = toDeliveryAckMessage(results[1], { taskId: "t", contextId: "c" });
    expect(m).toMatchObject({ taskId: "t", contextId: "c", role: Role.ROLE_AGENT });
    expect(m.parts[0].content).toEqual({ $case: "text", value: expect.stringMatching(/queued/) });
    expect(deliveryResultFromMetadata(m.metadata)).toEqual(results[1]);
    expect(toDeliveryAckMessage(results[1], { taskId: "t", contextId: "c" }).messageId).not.toBe(m.messageId); // a fresh id each time
  });

  it("a status update can carry metadata on its MESSAGE (not only on the event)", () => {
    const e = toStatusUpdate({ taskId: "t", contextId: "c", state: "working", text: "hi", messageMetadata: deliveryResultToMetadata(results[4]) });
    expect(e.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(deliveryResultFromMetadata(e.status?.message?.metadata)).toEqual(results[4]);
    expect(e.metadata).toBeUndefined();
  });

  it("the inbound delivery is read from the message metadata (core key, legacy key, steering alias) and the sender is the caller", () => {
    const base = { messageId: "m", contextId: "c", taskId: "t", role: Role.ROLE_USER, parts: [], extensions: [], referenceTaskIds: [] };
    expect(fromA2AMessage({ ...base, metadata: { "urn:a2a-wrapper:delivery:v1": "steer" } } as never).delivery).toBe("steer");
    expect(fromA2AMessage({ ...base, metadata: { "urn:a2a-wrapper:delivery": "interrupt" } } as never).delivery).toBe("interrupt");
    expect(fromA2AMessage({ ...base, metadata: { "https://a2a-protocol.org/extensions/steering/v1/control": { mode: "steer" } } } as never).delivery).toBe("steer");
    expect(fromA2AMessage({ ...base, metadata: undefined } as never).delivery).toBeUndefined();
    expect(fromA2AMessage({ ...base, metadata: undefined } as never, { from: { id: "u1", kind: "user" } }).from).toEqual({ id: "u1", kind: "user" });
  });
});

describe("RunEventBusManager: which request gets which bus", () => {
  const ctx = () => new ServerCallContext();

  async function setup(mode: "auto" | "ask" = "auto") {
    const provider = makeProvider();
    const registry = new RunRegistry({ provider, interactionPolicy: { mode }, logger: { warn: vi.fn() } });
    const manager = new RunEventBusManager(registry);
    const start = async () => {
      void registry.execute(makeInit("t1"));
      for (let i = 0; i < 100 && provider.runs.length === 0; i++) await tick();
      return provider.runs[0];
    };
    return { provider, registry, manager, start };
  }

  it("the first request of a task gets the shared bus, and so does every request while the task is not live", async () => {
    const { manager } = await setup();
    const a = manager.createOrGetByTaskId("t1", ctx());
    expect(isPrivateBus(a)).toBe(false);
    expect(manager.createOrGetByTaskId("t1", ctx())).toBe(a); // not live: the SDK's own behaviour
  });

  it("a message to a WORKING task gets a private bus of its own, every time, and the shared bus is untouched", async () => {
    const { manager, start } = await setup();
    const shared = manager.createOrGetByTaskId("t1", ctx());
    await start();
    const b1 = manager.createOrGetByTaskId("t1", ctx());
    const b2 = manager.createOrGetByTaskId("t1", ctx());
    expect(isPrivateBus(b1)).toBe(true);
    expect(b1).not.toBe(shared);
    expect(b2).not.toBe(b1);
    expect(manager.getByTaskId("t1", ctx())).toBe(shared); // resubscribe and cancel still find the task's own bus
  });

  it("settleByTaskId keeps the bus while the task is live, private or not, and declines when it is not", async () => {
    const { manager, registry, start } = await setup();
    const shared = manager.createOrGetByTaskId("t1", ctx());
    expect(manager.settleByTaskId("t1", shared, undefined, ctx())).toBe(false);
    const call = await start();
    expect(manager.settleByTaskId("t1", shared, undefined, ctx())).toBe(true);
    expect(manager.settleByTaskId("t1", manager.createOrGetByTaskId("t1", ctx()), undefined, ctx())).toBe(true);
    call.view.complete({ text: "done" });
    await registry.drain();
    expect(manager.settleByTaskId("t1", shared, undefined, ctx())).toBe(false);
  });

  it("a PARKED task: exactly one request takes the reply claim and the shared bus, the others get private buses", async () => {
    const { manager, registry, start } = await setup("ask");
    const call = await start();
    void call.view.ask({ kind: "confirm", title: "ok?" });
    await vi.waitFor(() => expect(registry.isParked("t1")).toBe(true));

    const c1 = ctx();
    const c2 = ctx();
    const first = manager.createOrGetByTaskId("t1", c1);
    const second = manager.createOrGetByTaskId("t1", c2);
    expect(isPrivateBus(first)).toBe(false);
    expect(takeReplyClaim(c1)).toBe(true);
    expect(takeReplyClaim(c1)).toBe(false); // consumed
    expect(isPrivateBus(second)).toBe(true);
    expect(takeReplyClaim(c2)).toBe(false);
    registry.endReply("t1");
    expect(isPrivateBus(manager.createOrGetByTaskId("t1", ctx()))).toBe(false); // released: the next one may carry it
  });

  it("a claim whose request never reached execute() goes stale, so the park cannot be wedged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { manager, registry, start } = await setup("ask");
    const call = await start();
    void call.view.ask({ kind: "confirm", title: "ok?" });
    await vi.waitFor(() => expect(registry.isParked("t1")).toBe(true));
    const c1 = ctx();
    manager.createOrGetByTaskId("t1", c1); // claimed, and its execute() never runs
    expect(isPrivateBus(manager.createOrGetByTaskId("t1", ctx()))).toBe(true);
    vi.setSystemTime(Date.now() + 16_000);
    const c3 = ctx();
    expect(isPrivateBus(manager.createOrGetByTaskId("t1", c3))).toBe(false);
    expect(takeReplyClaim(c3)).toBe(true);
  });
});
