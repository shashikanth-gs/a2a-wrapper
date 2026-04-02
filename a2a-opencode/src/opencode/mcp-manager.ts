/**
 * MCP Server Manager
 *
 * Dynamically registers MCP servers with OpenCode at startup,
 * verifies they reach "connected" status, and provides runtime
 * status queries.
 */

import type { McpServerConfig } from "../config/types.js";
import type { OpenCodeClientWrapper } from "./client.js";
import { sleep } from "../utils/deferred.js";
import { logger } from "../utils/logger.js";

const log = logger.child("mcp-manager");

/** Result of registering a single MCP server. */
export interface McpRegistrationResult {
  name: string;
  status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration" | "unknown";
  error?: string;
}

/** Options for the registration process. */
export interface McpManagerOptions {
  /** Max retries when waiting for "connected" (default: 5) */
  maxRetries?: number;
  /** Initial delay between retries in ms (default: 1000) */
  retryDelay?: number;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY = 1_000;

/**
 * Register all configured MCP servers with OpenCode, then verify
 * each one reaches "connected" status.
 *
 * Returns per-server results. Never throws — failures are captured
 * in the result array.
 */
export async function registerMcpServers(
  client: OpenCodeClientWrapper,
  servers: Record<string, McpServerConfig>,
  directory?: string,
  opts?: McpManagerOptions,
): Promise<McpRegistrationResult[]> {
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    log.info("No MCP servers configured — skipping registration");
    return [];
  }

  log.info("╔══ MCP Registration Start ══════════════════════════════════╗");
  log.info("MCP servers to register", {
    count: entries.length,
    names: entries.map(([n]) => n),
    directory: directory || "(default)",
  });

  // Log full config for each server
  for (const [name, config] of entries) {
    log.info(`MCP server '${name}' config`, { config: JSON.stringify(config, null, 2) });
  }

  // Log pre-registration MCP status from OpenCode
  try {
    const preStatus = await client.mcpStatus(directory);
    log.info("MCP status BEFORE registration", { status: JSON.stringify(preStatus) });
  } catch (e) {
    log.warn("Could not get pre-registration MCP status", { error: (e as Error).message });
  }

  const results: McpRegistrationResult[] = [];

  for (const [name, config] of entries) {
    const result = await registerOne(client, name, config, directory, opts);
    results.push(result);
  }

  // Log post-registration MCP status from OpenCode
  try {
    const postStatus = await client.mcpStatus(directory);
    log.info("MCP status AFTER registration", { status: JSON.stringify(postStatus) });
  } catch (e) {
    log.warn("Could not get post-registration MCP status", { error: (e as Error).message });
  }

  const connected = results.filter((r) => r.status === "connected").length;
  const failed = results.filter((r) => r.status !== "connected" && r.status !== "disabled").length;
  log.info("MCP registration summary", {
    total: results.length,
    connected,
    failed,
    results: results.map((r) => ({ name: r.name, status: r.status, error: r.error })),
  });
  log.info("╚══ MCP Registration End ════════════════════════════════════╝");

  return results;
}

/**
 * Query the current status of all MCP servers known to OpenCode.
 */
export async function getMcpStatus(
  client: OpenCodeClientWrapper,
  directory?: string,
): Promise<Record<string, { status: string; error?: string }>> {
  const raw = await client.mcpStatus(directory) as Record<string, { status: string; error?: string }>;
  return raw;
}

// ─── Internal ───────────────────────────────────────────────────────────────

