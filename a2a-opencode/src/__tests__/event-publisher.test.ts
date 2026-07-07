/**
 * Event publisher — publishTask metadata tests (Group 8 / Task 8.1)
 */

import { describe, it, expect, vi } from "vitest";
import { publishTask } from "../opencode/event-publisher.js";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";

function makeBus() {
  return { publish: vi.fn(), finished: vi.fn() } as unknown as ExecutionEventBus;
}

describe("publishTask", () => {
  it("publishes task event without metadata when none provided", () => {
    const bus = makeBus();
    publishTask(bus, "task-1", "ctx-1");
    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.kind).toBe("task");
    expect(event.id).toBe("task-1");
    expect(event.contextId).toBe("ctx-1");
    expect(event.metadata).toBeUndefined();
  });

  it("merges metadata.sessionCreated=true into task event when provided", () => {
    const bus = makeBus();
    publishTask(bus, "task-2", "ctx-2", { sessionCreated: true });
    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.metadata?.sessionCreated).toBe(true);
  });

  it("does not set sessionCreated when empty metadata object passed", () => {
    const bus = makeBus();
    publishTask(bus, "task-3", "ctx-3", {});
    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Empty metadata object — present but empty (per spec, no sessionCreated)
    expect(event.metadata?.sessionCreated).toBeUndefined();
  });
});
