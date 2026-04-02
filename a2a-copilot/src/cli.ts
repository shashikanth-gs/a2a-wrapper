#!/usr/bin/env node
/**
 * CLI Entry Point — a2a-copilot
 *
 * Parses command-line flags, resolves the final configuration (in priority
 * order: defaults ← JSON file ← environment variables ← CLI flags), then
 * boots the A2A HTTP server and blocks until SIGINT / SIGTERM.
 *
 * Usage:
 *   a2a-copilot --agent-json agents/example/config.json
 *   a2a-copilot --agent-json agents/my-agent/config.json --port 3001
 *   a2a-copilot --agent-name "My Agent" --port 8080 --model gpt-4o
 *
 * Run `a2a-copilot --help` for the full flag reference.
 */

import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { resolveConfig } from "./config/loader.js";
import type { AgentConfig } from "./config/types.js";
import { createA2AServer } from "./server/index.js";
import { logger, LogLevel } from "./utils/logger.js";

const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require("../package.json") as { version: string };

const log = logger.child("cli");

// ─── CLI Argument Parsing ─────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Usage: a2a-copilot [options]

Options:
  --agent-json <path>         Path to agent JSON config file  (alias: --config)
  --config <path>             Path to agent JSON config file  (alias: --agent-json)
  --port <number>             A2A server port                 (default: 3000)
  --hostname <addr>           Bind address                   (default: 0.0.0.0)
  --advertise-host <host>     Hostname for agent card URLs    (default: localhost)
  --cli-url <url>             Copilot CLI server URL          (default: auto — SDK spawns gh CLI)
                              Only needed when pointing at a running VS Code Copilot
                              language server (typically http://localhost:4321)
  --model <model>             LLM model                      (default: claude-sonnet-4.5)
                              Examples: gpt-4o, gpt-4.1, claude-sonnet-4.5
  --workspace <path>          Workspace directory for context files
  --agent-name <name>         Agent display name             (default: "Copilot A2A Agent")
  --agent-description <desc>  Agent description
  --stream-artifacts          Stream artifact chunks (spec-correct, streaming clients)
  --no-stream-artifacts       Buffer artifacts — Inspector-compatible (default)
  --log-level <level>         Log level: debug | info | warn | error  (default: info)
  --help                      Show this help message
  --version                   Show version

Examples:
  npx a2a-copilot                                        # start with built-in defaults on port 3000
  npx a2a-copilot --port 3001 --model gpt-4o             # override port and model
  npx a2a-copilot --agent-json ./my-agent.json           # load full agent config from file
  npx a2a-copilot --agent-json ./my-agent.json --port 3001
`);
}

function parseCliArgs(): { configPath?: string; overrides: Partial<AgentConfig> } {
  const { values } = parseArgs({
    options: {
      "agent-json":          { type: "string" },
      config:                { type: "string",  short: "c" },
      port:                  { type: "string",  short: "p" },
      hostname:              { type: "string" },
      "advertise-host":      { type: "string" },
      "cli-url":             { type: "string" },
      model:                 { type: "string",  short: "m" },
      workspace:             { type: "string",  short: "w" },
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

  const overrides: Partial<AgentConfig> = {};

  // --agent-json is an alias for --config
  const configPath = (values["agent-json"] ?? values.config) as string | undefined;

  // Server
  if (values.port || values.hostname || values["advertise-host"]) {
    overrides.server = {} as AgentConfig["server"];
    if (values.port)              overrides.server!.port = parseInt(values.port as string, 10);
    if (values.hostname)          overrides.server!.hostname = values.hostname as string;
    if (values["advertise-host"]) overrides.server!.advertiseHost = values["advertise-host"] as string;
  }

  // Copilot
  if (values["cli-url"] || values.model || values.workspace) {
    overrides.copilot = {} as AgentConfig["copilot"];
    if (values["cli-url"])  overrides.copilot!.cliUrl = values["cli-url"] as string;
    if (values.model)       overrides.copilot!.model = values.model as string;
    if (values.workspace)   overrides.copilot!.workspaceDirectory = values.workspace as string;
  }

  // Agent card name/description
  if (values["agent-name"] || values["agent-description"]) {
    overrides.agentCard = {} as AgentConfig["agentCard"];
    if (values["agent-name"])        overrides.agentCard!.name = values["agent-name"] as string;
    if (values["agent-description"]) overrides.agentCard!.description = values["agent-description"] as string;
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
    overrides.logging = { level: values["log-level"] as string } as AgentConfig["logging"];
  }

  return { configPath, overrides };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const { configPath, overrides } = parseCliArgs();

  // Resolve config: defaults ← file ← env ← CLI overrides
  const config = resolveConfig(configPath, overrides);

  // Apply log level
  const levelStr = config.logging?.level ?? "info";
  const levelMap: Record<string, LogLevel> = {
    debug: LogLevel.DEBUG, info: LogLevel.INFO, warn: LogLevel.WARN, error: LogLevel.ERROR,
  };
  logger.setLevel(levelMap[levelStr] ?? LogLevel.INFO);

  if (!configPath) {
    log.info("No --agent-json provided — running with built-in defaults. Pass --agent-json <path> to load a custom agent.");
  }

  log.info("Starting a2a-copilot", {
    config: configPath ?? "(built-in defaults)",
    agent: config.agentCard?.name,
    port: config.server?.port,
    model: config.copilot?.model,
    cliUrl: config.copilot?.cliUrl || "(auto-discovery)",
  });

  // Start server
  const handle = await createA2AServer(config as Required<AgentConfig>);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down...`);
    await handle.shutdown();
    process.exit(0);
  };

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("Fatal error", { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
