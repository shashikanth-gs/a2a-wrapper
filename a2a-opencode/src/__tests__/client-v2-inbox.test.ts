/**
 * The 2.x client's durable-inbox surface (prompt delivery and the inbox item it returns, interrupt without resume, listing and
 * cancelling parked items) and the error mapping the provider relies on (`SessionNotFoundError` is a 404). The SDK is replaced by
 * a recorder, so no server is needed.
 */

import { describe, expect, it } from "vitest";
import { OpenCodeClientV2 } from "../opencode/client-v2.js";
import { OpenCodeApiError, OpenCodeAuthError, isSessionNotFound } from "../opencode/backend.js";

function clientWith(sdk: Record<string, any>): OpenCodeClientV2 {
  const c = new OpenCodeClientV2({ baseUrl: "http://127.0.0.1:1", healthCheckInterval: 0 });
  (c as any).sdk = sdk;
  return c;
}

describe("prompts", () => {
  it("passes the delivery mode on and returns the inbox item the server admitted the prompt as", async () => {
    const calls: any[] = [];
    const c = clientWith({ session: { prompt: async (i: any) => (calls.push(i), { id: "msg_1", delivery: i.delivery ?? "steer" }) } });
    expect(await c.sessionPromptAsync("ses_1", { parts: [{ type: "text", text: "hi" }], delivery: "queue" })).toEqual({ inboxId: "msg_1", delivery: "queue" });
    expect(calls[0]).toMatchObject({ sessionID: "ses_1", text: "hi", delivery: "queue" });
    expect(await c.sessionPromptAsync("ses_1", { parts: [{ type: "text", text: "plain" }] })).toEqual({ inboxId: "msg_1", delivery: "steer" });
    expect(calls[1]).not.toHaveProperty("delivery");
  });

  it("a server that answers no item is an empty result", async () => {
    const c = clientWith({ session: { prompt: async () => undefined } });
    expect(await c.sessionPromptAsync("ses_1", { parts: [{ type: "text", text: "hi" }] })).toEqual({});
  });
});

describe("abort", () => {
  it("is an interrupt that does not resume parked inbox items", async () => {
    const calls: any[] = [];
    const c = clientWith({ session: { interrupt: async (i: any) => (calls.push(i), { interrupted: true }) } });
    expect(await c.sessionAbort("ses_1")).toBe(true);
    expect(calls).toEqual([{ sessionID: "ses_1", resume: false }]);
  });
});

describe("inbox", () => {
  it("lists the parked items as id, delivery and text", async () => {
    const c = clientWith({
      session: {
        inbox: {
          list: async () => [{ id: "m1", delivery: "queue", type: "user", payload: { text: "later" } }, { id: "m2", delivery: "steer", type: "compaction", payload: {} }],
        },
      },
    });
    expect(await c.inboxList("ses_1")).toEqual([{ id: "m1", delivery: "queue", text: "later" }, { id: "m2", delivery: "steer" }]);
  });

  it("cancels one item", async () => {
    const calls: any[] = [];
    const c = clientWith({ session: { inbox: { cancel: async (i: any) => void calls.push(i) } } });
    await c.inboxCancel("ses_1", "m1");
    expect(calls).toEqual([{ sessionID: "ses_1", inboxID: "m1" }]);
  });
});

describe("errors", () => {
  it("an unknown session (a tagged SessionNotFoundError) is a 404 the provider reads as session-not-found", async () => {
    const err = Object.assign(new Error("Session not found: ses_x"), { _tag: "SessionNotFoundError", sessionID: "ses_x" });
    const c = clientWith({ session: { get: async () => Promise.reject(err) } });
    const e = await c.sessionGet("ses_x").catch((x) => x);
    expect(e).toBeInstanceOf(OpenCodeApiError);
    expect(e.statusCode).toBe(404);
    expect(isSessionNotFound(e)).toBe(true);
  });

  it("an authentication failure stays an auth error, not a not-found", async () => {
    const c = clientWith({ session: { get: async () => Promise.reject(Object.assign(new Error("Unauthorized"), { _tag: "UnauthorizedError" })) } });
    const e = await c.sessionGet("ses_x").catch((x) => x);
    expect(e).toBeInstanceOf(OpenCodeAuthError);
    expect(isSessionNotFound(e)).toBe(false);
  });
});

describe("isSessionNotFound", () => {
  it("reads 1.x and 2.x not-found answers and nothing else", () => {
    expect(isSessionNotFound(new OpenCodeApiError("session.get: HTTP 404", 404, { name: "NotFoundError" }))).toBe(true);
    expect(isSessionNotFound(new OpenCodeApiError("x", 400, { name: "NotFoundError" }))).toBe(true);
    expect(isSessionNotFound(new OpenCodeApiError("x", 0, { _tag: "SessionNotFoundError" }))).toBe(true);
    expect(isSessionNotFound(new OpenCodeApiError("x", 500))).toBe(false);
    expect(isSessionNotFound(new Error("fetch failed"))).toBe(false);
    expect(isSessionNotFound(undefined)).toBe(false);
    expect(isSessionNotFound({ statusCode: 404 })).toBe(true);
  });
});
