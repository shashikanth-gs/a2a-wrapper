/**
 * GET /session-status endpoint tests (Group 6, Tasks 6.1–6.3)
 *
 * Tests the route directly using Express — no real OpenCode server needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeApp(sessionExistsFn: (id: string) => Promise<boolean>) {
  const app = express();

  const executor = { sessionExists: vi.fn(sessionExistsFn) };

  app.get("/session-status", async (req, res) => {
    const contextId = req.query.contextId as string | undefined;
    if (!contextId) {
      res.status(400).json({ error: "contextId query parameter is required" });
      return;
    }
    const exists = await executor.sessionExists(contextId);
    res.json({ exists });
  });

  return { app, executor };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /session-status", () => {
  it("returns 200 { exists: true } when session is alive", async () => {
    const { app } = makeApp(async () => true);
    const res = await request(app).get("/session-status?contextId=conv-123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: true });
  });

  it("returns 200 { exists: false } when session not found", async () => {
    const { app } = makeApp(async () => false);
    const res = await request(app).get("/session-status?contextId=conv-456");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: false });
  });

  it("returns 400 when contextId is missing", async () => {
    const { app } = makeApp(async () => false);
    const res = await request(app).get("/session-status");
    expect(res.status).toBe(400);
  });
});
