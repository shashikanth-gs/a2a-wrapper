/**
 * CLI Scaffold
 *
 * Provides a reusable, generic CLI entry-point factory for A2A wrapper
 * projects. Each wrapper calls {@link createCli} once with its package
 * metadata, default configuration, backend-specific argument parser, and
 * executor factory. The scaffold handles everything else: common flag
 * parsing, layered config resolution, log-level setup, server creation,
 * and graceful shutdown on SIGINT / SIGTERM.
 *
 * This module is intentionally backend-agnostic. Wrapper-specific flags
 * (e.g. `--cli-url`, `--opencode-url`) are injected via
 * {@link CliOptions.extraArgDefs} and parsed by the wrapper's
 * {@link CliOptions.parseBackendArgs} callback.
 *
 * The exported {@link parseCommonArgs} helper is also available for unit
 * and property-based testing of the common flag parsing logic without
 * triggering the full main-loop side effects.
 *
 * @module cli/scaffold
 */

import { parseArgs } from "node:util";

import { resolveConfig } from "../config/loader.js";
import type { BaseAgentConfig } from "../config/types.js";
import { createLogger, Logger, LogLevel } from "../utils/logger.js";
import { createA2AServer } from "../server/factory.js";
import type { ServerOptions, A2AExecutor } from "../server/factory.js";

// ─── Common Arg Definitions ────────────────────────────────────────────────

/**
 * `parseArgs` option definitions for the flags shared across all wrappers.
 *
 * These are merged with any wrapper-specific {@link CliOptions.extraArgDefs}
 * before calling `node:util/parseArgs`.
 *
 * @internal
 */
const COMMON_ARG_DEFS: Record<string, { type: "string" | "boolean"; short?: string }> = {
  "agent-json":          { type: "string" },
  config:                { type: "string",  short: "c" },
  port:                  { type: "string",  short: "p" },
  hostname:              { type: "string" },
  "advertise-host":      { type: "string" },
  "agent-name":          { type: "string" },
  "agent-description":   { type: "string" },
  "stream-artifacts":    { type: "boolean" },
  "no-stream-artifacts": { type: "boolean" },
  "log-level":           { type: "string" },
  help:                  { type: "boolean", short: "h" },
  version:               { type: "boolean", short: "v" },
};

// ─── CliOptions Interface ──────────────────────────────────────────────────

/**
 * Configuration object accepted by {@link createCli}.
 *
 * Each wrapper project constructs a `CliOptions` value that wires together
 * its package metadata, default configuration, backend-specific argument
 * parsing, environment variable loading, and executor factory. The CLI
 * scaffold uses these to implement the full main-loop without any
 * backend-specific knowledge.
 *
 * @typeParam T - The full configuration type for the wrapper project.
 *   Must extend {@link BaseAgentConfig} so that the shared config sections
 *   (agentCard, server, session, logging, etc.) are guaranteed to exist.
 *
 * @example
 * ```typescript
 * import { createCli, type CliOptions } from "@a2a-wrapper/core";
 * import type { AgentConfig } from "./config/types.js";
 *
 * const options: CliOptions<AgentConfig> = {
 *   packageName: "a2a-copilot",
 *   version: "1.0.0",
 *   defaults: DEFAULTS,
 *   usage: "Usage: a2a-copilot [options]\n...",
 *   parseBackendArgs: (values) => ({ ... }),
 *   loadEnvOverrides: () => ({ ... }),
 *   executorFactory: (config) => new CopilotExecutor(config),
 * };
 *
 * createCli(options);
 * ```
 */
export interface CliOptions<T extends BaseAgentConfig<unknown>> {
  /**
   * Package name used in `--help` output and log messages.
   *
   * @example "a2a-copilot"
   */
  packageName: string;

  /**
   * Package version printed by `--version`.
   *
   * @example "1.2.3"
   */
  version: string;

  /**
   * Complete default configuration object with every field populated.
   *
   * This serves as the base layer in the config merge pipeline
   * (defaults ← file ← env ← CLI).
   */
  defaults: Required<T>;

  /**
   * Usage text printed when `--help` is passed.
   *
   * Should include all common and wrapper-specific flags with descriptions
   * and examples.
   */
  usage: string;

  /**
   * Parse wrapper-specific CLI arguments into config overrides.
   *
   * Called after common flags (`--port`, `--hostname`, etc.) have been
   * extracted. The `values` parameter contains the raw parsed values from
   * `node:util/parseArgs`, including both common and extra arg definitions.
   * The callback should return a partial config containing only the
   * backend-specific fields derived from wrapper-specific flags.
   *
   * @param values - Raw parsed argument values from `parseArgs`.
   * @returns Partial configuration with backend-specific overrides.
   */
  parseBackendArgs: (values: Record<string, unknown>) => Partial<T>;

  /**
   * Load wrapper-specific environment variable overrides.
   *
   * Called during config resolution to inject environment-based overrides
   * into the merge pipeline (layer 2: env overrides).
   *
   * @returns Partial configuration with environment-derived overrides.
   */
  loadEnvOverrides: () => Partial<T>;

