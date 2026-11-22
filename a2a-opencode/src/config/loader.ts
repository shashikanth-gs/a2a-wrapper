/**
 * Configuration Loader
 *
 * Loads agent configuration from:
 *  1. JSON file (--config path)
 *  2. CLI argument overrides
 *  3. Environment variable overrides
 *
 * Merges in order: defaults ← JSON file ← env vars ← CLI args
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { substituteEnvTokensInString, substituteEnvTokensInRecord, normalizeModel } from "@a2a-wrapper/core";
import { DEFAULTS } from "./defaults.js";
import type { AgentConfig, McpServerConfig } from "./types.js";

// ─── Deep Merge ─────────────────────────────────────────────────────────────

/**
 * Deep-merge `source` into `target`. Arrays are replaced, not concatenated.
 * Returns a new object — neither input is mutated.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
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

// ─── JSON File Loader ───────────────────────────────────────────────────────

/**
 * Read and parse a JSON config file.
 * Throws with a descriptive message on failure.
 */
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

/**
 * Read well-known environment variables and return a partial config.
 * Only set fields are returned — undefined values are omitted.
 */
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

  // OpenCode
  const baseUrl = process.env["OPENCODE_URL"];
  const directory = process.env["DIRECTORY"];
  // MODEL is the long-standing name; OPENCODE_MODEL is accepted as an alias (it is what .env.example documents).
  const model = process.env["MODEL"] || process.env["OPENCODE_MODEL"];
  const agent = process.env["OPENCODE_AGENT"];
  const apiVersion = process.env["OPENCODE_API_VERSION"];
  const password = process.env["OPENCODE_SERVER_PASSWORD"];
  if (baseUrl || directory || model || agent || apiVersion || password) {
    cfg.opencode = {};
    if (apiVersion === "auto" || apiVersion === "1" || apiVersion === "2") cfg.opencode.apiVersion = apiVersion;
    if (password) cfg.opencode.password = password;
    if (baseUrl) cfg.opencode.baseUrl = baseUrl;
    if (directory) cfg.opencode.projectDirectory = directory;
    if (model) cfg.opencode.model = model;
    if (agent) cfg.opencode.agent = agent;
  }

  // Features (only override if explicitly set)
  const autoApprove = process.env["AUTO_APPROVE"];
  const autoAnswer = process.env["AUTO_ANSWER"];
  const streamArtifacts = process.env["STREAM_ARTIFACTS"];
  if (autoApprove || autoAnswer || streamArtifacts) {
    cfg.features = {};
    if (autoApprove) cfg.features.autoApprovePermissions = autoApprove === "true";
    if (autoAnswer) cfg.features.autoAnswerQuestions = autoAnswer === "true";
    if (streamArtifacts) cfg.features.streamArtifactChunks = streamArtifacts === "true";
  }

  // Logging
  const logLevel = process.env["LOG_LEVEL"];
  if (logLevel) {
    cfg.logging = { level: logLevel };
  }

  // Agent card (minimal override via env)
  const agentName = process.env["AGENT_NAME"];
  const agentDesc = process.env["AGENT_DESCRIPTION"];
  if (agentName || agentDesc) {
    cfg.agentCard = { name: agentName ?? "", description: agentDesc ?? "" };
  }

  // MCP server URL overrides: MCP_<NAME>_URL (e.g. MCP_FILESYSTEM_URL)
  const mcpUrlPrefix = "MCP_";
  const mcpUrlSuffix = "_URL";
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(mcpUrlPrefix) && key.endsWith(mcpUrlSuffix) && value) {
      const name = key.slice(mcpUrlPrefix.length, -mcpUrlSuffix.length).toLowerCase();
      if (!cfg.mcp) cfg.mcp = {};
      const existing = cfg.mcp[name] as unknown as Record<string, unknown> | undefined;
      cfg.mcp[name] = { ...(existing ?? {}), url: value } as unknown as McpServerConfig;
    }
  }

  return cfg;
}

// ─── Merge Pipeline ─────────────────────────────────────────────────────────

/**
 * Build the final resolved configuration by merging:
 *   defaults ← configFile ← envOverrides ← cliOverrides
 *
 * @param configFilePath  Optional path to a JSON config file
 * @param cliOverrides    Partial config from CLI argument parsing
 * @returns Fully resolved AgentConfig (all fields populated)
 */
export function resolveConfig(
  configFilePath?: string,
  cliOverrides?: Partial<AgentConfig>,
): Required<AgentConfig> {
  let merged = deepMerge({}, DEFAULTS as unknown as Record<string, unknown>);

  // Layer 1: JSON file
  if (configFilePath) {
    const fileConfig = loadConfigFile(configFilePath);
    merged = deepMerge(merged, fileConfig as unknown as Record<string, unknown>);
  }

  // Layer 2: Environment variables
  const envConfig = loadEnvOverrides();
  merged = deepMerge(merged, envConfig as unknown as Record<string, unknown>);

  // Layer 3: CLI overrides
  if (cliOverrides) {
    merged = deepMerge(merged, cliOverrides as unknown as Record<string, unknown>);
  }

  // Layer 4: Substitute env-var tokens in MCP command, environment, and headers
  substituteEnvTokensInMcp(merged);

  // Layer 5: model — "auto"/"default" mean the OpenCode server chooses (empty string)
  const opencode = merged.opencode as Record<string, unknown> | undefined;
  if (opencode) opencode.model = normalizeModel(opencode.model) ?? "";

  return merged as unknown as Required<AgentConfig>;
}

// ─── Env Token Substitution ──────────────────────────────────────────────────

/**
 * Replace env-var tokens across MCP server configs, using the shared helpers
 * from `@a2a-wrapper/core` (which support both `${VAR}` and bare `$VAR`):
 *   - local  → `command` (array) and `environment` (string map)
 *   - remote → `headers` (string map)
 *
 * This keeps secrets (API keys, bearer tokens) out of config.json — operators
 * reference `${MY_TOKEN}` and supply the value via the process environment.
 */
function substituteEnvTokensInMcp(config: Record<string, unknown>): void {
  const mcp = config.mcp as Record<string, unknown> | undefined;
  if (!mcp) return;

  for (const serverCfg of Object.values(mcp)) {
    const srv = serverCfg as Record<string, unknown>;

    if (srv.type === "local") {
      if (Array.isArray(srv.command)) {
        srv.command = (srv.command as string[]).map((arg) =>
          typeof arg === "string" ? substituteEnvTokensInString(arg) : arg,
        );
      }
      if (srv.environment && typeof srv.environment === "object") {
        srv.environment = substituteEnvTokensInRecord(srv.environment as Record<string, string>);
      }
    } else if (srv.type === "remote") {
      if (srv.headers && typeof srv.headers === "object") {
        srv.headers = substituteEnvTokensInRecord(srv.headers as Record<string, string>);
      }
    }
  }
}
