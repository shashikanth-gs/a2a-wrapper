/**
 * Backend factory — picks the OpenCode 1.x or 2.x client for a server.
 *
 * Detection (apiVersion "auto"): OpenCode 2.x answers JSON on `GET /api/info`
 * (200, or 401/403 when a password is required); 1.x serves its web UI (HTML)
 * for unknown routes. If the server cannot be reached, 1.x is assumed so a
 * wrapper started before its OpenCode server keeps the historical behaviour.
 */

import type { OpenCodeBackend } from "./backend.js";
import { OpenCodeClientWrapper } from "./client.js";
import { OpenCodeClientV2 } from "./client-v2.js";
import { logger } from "../utils/logger.js";

const log = logger.child("backend");

export interface BackendOptions {
  baseUrl: string;
  apiVersion?: "auto" | "1" | "2";
  defaultDirectory?: string;
  username?: string;
  password?: string;
  healthCheckInterval?: number;
}

export type DetectedVersion = { kind: "v1" | "v2"; version?: string; reason: string };

/** Discard an unread response body so its socket is released promptly (avoids lingering handles). */
async function release(res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* already closed */ }
}

/** Probe a server to decide which API generation it speaks. */
export async function detectServerVersion(
  baseUrl: string,
  auth?: { username?: string; password?: string },
): Promise<DetectedVersion> {
  const headers: Record<string, string> = {};
  if (auth?.password) {
    headers["authorization"] = "Basic " + Buffer.from(`${auth.username || "opencode"}:${auth.password}`).toString("base64");
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/info`, { headers, signal: AbortSignal.timeout(5_000) });
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    if (isJson && (res.status === 401 || res.status === 403)) {
      await release(res);
      return { kind: "v2", reason: "/api/info requires authentication" };
    }
    if (isJson && res.ok) {
      const body = (await res.json()) as { version?: unknown };
      return { kind: "v2", version: typeof body.version === "string" ? body.version : undefined, reason: "/api/info answered JSON" };
    }
    await release(res);
    return { kind: "v1", reason: "/api/info did not answer JSON" };
  } catch (e) {
    return { kind: "v1", reason: `server unreachable (${(e as Error).message}); assuming 1.x` };
  }
}

/** Create the right backend for the configured (or detected) API generation. */
export async function createBackend(opts: BackendOptions): Promise<OpenCodeBackend> {
  const requested = opts.apiVersion ?? "auto";
  let kind: "v1" | "v2";
  if (requested === "1") kind = "v1";
  else if (requested === "2") kind = "v2";
  else {
    const detected = await detectServerVersion(opts.baseUrl, opts);
    kind = detected.kind;
    log.info("Detected OpenCode API generation", { kind, version: detected.version, reason: detected.reason });
  }

  if (kind === "v2") {
    return new OpenCodeClientV2({
      baseUrl: opts.baseUrl,
      defaultDirectory: opts.defaultDirectory,
      username: opts.username,
      password: opts.password,
      healthCheckInterval: opts.healthCheckInterval,
    });
  }
  return new OpenCodeClientWrapper({
    baseUrl: opts.baseUrl,
    defaultDirectory: opts.defaultDirectory,
    healthCheckInterval: opts.healthCheckInterval,
  });
}
