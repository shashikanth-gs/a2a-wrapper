import { describe, it, expect } from "vitest";
import { InputQueue } from "../claude/input-queue.js";
import type { SDKUserMessageLike } from "../claude/client-factory.js";

const msg = (t: string, extra: Partial<SDKUserMessageLike> = {}): SDKUserMessageLike => ({
  type: "user",
  parent_tool_use_id: null,
  message: { role: "user", content: t },
  ...extra,
});

describe("InputQueue", () => {
  it("yields what was pushed, in order, carrying uuid and priority", async () => {
    const q = new InputQueue();
    q.push(msg("do the thing"));
    q.push(msg("also", { uuid: "u1", priority: "next" }));
    const it0 = q[Symbol.asyncIterator]();

    expect((await it0.next()).value).toEqual(msg("do the thing"));
    expect((await it0.next()).value).toEqual(msg("also", { uuid: "u1", priority: "next" }));
  });

  it("parks after the last message and only ends once closed", async () => {
    const q = new InputQueue();
    q.push(msg("hi"));
    const it0 = q[Symbol.asyncIterator]();
    await it0.next();

    const pending = it0.next();
    const raced = await Promise.race([pending.then(() => "ended"), new Promise((r) => setTimeout(() => r("still-open"), 20))]);
    expect(raced).toBe("still-open");

    q.close();
    expect((await pending).done).toBe(true);
  });

  it("a message pushed while the consumer waits wakes it", async () => {
    const q = new InputQueue();
    const it0 = q[Symbol.asyncIterator]();
    const next = it0.next();
    expect(q.push(msg("late"))).toBe(true);
    expect((await next).value).toEqual(msg("late"));
  });

  it("close delivers what is already queued, then ends; nothing can be pushed after", async () => {
    const q = new InputQueue();
    q.push(msg("a"));
    q.close();
    expect(q.closed).toBe(true);
    expect(q.push(msg("b"))).toBe(false);
    const it0 = q[Symbol.asyncIterator]();
    expect((await it0.next()).value).toEqual(msg("a"));
    expect((await it0.next()).done).toBe(true);
  });

  it("return() (the SDK tearing the query down) ends a parked consumer", async () => {
    const q = new InputQueue();
    const it0 = q[Symbol.asyncIterator]();
    const pending = it0.next();
    await it0.return!();
    expect((await pending).done).toBe(true);
    expect(q.closed).toBe(true);
  });
});
