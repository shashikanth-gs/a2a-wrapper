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
  // BYOK / custom provider — mirrors the gh-copilot CLI env vars so the same
  // shell exports work for both the CLI and this SDK-based wrapper.
  const providerBaseUrl = process.env["COPILOT_PROVIDER_BASE_URL"];
  const providerType = process.env["COPILOT_PROVIDER_TYPE"] as "openai" | "azure" | "anthropic" | undefined;
  const providerApiKey = process.env["COPILOT_PROVIDER_API_KEY"];
  const providerWireApi = process.env["COPILOT_PROVIDER_WIRE_API"] as "completions" | "responses" | undefined;

  if (cliUrl || model || workspaceDir || githubToken || providerBaseUrl) {
    cfg.copilot = {};
    if (cliUrl) cfg.copilot.cliUrl = cliUrl;
    if (model) cfg.copilot.model = model;
    if (workspaceDir) cfg.copilot.workspaceDirectory = workspaceDir;
    if (githubToken) cfg.copilot.githubToken = githubToken;

    // Build provider config from env vars (only if at least baseUrl is set)
    if (providerBaseUrl) {
      cfg.copilot.provider = { baseUrl: providerBaseUrl };
      if (providerType) cfg.copilot.provider.type = providerType;
      if (providerApiKey) cfg.copilot.provider.apiKey = providerApiKey;
      if (providerWireApi) cfg.copilot.provider.wireApi = providerWireApi;
    }
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

  // Layer 4: Substitute env-var tokens in MCP args, env, and headers
  substituteEnvTokensInMcp(merged);

  return merged as unknown as Required<AgentConfig>;
}

// ─── Env Token Substitution ─────────────────────────────────────────────────

/**
 * Replace env-var tokens in a single string. Supports two forms:
 *   - `${VAR_NAME}` — explicit, recommended (works mid-string, e.g. "Bearer ${TOKEN}")
 *   - `$VAR_NAME`   — bare, for backward compatibility (e.g. "$WORKSPACE_DIR")
 *
 * Tokens with no matching environment variable are left unchanged so that
 * literal `$` usage and misconfigurations are visible rather than silently
 * blanked out.
 */
function substituteEnvTokens(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (match, name: string) => process.env[name] ?? match)
    .replace(/\$(\w+)/g, (match, name: string) => process.env[name] ?? match);
}

/** Apply env-token substitution to every value of a string-map (in place-ish). */
function substituteEnvTokensInRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!record) return record;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    out[key] = typeof val === "string" ? substituteEnvTokens(val) : val;
  }
  return out;
}

/**
 * Replace env-var tokens across MCP server configs:
 *   - stdio  → `args` (array) and `env` (string map)
 *   - http   → `headers` (string map)
 *   - sse    → `headers` (string map)
 *
 * This keeps secrets (API keys, bearer tokens) out of config.json — operators
 * reference `${MY_TOKEN}` and supply the value via the process environment.
 */
function substituteEnvTokensInMcp(config: Record<string, unknown>): void {
  const mcp = config.mcp as Record<string, unknown> | undefined;
  if (!mcp) return;

  for (const serverCfg of Object.values(mcp)) {
    const srv = serverCfg as Record<string, unknown>;

    if (srv.type === "stdio") {
      if (Array.isArray(srv.args)) {
        srv.args = (srv.args as string[]).map((arg) =>
          typeof arg === "string" ? substituteEnvTokens(arg) : arg,
        );
      }
      if (srv.env && typeof srv.env === "object") {
        srv.env = substituteEnvTokensInRecord(srv.env as Record<string, string>);
      }
    } else if (srv.type === "http" || srv.type === "sse") {
      if (srv.headers && typeof srv.headers === "object") {
        srv.headers = substituteEnvTokensInRecord(srv.headers as Record<string, string>);
      }
    }
  }
}
