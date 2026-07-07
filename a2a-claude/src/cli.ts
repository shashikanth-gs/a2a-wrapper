#!/usr/bin/env node
/**
 * CLI Entry Point — a2a-claude
 *
 * Parses command-line flags, resolves the final configuration (in priority
 * order: defaults ← JSON file ← environment variables ← CLI flags), then
 * boots the A2A HTTP server and blocks until SIGINT / SIGTERM.
 *
 * Usage:
 *   a2a-claude --config agents/example/config.json
 *   a2a-claude --config agents/my-agent/config.json --port 3030
 *   a2a-claude --workspace /path/to/repo --model claude-sonnet-5
 *
 * Run `a2a-claude --help` for the full flag reference.
 */

import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { resolveConfig } from "./config/loader.js";
import type { AgentConfig, ClaudeConfig } from "./config/types.js";
import { createA2AServer } from "./server/index.js";
import { logger, LogLevel } from "./utils/logger.js";

const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require("../package.json") as { version: string };

const log = logger.child("cli");

// ─── Help Text ────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Usage: a2a-claude [options]

Options:
  --agent-json <path>          Path to agent JSON config file  (alias: --config)
  --config <path>              Path to agent JSON config file  (alias: --agent-json)
  --port <number>              A2A server port                 (default: 3030)
  --hostname <addr>            Bind address                    (default: 0.0.0.0)
  --advertise-host <host>      Hostname for agent card URLs    (default: localhost)
  --workspace <path>           Workspace directory (Git repo)  (alias: --working-dir)
  --working-dir <path>         Workspace directory (Git repo)  (alias: --workspace)
  --model <model>              Claude model                    (e.g. claude-sonnet-5, claude-opus-4-8)
  --permission-mode <mode>     Permission mode                 (acceptEdits | dontAsk | plan | bypassPermissions)
  --agent-name <name>          Agent display name
  --agent-description <desc>   Agent description
  --stream-artifacts           Stream artifact chunks (spec-correct, streaming clients)
  --no-stream-artifacts        Buffer artifacts — Inspector-compatible (default)
  --log-level <level>          Log level: debug | info | warn | error  (default: info)
  --help                       Show this help message
  --version                    Show version

Environment variables:
  ANTHROPIC_API_KEY             Required. Your Anthropic API key.
  WORKSPACE_DIR                 Workspace directory (alternative to --workspace).
  CLAUDE_MODEL                  Model override (alternative to --model).
  LOG_LEVEL                     Log level override.
  STREAM_ARTIFACTS               Set to "true" to enable streaming artifact chunks.

Examples:
  a2a-claude --config agents/example/config.json
  ANTHROPIC_API_KEY=sk-... WORKSPACE_DIR=/repo a2a-claude --config agents/example/config.json
  a2a-claude --workspace /repo --model claude-sonnet-5 --port 3030
`);
}

// ─── Argument Parsing ─────────────────────────────────────────────────────────

function parseCliArgs(): { configPath?: string; overrides: Partial<AgentConfig> } {
  const { values } = parseArgs({
    options: {
      "agent-json":          { type: "string" },
      config:                { type: "string", short: "c" },
      port:                  { type: "string", short: "p" },
      hostname:              { type: "string" },
      "advertise-host":      { type: "string" },
      workspace:             { type: "string", short: "w" },
      "working-dir":         { type: "string" },
      model:                 { type: "string", short: "m" },
      "permission-mode":     { type: "string" },
      "agent-name":          { type: "string" },
      "agent-description":   { type: "string" },
      "stream-artifacts":    { type: "boolean" },
      "no-stream-artifacts": { type: "boolean" },
      "log-level":           { type: "string" },
      help:                  { type: "boolean", short: "h" },
      version:               { type: "boolean", short: "v" },
    },
    strict: false,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (values.version) {
    console.log(PKG_VERSION);
    process.exit(0);
  }

  const configPath = (values["agent-json"] ?? values.config) as string | undefined;
  const overrides: Partial<AgentConfig> = {};

  // Server
  if (values.port || values.hostname || values["advertise-host"]) {
    overrides.server = {};
    if (values.port)              overrides.server.port = parseInt(values.port as string, 10);
    if (values.hostname)          overrides.server.hostname = values.hostname as string;
    if (values["advertise-host"]) overrides.server.advertiseHost = values["advertise-host"] as string;
  }

  // Claude
  const workspaceDir = (values.workspace ?? values["working-dir"]) as string | undefined;
  const model = values.model as string | undefined;
  const permissionMode = values["permission-mode"] as string | undefined;
  if (workspaceDir || model || permissionMode) {
    overrides.claude = {};
    if (workspaceDir) overrides.claude.workingDirectory = workspaceDir;
    if (model) overrides.claude.model = model;
    if (permissionMode) overrides.claude.permissionMode = permissionMode as ClaudeConfig["permissionMode"];
  }

  // Agent card
  if (values["agent-name"] || values["agent-description"]) {
    overrides.agentCard = { name: "", description: "" };
    if (values["agent-name"])        overrides.agentCard.name = values["agent-name"] as string;
    if (values["agent-description"]) overrides.agentCard.description = values["agent-description"] as string;
  }

  // Features
  const featureOverrides: Partial<AgentConfig["features"]> = {};
  if (values["stream-artifacts"])     featureOverrides.streamArtifactChunks = true;
  if (values["no-stream-artifacts"])  featureOverrides.streamArtifactChunks = false;
  if (Object.keys(featureOverrides).length > 0) {
    overrides.features = featureOverrides as AgentConfig["features"];
  }

  // Logging
  if (values["log-level"]) {
    overrides.logging = { level: values["log-level"] as string };
  }

  return { configPath, overrides };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { configPath, overrides } = parseCliArgs();

  const config = resolveConfig(configPath, overrides);

  config.configDir = configPath
    ? dirname(resolve(configPath))
    : process.cwd();

  // Apply log level
  const levelStr = config.logging?.level ?? "info";
  logger.setLevel(Logger.parseLevel(levelStr));

  if (!configPath) {
    log.info("No --config provided — running with built-in defaults. Pass --config <path> to load a custom agent.");
  }

  log.info("Starting a2a-claude", {
    config: configPath ?? "(built-in defaults)",
    agent: config.agentCard?.name,
    port: config.server?.port,
    workingDirectory: config.claude?.workingDirectory || "(not set)",
    permissionMode: config.claude?.permissionMode,
  });

  const handle = await createA2AServer(config);

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received, shutting down...`);
    await handle.shutdown();
    process.exit(0);
  };

  process.on("SIGINT",  () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

import { Logger } from "./utils/logger.js";

main().catch((err) => {
  log.error("Fatal error", { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
