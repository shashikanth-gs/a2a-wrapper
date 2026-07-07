/**
 * Configuration Loader
 *
 * Loads agent configuration from:
 *  1. JSON file (--config path)
 *  2. Environment variable overrides
 *  3. CLI argument overrides
 *
 * Merges in order: defaults ← JSON file ← env vars ← CLI args
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { substituteEnvTokensInString, substituteEnvTokensInRecord } from "@a2a-wrapper/core";
import { DEFAULTS } from "./defaults.js";
import type { AgentConfig, McpServerConfig } from "./types.js";

// ─── Deep Merge ─────────────────────────────────────────────────────────────

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined) continue;
    const tgtVal = result[key];
    if (
      tgtVal !== null &&
      srcVal !== null &&
      typeof tgtVal === "object" &&
      typeof srcVal === "object" &&
      !Array.isArray(tgtVal) &&
      !Array.isArray(srcVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

// ─── JSON File Loader ────────────────────────────────────────────────────────

export function loadConfigFile(filePath: string): AgentConfig {
  const absPath = resolve(filePath);
  try {
    const raw = readFileSync(absPath, "utf-8");
    return JSON.parse(raw) as AgentConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load config file "${absPath}": ${msg}`);
  }
}

// ─── Environment Variable Overrides ─────────────────────────────────────────

export function loadEnvOverrides(): Partial<AgentConfig> {
  const cfg: Partial<AgentConfig> = {};

  // Server
  const port = process.env["PORT"];
  const hostname = process.env["HOSTNAME"];
  const advertiseHost = process.env["ADVERTISE_HOST"];
  if (port || hostname || advertiseHost) {
    cfg.server = {};
    if (port) cfg.server.port = parseInt(port, 10);
    if (hostname) cfg.server.hostname = hostname;
    if (advertiseHost) cfg.server.advertiseHost = advertiseHost;
  }

  // Claude
  const workspaceDir = process.env["WORKSPACE_DIR"];
  const claudeModel = process.env["CLAUDE_MODEL"];
  if (workspaceDir || claudeModel) {
    cfg.claude = {};
    if (workspaceDir) cfg.claude.workingDirectory = workspaceDir;
    if (claudeModel) cfg.claude.model = claudeModel;
  }
  // ANTHROPIC_API_KEY is read directly by the SDK — never forwarded via config.

  // Features
  const streamArtifacts = process.env["STREAM_ARTIFACTS"];
  if (streamArtifacts) {
    cfg.features = { streamArtifactChunks: streamArtifacts === "true" };
  }

  // Logging
  const logLevel = process.env["LOG_LEVEL"];
  if (logLevel) {
    cfg.logging = { level: logLevel };
  }

  // Agent card
  const agentName = process.env["AGENT_NAME"];
  const agentDesc = process.env["AGENT_DESCRIPTION"];
  if (agentName || agentDesc) {
    cfg.agentCard = { name: agentName ?? "", description: agentDesc ?? "" };
  }

  return cfg;
}

// ─── Merge Pipeline ─────────────────────────────────────────────────────────

export function resolveConfig(
  configFilePath?: string,
  cliOverrides?: Partial<AgentConfig>,
): Required<AgentConfig> {
  let merged = deepMerge({}, DEFAULTS as unknown as Record<string, unknown>);

  if (configFilePath) {
    const fileConfig = loadConfigFile(configFilePath);
    merged = deepMerge(merged, fileConfig as unknown as Record<string, unknown>);
  }

  const envConfig = loadEnvOverrides();
  merged = deepMerge(merged, envConfig as unknown as Record<string, unknown>);

  if (cliOverrides) {
    merged = deepMerge(merged, cliOverrides as unknown as Record<string, unknown>);
  }

  // Substitute env-var tokens in claude paths, MCP args/env/headers, and sub-agent auth
  substituteEnvTokensInClaude(merged);
  substituteEnvTokensInMcp(merged);

  return merged as unknown as Required<AgentConfig>;
}

// ─── Env Token Substitution ─────────────────────────────────────────────────

function substituteEnvTokensInClaude(config: Record<string, unknown>): void {
  const claude = config.claude as Record<string, unknown> | undefined;
  if (!claude) return;

  if (typeof claude.workingDirectory === "string") {
    claude.workingDirectory = substituteEnvTokensInString(claude.workingDirectory);
  }
  if (typeof claude.model === "string") {
    const resolved = substituteEnvTokensInString(claude.model);
    // Clear the field if the token wasn't resolved (env var not set) or if empty.
    claude.model = resolved.includes("${") ? undefined : resolved || undefined;
  }
  if (Array.isArray(claude.additionalDirectories)) {
    claude.additionalDirectories = (claude.additionalDirectories as string[]).map((d) =>
      typeof d === "string" ? substituteEnvTokensInString(d) : d,
    );
  }
  if (typeof claude.executablePathOverride === "string") {
    claude.executablePathOverride = substituteEnvTokensInString(claude.executablePathOverride);
  }
}

function substituteEnvTokensInMcp(config: Record<string, unknown>): void {
  const mcp = config.mcp as Record<string, unknown> | undefined;
  if (!mcp) return;

  for (const serverCfg of Object.values(mcp)) {
    const srv = serverCfg as Record<string, unknown>;

    if (srv.type === "stdio") {
      if (Array.isArray(srv.args)) {
        srv.args = (srv.args as string[]).map((arg) =>
          typeof arg === "string" ? substituteEnvTokensInString(arg) : arg,
        );
      }
      if (srv.env && typeof srv.env === "object") {
        srv.env = substituteEnvTokensInRecord(srv.env as Record<string, string>);
      }
    } else if (srv.type === "http") {
      if (srv.headers && typeof srv.headers === "object") {
        srv.headers = substituteEnvTokensInRecord(srv.headers as Record<string, string>);
      }
    }
  }
}

// Re-export McpServerConfig for use in loader consumers
export type { McpServerConfig };
