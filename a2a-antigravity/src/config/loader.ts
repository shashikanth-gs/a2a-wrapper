/**
 * Configuration Loader
 *
 * Merges defaults ← JSON file ← environment variables ← CLI overrides, then
 * substitutes environment tokens in wrapper-owned path and secret fields.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { substituteEnvTokensInRecord, substituteEnvTokensInString } from "@a2a-wrapper/core";
import { DEFAULTS } from "./defaults.js";
import type { AgentConfig, McpServerConfig } from "./types.js";

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

export function loadEnvOverrides(): Partial<AgentConfig> {
  const cfg: Partial<AgentConfig> = {};

  const port = process.env["PORT"];
  const hostname = process.env["HOSTNAME"];
  const advertiseHost = process.env["ADVERTISE_HOST"];
  if (port || hostname || advertiseHost) {
    cfg.server = {};
    if (port) cfg.server.port = parseInt(port, 10);
    if (hostname) cfg.server.hostname = hostname;
    if (advertiseHost) cfg.server.advertiseHost = advertiseHost;
  }

  const workspaceDir = process.env["WORKSPACE_DIR"];
  const model = process.env["ANTIGRAVITY_MODEL"] ?? process.env["GEMINI_MODEL"];
  const pythonPath = process.env["ANTIGRAVITY_PYTHON"];
  const authMode = process.env["ANTIGRAVITY_AUTH_MODE"];
  const apiKey = process.env["GEMINI_API_KEY"];
  const project = process.env["GOOGLE_CLOUD_PROJECT"] ?? process.env["GOOGLE_PROJECT"];
  const location = process.env["GOOGLE_CLOUD_LOCATION"] ?? process.env["GOOGLE_LOCATION"];
  if (workspaceDir || model || pythonPath || authMode || project || location) {
    cfg.antigravity = {};
    if (workspaceDir) cfg.antigravity.workingDirectory = workspaceDir;
    if (model) cfg.antigravity.model = model;
    if (pythonPath) cfg.antigravity.pythonPath = pythonPath;
    if (authMode || project || location) {
      cfg.antigravity.provider = {};
      if (authMode) {
        cfg.antigravity.provider.authMode = authMode as NonNullable<
          NonNullable<AgentConfig["antigravity"]>["provider"]
        >["authMode"];
      }
      if (project) cfg.antigravity.provider.project = project;
      if (location) cfg.antigravity.provider.location = location;
    }
  }
  // GEMINI_API_KEY is read directly by the SDK in sdkDefault/apiKey modes.
  // We do not copy it into resolved config unless the operator explicitly used
  // `${GEMINI_API_KEY}` in config or passed --api-key.
  void apiKey;

  const streamArtifacts = process.env["STREAM_ARTIFACTS"];
  if (streamArtifacts) {
    cfg.features = { streamArtifactChunks: streamArtifacts === "true" };
  }

  const logLevel = process.env["LOG_LEVEL"];
  if (logLevel) {
    cfg.logging = { level: logLevel };
  }

  const agentName = process.env["AGENT_NAME"];
  const agentDesc = process.env["AGENT_DESCRIPTION"];
  if (agentName || agentDesc) {
    cfg.agentCard = { name: agentName ?? "", description: agentDesc ?? "" };
  }

  return cfg;
}

export function resolveConfig(
  configFilePath?: string,
  cliOverrides?: Partial<AgentConfig>,
): Required<AgentConfig> {
  let merged = deepMerge({}, DEFAULTS as unknown as Record<string, unknown>);

  if (configFilePath) {
    const fileConfig = loadConfigFile(configFilePath);
    merged = deepMerge(merged, fileConfig as unknown as Record<string, unknown>);
  }

  merged = deepMerge(merged, loadEnvOverrides() as unknown as Record<string, unknown>);

  if (cliOverrides) {
    merged = deepMerge(merged, cliOverrides as unknown as Record<string, unknown>);
  }

  substituteEnvTokensInAntigravity(merged);
  substituteEnvTokensInMcp(merged);

  return merged as unknown as Required<AgentConfig>;
}

function substituteOptionalString(obj: Record<string, unknown>, key: string): void {
  if (typeof obj[key] !== "string") return;
  const resolved = substituteEnvTokensInString(obj[key] as string);
  obj[key] = resolved.includes("${") ? undefined : resolved || undefined;
}

function substituteStringArray(obj: Record<string, unknown>, key: string): void {
  if (!Array.isArray(obj[key])) return;
  obj[key] = (obj[key] as unknown[]).map((item) =>
    typeof item === "string" ? substituteEnvTokensInString(item) : item,
  );
}

function substituteEnvTokensInAntigravity(config: Record<string, unknown>): void {
  const ag = config.antigravity as Record<string, unknown> | undefined;
  if (!ag) return;

  for (const key of [
    "workingDirectory",
    "model",
    "saveDir",
    "appDataDir",
    "conversationId",
    "pythonPath",
    "bridgePath",
  ]) {
    substituteOptionalString(ag, key);
  }
  substituteStringArray(ag, "workspaces");
  substituteStringArray(ag, "skillsPaths");

  if (typeof ag.responseSchema === "string") {
    ag.responseSchema = substituteEnvTokensInString(ag.responseSchema);
  }

  const provider = ag.provider as Record<string, unknown> | undefined;
  if (provider) {
    substituteOptionalString(provider, "apiKey");
    substituteOptionalString(provider, "project");
    substituteOptionalString(provider, "location");
  }
}

function substituteEnvTokensInMcp(config: Record<string, unknown>): void {
  const mcp = config.mcp as Record<string, unknown> | undefined;
  if (!mcp) return;

  for (const serverCfg of Object.values(mcp)) {
    const srv = serverCfg as Record<string, unknown>;
    if (srv.type === "stdio") {
      substituteOptionalString(srv, "command");
      if (Array.isArray(srv.args)) {
        srv.args = (srv.args as string[]).map((arg) =>
          typeof arg === "string" ? substituteEnvTokensInString(arg) : arg,
        );
      }
      if (srv.env && typeof srv.env === "object") {
        srv.env = substituteEnvTokensInRecord(srv.env as Record<string, string>);
      }
    } else if (srv.type === "http") {
      substituteOptionalString(srv, "url");
      if (srv.headers && typeof srv.headers === "object") {
        srv.headers = substituteEnvTokensInRecord(srv.headers as Record<string, string>);
      }
    }
  }
}

export type { McpServerConfig };