  /**
   * Factory function that creates the backend-specific executor.
   *
   * Called with the fully resolved configuration after all merge layers
   * have been applied. The returned executor is passed to
   * {@link createA2AServer} for initialization and request handling.
   *
   * @param config - The fully resolved configuration.
   * @returns A new {@link A2AExecutor} instance.
   */
  executorFactory: (config: Required<T>) => A2AExecutor;

  /**
   * Optional server customization options.
   *
   * Passed through to {@link createA2AServer} for protocol version
   * overrides and custom route registration hooks.
   */
  serverOptions?: ServerOptions;

  /**
   * Additional `parseArgs` option definitions for wrapper-specific flags.
   *
   * These are merged with the common flag definitions before calling
   * `node:util/parseArgs`. Keys are flag names (without `--` prefix),
   * values specify the type and optional short alias.
   *
   * @example
   * ```typescript
   * extraArgDefs: {
   *   "cli-url":   { type: "string" },
   *   "model":     { type: "string", short: "m" },
   *   "workspace": { type: "string", short: "w" },
   * }
   * ```
   */
  extraArgDefs?: Record<string, { type: "string" | "boolean"; short?: string }>;
}

// ─── Common Args Result ────────────────────────────────────────────────────

/**
 * Result of parsing common CLI flags via {@link parseCommonArgs}.
 *
 * Contains the config file path (if specified) and a partial config object
 * with overrides derived from the common flags. This type is intentionally
 * generic so that the partial config can be merged with wrapper-specific
 * overrides before being passed to {@link resolveConfig}.
 *
 * @typeParam T - The full configuration type (extends {@link BaseAgentConfig}).
 */
export interface CommonArgsResult<T extends BaseAgentConfig<unknown>> {
  /** Path to the JSON config file, if `--agent-json` or `--config` was provided. */
  configPath?: string;
  /** Partial config overrides derived from common CLI flags. */
  overrides: Partial<T>;
}

// ─── parseCommonArgs ───────────────────────────────────────────────────────

/**
 * Extract common CLI overrides from raw parsed argument values.
 *
 * This pure function maps the shared CLI flags (`--port`, `--hostname`,
 * `--advertise-host`, `--agent-name`, `--agent-description`,
 * `--stream-artifacts` / `--no-stream-artifacts`, `--log-level`) into a
 * partial {@link BaseAgentConfig} structure suitable for merging into the
 * config resolution pipeline.
 *
 * Exported separately from {@link createCli} so that property-based tests
 * can validate flag-to-config mapping without triggering the full
 * main-loop side effects (server creation, signal handlers, etc.).
 *
 * @typeParam T - The full configuration type (extends {@link BaseAgentConfig}).
 *
 * @param values - Raw parsed argument values from `node:util/parseArgs`.
 *   Expected to contain string/boolean entries keyed by flag name (without
 *   the `--` prefix).
 * @returns A {@link CommonArgsResult} with the config file path and
 *   partial config overrides.
 *
 * @example
 * ```typescript
 * import { parseCommonArgs } from "@a2a-wrapper/core";
 *
 * const result = parseCommonArgs({ port: "3001", "agent-name": "Test" });
 * // result.overrides.server?.port === 3001
 * // result.overrides.agentCard?.name === "Test"
 * ```
 */
export function parseCommonArgs<T extends BaseAgentConfig<unknown>>(
  values: Record<string, unknown>,
): CommonArgsResult<T> {
  const overrides: Record<string, unknown> = {};

  // Config file path (--agent-json or --config)
  const configPath = (values["agent-json"] ?? values["config"]) as string | undefined;

  // Server overrides
  const port = values["port"] as string | undefined;
  const hostname = values["hostname"] as string | undefined;
  const advertiseHost = values["advertise-host"] as string | undefined;

  if (port !== undefined || hostname !== undefined || advertiseHost !== undefined) {
    const server: Record<string, unknown> = {};
    if (port !== undefined) server.port = parseInt(port, 10);
    if (hostname !== undefined) server.hostname = hostname;
    if (advertiseHost !== undefined) server.advertiseHost = advertiseHost;
    overrides.server = server;
  }

  // Agent card overrides
  const agentName = values["agent-name"] as string | undefined;
  const agentDescription = values["agent-description"] as string | undefined;

  if (agentName !== undefined || agentDescription !== undefined) {
    const agentCard: Record<string, unknown> = {};
    if (agentName !== undefined) agentCard.name = agentName;
    if (agentDescription !== undefined) agentCard.description = agentDescription;
    overrides.agentCard = agentCard;
  }

  // Feature flag overrides
  const streamArtifacts = values["stream-artifacts"] as boolean | undefined;
  const noStreamArtifacts = values["no-stream-artifacts"] as boolean | undefined;

  const features: Record<string, unknown> = {};
  if (streamArtifacts === true) features.streamArtifactChunks = true;
  if (noStreamArtifacts === true) features.streamArtifactChunks = false;

  if (Object.keys(features).length > 0) {
    overrides.features = features;
  }

  // Logging overrides
  const logLevel = values["log-level"] as string | undefined;
  if (logLevel !== undefined) {
    overrides.logging = { level: logLevel };
  }

  return { configPath, overrides: overrides as Partial<T> };
}

