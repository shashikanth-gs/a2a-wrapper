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

  // Copilot SDK
  const cliUrl = process.env["COPILOT_CLI_URL"];
  const model = process.env["COPILOT_MODEL"];
  const workspaceDir = process.env["WORKSPACE_DIR"];
  const githubToken = process.env["GITHUB_TOKEN"];
  if (cliUrl || model || workspaceDir || githubToken) {
    cfg.copilot = {};
    if (cliUrl) cfg.copilot.cliUrl = cliUrl;
    if (model) cfg.copilot.model = model;
    if (workspaceDir) cfg.copilot.workspaceDirectory = workspaceDir;
    if (githubToken) cfg.copilot.githubToken = githubToken;
  }

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

  // Layer 4: Substitute $ENV_VAR tokens in MCP stdio args
  substituteEnvTokensInMcpArgs(merged);

  return merged as unknown as Required<AgentConfig>;
}

// ─── Env Token Substitution ─────────────────────────────────────────────────

/**
 * Replace $TOKEN references in MCP stdio args with matching environment
 * variable values.  Supports any $VAR_NAME token (e.g. $WORKSPACE_DIR).
 * Tokens with no matching env var are left unchanged.
 */
function substituteEnvTokensInMcpArgs(config: Record<string, unknown>): void {
  const mcp = config.mcp as Record<string, unknown> | undefined;
  if (!mcp) return;

  for (const serverCfg of Object.values(mcp)) {
    const srv = serverCfg as Record<string, unknown>;
    if (srv.type !== "stdio" || !Array.isArray(srv.args)) continue;

    srv.args = (srv.args as string[]).map((arg) =>
      arg.replace(/\$(\w+)/g, (_match, name: string) => process.env[name] ?? _match),
    );
  }
}
