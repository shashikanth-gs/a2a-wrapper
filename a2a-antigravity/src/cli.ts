#!/usr/bin/env node
/**
 * CLI Entry Point — a2a-antigravity
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Logger } from "@a2a-wrapper/core";
import { resolveConfig } from "./config/loader.js";
import type { AgentConfig, AntigravityConfig } from "./config/types.js";
import { createA2AServer } from "./server/index.js";
import { PythonSetupError, setupPythonEnvironment } from "./antigravity/python-setup.js";
import { logger } from "./utils/logger.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as { version: string };
const log = logger.child("cli");

function printUsage(): void {
  console.log(`
Usage: a2a-antigravity [options]
       a2a-antigravity setup [options]

Options:
  --agent-json <path>          Path to agent JSON config file  (alias: --config)
  --config <path>              Path to agent JSON config file  (alias: --agent-json)
  --port <number>              A2A server port                 (default: 3040)
  --hostname <addr>            Bind address                    (default: 0.0.0.0)
  --advertise-host <host>      Hostname for agent card URLs    (default: localhost)
  --workspace <path>           Primary Antigravity workspace   (alias: --working-dir)
  --working-dir <path>         Primary Antigravity workspace   (alias: --workspace)
  --model <model>              Antigravity/Gemini model
  --auth-mode <mode>           sdkDefault | apiKey | adc       (default: sdkDefault)
  --api-key <key>              Gemini API key                  (prefer GEMINI_API_KEY)
  --project <id>               Vertex/ADC project
  --location <region>          Vertex/ADC location
  --python <path>              Python executable               (default: python3)
  --agent-name <name>          Agent display name
  --agent-description <desc>   Agent description
  --stream-artifacts           Stream artifact chunks
  --no-stream-artifacts        Buffer artifacts (default)
  --log-level <level>          debug | info | warn | error     (default: info)
  --help                       Show this help message
  --version                    Show version

Setup options:
  --python <path>              Python 3.10+ executable used to create the managed venv
  --venv-dir <path>            Override managed venv directory
  --force                      Recreate the managed venv before installing requirements

Environment variables:
  GEMINI_API_KEY               Gemini Developer API key used by the SDK.
  WORKSPACE_DIR                Workspace directory.
  ANTIGRAVITY_MODEL            Model override.
  ANTIGRAVITY_AUTH_MODE        sdkDefault | apiKey | adc.
  GOOGLE_CLOUD_PROJECT         Vertex project for authMode adc.
  GOOGLE_CLOUD_LOCATION        Vertex location for authMode adc.
  ANTIGRAVITY_PYTHON           Python executable for the bridge.
  A2A_ANTIGRAVITY_HOME         Base directory for managed Python environment.
  A2A_ANTIGRAVITY_VENV         Exact managed Python venv directory.
  LOG_LEVEL                    Log level override.

Examples:
  a2a-antigravity setup
  a2a-antigravity setup --python /opt/homebrew/bin/python3.14
  a2a-antigravity --config agents/example/config.json
  GEMINI_API_KEY=... a2a-antigravity --workspace /repo
  a2a-antigravity --auth-mode adc --project my-gcp-project --location us-central1
`);
}

function parseSetupArgs(): { python?: string; venvDir?: string; force?: boolean } {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      python: { type: "string" },
      "venv-dir": { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  return {
    python: values.python as string | undefined,
    venvDir: values["venv-dir"] as string | undefined,
    force: values.force as boolean | undefined,
  };
}

function parseCliArgs(): { configPath?: string; overrides: Partial<AgentConfig> } {
  const { values } = parseArgs({
    options: {
      "agent-json": { type: "string" },
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      hostname: { type: "string" },
      "advertise-host": { type: "string" },
      workspace: { type: "string", short: "w" },
      "working-dir": { type: "string" },
      model: { type: "string", short: "m" },
      "auth-mode": { type: "string" },
      "api-key": { type: "string" },
      project: { type: "string" },
      location: { type: "string" },
      python: { type: "string" },
      "agent-name": { type: "string" },
      "agent-description": { type: "string" },
      "stream-artifacts": { type: "boolean" },
      "no-stream-artifacts": { type: "boolean" },
      "log-level": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
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

  if (values.port || values.hostname || values["advertise-host"]) {
    overrides.server = {};
    if (values.port) overrides.server.port = parseInt(values.port as string, 10);
    if (values.hostname) overrides.server.hostname = values.hostname as string;
    if (values["advertise-host"]) overrides.server.advertiseHost = values["advertise-host"] as string;
  }

  const workspace = (values.workspace ?? values["working-dir"]) as string | undefined;
  const model = values.model as string | undefined;
  const authMode = values["auth-mode"] as string | undefined;
  const apiKey = values["api-key"] as string | undefined;
  const project = values.project as string | undefined;
  const location = values.location as string | undefined;
  const python = values.python as string | undefined;
  if (workspace || model || authMode || apiKey || project || location || python) {
    overrides.antigravity = {};
    if (workspace) overrides.antigravity.workingDirectory = workspace;
    if (model) overrides.antigravity.model = model;
    if (python) overrides.antigravity.pythonPath = python;
    if (authMode || apiKey || project || location) {
      overrides.antigravity.provider = {};
      if (authMode) overrides.antigravity.provider.authMode = authMode as AntigravityConfig["provider"] extends infer P
        ? P extends { authMode?: infer A } ? A : never
        : never;
      if (apiKey) overrides.antigravity.provider.apiKey = apiKey;
      if (project) overrides.antigravity.provider.project = project;
      if (location) overrides.antigravity.provider.location = location;
    }
  }

  if (values["agent-name"] || values["agent-description"]) {
    overrides.agentCard = { name: "", description: "" };
    if (values["agent-name"]) overrides.agentCard.name = values["agent-name"] as string;
    if (values["agent-description"]) overrides.agentCard.description = values["agent-description"] as string;
  }

  const featureOverrides: Partial<AgentConfig["features"]> = {};
  if (values["stream-artifacts"]) featureOverrides.streamArtifactChunks = true;
  if (values["no-stream-artifacts"]) featureOverrides.streamArtifactChunks = false;
  if (Object.keys(featureOverrides).length > 0) {
    overrides.features = featureOverrides as AgentConfig["features"];
  }

  if (values["log-level"]) {
    overrides.logging = { level: values["log-level"] as string };
  }

  return { configPath, overrides };
}

async function main(): Promise<void> {
  if (process.argv[2] === "setup") {
    try {
      const options = parseSetupArgs();
      await setupPythonEnvironment(options);
    } catch (err) {
      printSetupError(err);
      process.exit(1);
    }
    return;
  }

  const { configPath, overrides } = parseCliArgs();
  if (overrides.antigravity?.pythonPath) {
    process.env["A2A_ANTIGRAVITY_EXPLICIT_PYTHON"] = "1";
  }
  const config = resolveConfig(configPath, overrides);
  config.configDir = configPath ? dirname(resolve(configPath)) : process.cwd();

  logger.setLevel(Logger.parseLevel(config.logging?.level ?? "info"));

  log.info("Starting a2a-antigravity", {
    config: configPath ?? "(built-in defaults)",
    agent: config.agentCard.name,
    port: config.server.port,
    authMode: config.antigravity.provider?.authMode ?? "sdkDefault",
  });

  const handle = await createA2AServer(config);
  let shuttingDown = false;

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down...`);
    try {
      await handle.shutdown();
    } catch (err) {
      log.error("Shutdown failed", { error: (err as Error).message, stack: (err as Error).stack });
      process.exit(1);
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception", { error: err.message, stack: err.stack });
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log.error("Unhandled rejection", { error: err.message, stack: err.stack });
    void shutdown("unhandledRejection", 1);
  });
}

main().catch((err) => {
  log.error("Fatal error", { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});

function printSetupError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error("\nSetup failed.");
  console.error(`Reason: ${message}`);

  const remediation = err instanceof PythonSetupError ? err.remediation : [];
  if (remediation.length) {
    console.error("\nNext steps:");
    for (const item of remediation) {
      console.error(`  - ${item}`);
    }
  } else {
    console.error("\nNext steps:");
    console.error("  - Run `a2a-antigravity setup --help` for setup options.");
    console.error("  - Use `ANTIGRAVITY_PYTHON=/path/to/python` if you manage Python yourself.");
  }

  if (process.env["LOG_LEVEL"] === "debug" && err instanceof Error && err.stack) {
    console.error("\nDebug stack:");
    console.error(err.stack);
  }
}