// ─── createCli ─────────────────────────────────────────────────────────────

/**
 * Create and run the CLI entry point for an A2A wrapper project.
 *
 * Implements the standard main-loop pattern shared by all wrappers:
 *
 * 1. **Parse arguments** — merges common flag definitions with any
 *    wrapper-specific {@link CliOptions.extraArgDefs}, then calls
 *    `node:util/parseArgs`. Handles `--help` (print usage, exit 0) and
 *    `--version` (print version, exit 0) immediately.
 * 2. **Resolve configuration** — calls {@link parseCommonArgs} for shared
 *    flags, {@link CliOptions.parseBackendArgs} for wrapper-specific flags,
 *    and {@link CliOptions.loadEnvOverrides} for environment variables.
 *    Merges all layers via {@link resolveConfig}: defaults ← file ← env ← CLI.
 * 3. **Set log level** — parses the resolved `logging.level` string and
 *    applies it to the root logger.
 * 4. **Create server** — calls {@link createA2AServer} with the resolved
 *    config, executor factory, and optional server options.
 * 5. **Register signal handlers** — installs SIGINT and SIGTERM handlers
 *    that call `handle.shutdown()` and exit cleanly.
 * 6. **Fatal error handling** — wraps the entire main-loop in a catch
 *    that logs the error with stack trace and exits with code 1.
 *
 * @typeParam T - The full configuration type for the wrapper project.
 *   Must extend {@link BaseAgentConfig} so that the shared config sections
 *   are guaranteed to exist.
 *
 * @param options - CLI configuration specifying package metadata, defaults,
 *   argument parsers, and the executor factory.
 *
 * @example
 * ```typescript
 * import { createCli } from "@a2a-wrapper/core";
 * import { DEFAULTS } from "./config/defaults.js";
 * import { CopilotExecutor } from "./copilot/executor.js";
 *
 * createCli({
 *   packageName: "a2a-copilot",
 *   version: "1.0.0",
 *   defaults: DEFAULTS,
 *   usage: "Usage: a2a-copilot [options]\n...",
 *   parseBackendArgs: (values) => { ... },
 *   loadEnvOverrides: () => { ... },
 *   executorFactory: (config) => new CopilotExecutor(config),
 * });
 * ```
 */
export function createCli<T extends BaseAgentConfig<unknown>>(
  options: CliOptions<T>,
): void {
  const {
    packageName,
    version,
    defaults,
    usage,
    parseBackendArgs,
    loadEnvOverrides,
    executorFactory,
    serverOptions,
    extraArgDefs,
  } = options;

  const logger: Logger = createLogger(packageName);
  const log: Logger = logger.child("cli");

  // ── Async main loop ───────────────────────────────────────────────────
  async function main(): Promise<void> {
    // 1. Parse CLI arguments
    const allArgDefs = { ...COMMON_ARG_DEFS, ...extraArgDefs };

    const { values } = parseArgs({
      options: allArgDefs,
      strict: false,
    });

    // Handle --help
    if (values.help) {
      console.log(usage);
      process.exit(0);
    }

    // Handle --version
    if (values.version) {
      console.log(version);
      process.exit(0);
    }

    // 2. Build config overrides from common + backend args
    const commonResult = parseCommonArgs<T>(values as Record<string, unknown>);
    const backendOverrides = parseBackendArgs(values as Record<string, unknown>);

    // Merge common overrides with backend overrides for the CLI layer
    const cliOverrides: Partial<T> = {
      ...commonResult.overrides,
      ...backendOverrides,
    };

    // Load environment variable overrides
    const envOverrides = loadEnvOverrides();

    // 3. Resolve config: defaults ← file ← env ← CLI
    const config = resolveConfig<T>(
      defaults,
      commonResult.configPath,
      envOverrides,
      cliOverrides,
    );

    // 4. Set log level
    const levelStr = config.logging?.level ?? "info";
    logger.setLevel(Logger.parseLevel(levelStr));

    if (!commonResult.configPath) {
      log.info(
        "No --agent-json provided — running with built-in defaults. " +
        "Pass --agent-json <path> to load a custom agent.",
      );
    }

    log.info(`Starting ${packageName}`, {
      config: commonResult.configPath ?? "(built-in defaults)",
      agent: config.agentCard?.name,
      port: config.server?.port,
    });

    // 5. Create and start the A2A server
    const handle = await createA2AServer<T>(
      config,
      executorFactory,
      serverOptions,
    );

    // 6. Register graceful shutdown handlers
    const shutdown = async (signal: string): Promise<void> => {
      log.info(`${signal} received, shutting down...`);
      await handle.shutdown();
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  // Fatal error handler — log with stack trace and exit 1
  main().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("Fatal error", {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });
}