async function registerOne(
  client: OpenCodeClientWrapper,
  name: string,
  config: McpServerConfig,
  directory?: string,
  opts?: McpManagerOptions,
): Promise<McpRegistrationResult> {
  const label = config.type === "remote"
    ? `remote:${config.url}`
    : `local:${config.command.join(" ")}`;

  log.info(`── Registering MCP server '${name}' ──`, { type: config.type, target: label });

  // Log the exact payload being sent to OpenCode
  const addPayload = config as unknown as Record<string, unknown>;
  log.info(`MCP '${name}' — mcpAdd payload`, { payload: JSON.stringify(addPayload) });

  try {
    // 1. Add the server
    const addResult = await client.mcpAdd(name, addPayload, directory) as Record<string, { status: string; error?: string }> | undefined;
    log.info(`MCP '${name}' — mcpAdd succeeded`, { result: JSON.stringify(addResult) });

    // Check if the mcpAdd response already tells us the server is connected.
    // OpenCode returns the full MCP status map from mcpAdd, which includes
    // dynamically added servers — but mcp.status only returns config-file servers.
    if (addResult && typeof addResult === "object" && addResult[name]) {
      const addStatus = addResult[name];
      log.info(`MCP '${name}' — status from mcpAdd response`, { status: addStatus.status, error: addStatus.error });
      if (addStatus.status === "connected") {
        log.info(`MCP '${name}' — CONNECTED ✓ (confirmed from mcpAdd response)`);
        return { name, status: "connected" };
      }
      if (addStatus.status === "disabled") {
        log.info(`MCP '${name}' — DISABLED (from mcpAdd response)`);
        return { name, status: "disabled" };
      }
      if (addStatus.status === "needs_auth" || addStatus.status === "needs_client_registration") {
        log.warn(`MCP '${name}' — requires authentication (from mcpAdd response)`, { status: addStatus.status });
        return { name, status: addStatus.status as McpRegistrationResult["status"], error: addStatus.error };
      }
      if (addStatus.status === "failed") {
        log.error(`MCP '${name}' — FAILED (from mcpAdd response)`, { error: addStatus.error });
        return { name, status: "failed", error: addStatus.error };
      }
      // Status present but not terminal — fall through to polling
      log.info(`MCP '${name}' — non-terminal status from mcpAdd, will poll`, { status: addStatus.status });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`MCP '${name}' — mcpAdd FAILED`, { error: msg, stack: e instanceof Error ? e.stack : undefined });
    return { name, status: "failed", error: msg };
  }

  // 2. Wait for it to become connected
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelay = opts?.retryDelay ?? DEFAULT_RETRY_DELAY;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const status = await queryServerStatus(client, name, directory);
    log.info(`MCP '${name}' — status check attempt ${attempt}/${maxRetries}`, { status: JSON.stringify(status) });

    if (status.status === "connected") {
      log.info(`MCP '${name}' — CONNECTED ✓`, { attempts: attempt });
      return { name, status: "connected" };
    }

    if (status.status === "disabled") {
      log.info(`MCP '${name}' — DISABLED (config has enabled=false?)`);
      return { name, status: "disabled" };
    }

    // Terminal failure states
    if (status.status === "needs_auth" || status.status === "needs_client_registration") {
      log.warn(`MCP '${name}' — requires authentication`, { status: status.status, error: status.error });
      return { name, status: status.status as McpRegistrationResult["status"], error: status.error };
    }

    if (status.status === "failed" && attempt === maxRetries) {
      log.error(`MCP '${name}' — FAILED after ${maxRetries} attempts`, { error: status.error });
      return { name, status: "failed", error: status.error };
    }

    // Try explicit connect if not yet connected
    if (attempt === 1) {
      try {
        log.info(`MCP '${name}' — attempting explicit connect...`);
        await client.mcpConnect(name, directory);
        log.info(`MCP '${name}' — explicit connect call succeeded`);
      } catch (e) {
        log.warn(`MCP '${name}' — explicit connect failed`, { error: (e as Error).message });
      }
    }

    log.debug(`MCP '${name}' — waiting ${retryDelay}ms before retry`, { attempt, status: status.status });
    await sleep(retryDelay);
  }

  // Exhausted retries — return last known status
  const final = await queryServerStatus(client, name, directory);
  log.info(`MCP '${name}' — final status after all retries`, { status: JSON.stringify(final) });
  if (final.status === "connected") {
    log.info(`MCP '${name}' — CONNECTED (late) ✓`);
    return { name, status: "connected" };
  }
  log.error(`MCP '${name}' — did NOT reach connected state`, { status: final.status, error: final.error });
  return { name, status: final.status as McpRegistrationResult["status"], error: final.error };
}

async function queryServerStatus(
  client: OpenCodeClientWrapper,
  name: string,
  directory?: string,
): Promise<{ status: string; error?: string }> {
  try {
    const all = await client.mcpStatus(directory) as Record<string, { status: string; error?: string }>;
    const serverStatus = all[name] ?? { status: "unknown" };
    log.debug(`MCP '${name}' — queryServerStatus`, { found: !!all[name], status: serverStatus.status, allServers: Object.keys(all) });
    return serverStatus;
  } catch (e) {
    log.warn(`MCP '${name}' — queryServerStatus failed`, { error: e instanceof Error ? e.message : String(e) });
    return { status: "unknown", error: e instanceof Error ? e.message : String(e) };
  }
}
