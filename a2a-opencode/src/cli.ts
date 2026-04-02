#!/usr/bin/env node
/**
 * CLI Entry Point — a2a-opencode
 *
 * Parses command-line flags, resolves the final configuration (in priority
 * order: defaults ← JSON file ← environment variables ← CLI flags), then
 * boots the A2A HTTP server and blocks until SIGINT / SIGTERM.
 *
 * Usage:
 *   a2a-opencode --agent-json agents/example/config.json
 *   a2a-opencode --agent-json agents/my-agent/config.json --port 3001
 *   a2a-opencode --agent-name "My Agent" --port 8080 --opencode-url http://localhost:4096
 *
 * Run `a2a-opencode --help` for the full flag reference.
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
Usage: a2a-opencode [options]

Options:
  --agent-json <path>         Path to agent JSON config file  (alias: --config)
  --config <path>             Path to agent JSON config file  (alias: --agent-json)
  --port <number>             A2A server port                 (default: 3000)
  --hostname <addr>           Bind address                   (default: 0.0.0.0)
  --advertise-host <host>     Hostname for agent card URLs    (default: localhost)
  --opencode-url <url>        OpenCode server URL             (default: http://localhost:4096)
  --directory <path>          Project directory for OpenCode
  --model <provider/model>    LLM model                      (default: provider's default)
                              Examples: anthropic/claude-sonnet-4-20250514, github-copilot/gpt-4o
  --agent <name>              OpenCode agent preset to use
  --agent-name <name>         Agent display name             (default: "OpenCode A2A Agent")
  --agent-description <desc>  Agent description
  --auto-approve              Auto-approve all permissions   (default: on)
  --no-auto-approve           Require manual permission approval
  --auto-answer               Auto-answer questions          (default: on)
  --no-auto-answer            Do not auto-answer questions
  --stream-artifacts          Stream artifact chunks (spec-correct, streaming clients)
  --no-stream-artifacts       Buffer artifacts — Inspector-compatible (default)
  --log-level <level>         Log level: debug | info | warn | error  (default: info)
  --help                      Show this help message
  --version                   Show version

Examples:
  npx a2a-opencode                                       # start with built-in defaults on port 3000
                                                         # (OpenCode must be running on port 4096)
  npx a2a-opencode --port 3001 --opencode-url http://localhost:4096
  npx a2a-opencode --agent-json ./my-agent.json
  npx a2a-opencode --agent-json ./my-agent.json --port 3001
`);
}

function parseCliArgs(): { configPath?: string; overrides: Partial<AgentConfig> } {
  const { values } = parseArgs({
    options: {
      "agent-json":       { type: "string" },
      config:             { type: "string",  short: "c" },
      port:               { type: "string",  short: "p" },
      hostname:           { type: "string" },
      "advertise-host":   { type: "string" },
      "opencode-url":     { type: "string" },
      directory:          { type: "string",  short: "d" },
      model:              { type: "string",  short: "m" },
      agent:              { type: "string" },
      "agent-name":       { type: "string" },
      "agent-description":{ type: "string" },
      "auto-approve":     { type: "boolean" },
      "no-auto-approve":  { type: "boolean" },
      "auto-answer":      { type: "boolean" },
      "no-auto-answer":   { type: "boolean" },
      "stream-artifacts": { type: "boolean" },
      "no-stream-artifacts": { type: "boolean" },
      "log-level":        { type: "string" },
      help:               { type: "boolean", short: "h" },
      version:            { type: "boolean", short: "v" },
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
    if (values.port)               overrides.server!.port = parseInt(values.port as string, 10);
    if (values.hostname)           overrides.server!.hostname = values.hostname as string;
    if (values["advertise-host"])  overrides.server!.advertiseHost = values["advertise-host"] as string;
  }

  // OpenCode
  if (values["opencode-url"] || values.directory || values.model || values.agent) {
    overrides.opencode = {} as AgentConfig["opencode"];
    if (values["opencode-url"])   overrides.opencode!.baseUrl = values["opencode-url"] as string;
    if (values.directory)         overrides.opencode!.projectDirectory = values.directory as string;
    if (values.model)             overrides.opencode!.model = values.model as string;
    if (values.agent)             overrides.opencode!.agent = values.agent as string;
  }

  // Agent card name/description
  if (values["agent-name"] || values["agent-description"]) {
    overrides.agentCard = {} as AgentConfig["agentCard"];
    if (values["agent-name"])          overrides.agentCard!.name = values["agent-name"] as string;
    if (values["agent-description"])   overrides.agentCard!.description = values["agent-description"] as string;
  }

  // Features
  const featureOverrides: Partial<AgentConfig["features"]> = {};
  if (values["auto-approve"])         featureOverrides.autoApprovePermissions = true;
  if (values["no-auto-approve"])      featureOverrides.autoApprovePermissions = false;
  if (values["auto-answer"])          featureOverrides.autoAnswerQuestions = true;
  if (values["no-auto-answer"])       featureOverrides.autoAnswerQuestions = false;
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

  log.info("Starting a2a-opencode", {
    config: configPath ?? "(built-in defaults)",
    agent: config.agentCard?.name,
    port: config.server?.port,
    opencodeUrl: config.opencode?.baseUrl,
    model: config.opencode?.model || "(provider default)",
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
