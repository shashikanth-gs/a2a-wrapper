/**
 * Configuration Loader
 *
 * Provides a generic, layered configuration loading pipeline for A2A agent
 * wrapper projects. Configuration is resolved by merging four layers in
 * ascending priority order:
 *
 *   **defaults ← JSON config file ← environment overrides ← CLI overrides**
 *
 * Each layer is deep-merged using {@link deepMerge} from the utils module,
 * ensuring that nested objects are recursively merged while arrays are
 * replaced and `undefined` values are skipped.
 *
 * This module is intentionally backend-agnostic. It does **not** include
 * `loadEnvOverrides` or `substituteEnvTokensInMcpArgs` — those are
 * wrapper-specific concerns that each project implements independently.
 *
 * @module config/loader
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { deepMerge } from "../utils/deep-merge.js";
import type { BaseAgentConfig } from "./types.js";

// ─── JSON File Loader ───────────────────────────────────────────────────────

/**
 * Read and parse a JSON configuration file from disk.
 *
 * The provided `filePath` is resolved to an absolute path before reading.
 * If the file cannot be read or its contents are not valid JSON, a
 * descriptive `Error` is thrown that includes the absolute file path and
 * the underlying error message — making it straightforward to diagnose
 * deployment-time configuration issues.
 *
 * @typeParam T - The expected shape of the parsed configuration object.
 *   No runtime validation is performed; the caller is responsible for
 *   ensuring the file contents match `T`.
 *
 * @param filePath - Relative or absolute path to the JSON configuration
 *   file. Resolved against `process.cwd()` when relative.
 * @returns The parsed configuration object cast to `T`.
 *
 * @throws {Error} When the file cannot be read (e.g. missing, permission
 *   denied) or when the contents are not valid JSON. The error message
 *   includes the absolute file path and the underlying cause.
 *
 * @example
 * ```typescript
 * interface MyConfig { port: number; host: string }
 * const config = loadConfigFile<MyConfig>("./config.json");
 * // config.port, config.host are available
 * ```
 */
export function loadConfigFile<T>(filePath: string): T {
  const absPath = resolve(filePath);
  try {
    const raw = readFileSync(absPath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load config file "${absPath}": ${msg}`);
  }
}

// ─── Merge Pipeline ─────────────────────────────────────────────────────────

/**
 * Build the final resolved configuration by merging four layers in
 * ascending priority order:
 *
 *   **defaults ← config file ← environment overrides ← CLI overrides**
 *
 * Each layer is deep-merged using {@link deepMerge}, which recursively
 * merges nested objects, replaces arrays, skips `undefined` values, and
 * allows `null` to explicitly clear a field.
 *
 * The function is generic over `T` (which must extend
 * {@link BaseAgentConfig}), so each wrapper project can pass its own full
 * config type through the pipeline and receive a fully typed result.
 *
 * @typeParam T - The full configuration type for the wrapper project.
 *   Must extend `BaseAgentConfig<unknown>` to ensure the standard shared
 *   sections (agentCard, server, session, etc.) are present.
 *
 * @param defaults - The complete default configuration object. This serves
 *   as the base layer and should have every field populated so that the
 *   returned config is guaranteed to be fully resolved.
 * @param configFilePath - Optional path to a JSON configuration file. When
 *   provided, the file is loaded via {@link loadConfigFile} and merged on
 *   top of `defaults`.
 * @param envOverrides - Optional partial configuration derived from
 *   environment variables. Merged on top of the file layer.
 * @param cliOverrides - Optional partial configuration derived from CLI
 *   arguments. Merged last, giving CLI flags the highest precedence.
 * @returns The fully resolved configuration with all fields populated.
 *
 * @throws {Error} If `configFilePath` is provided but the file cannot be
 *   read or parsed (propagated from {@link loadConfigFile}).
 *
 * @example
 * ```typescript
 * import type { BaseAgentConfig } from "./types.js";
 *
 * interface MyBackend { apiKey: string }
 * type MyConfig = BaseAgentConfig<MyBackend>;
 *
 * const resolved = resolveConfig<MyConfig>(
 *   MY_DEFAULTS,
 *   "./config.json",
 *   envOverrides,
 *   cliOverrides,
 * );
 * // resolved.server.port, resolved.backend.apiKey, etc.
 * ```
 */
export function resolveConfig<T extends BaseAgentConfig<unknown>>(
  defaults: Required<T>,
  configFilePath?: string,
  envOverrides?: Partial<T>,
  cliOverrides?: Partial<T>,
): Required<T> {
  let merged = deepMerge(
    {} as Record<string, unknown>,
    defaults as unknown as Record<string, unknown>,
  );

  // Layer 1: JSON config file
  if (configFilePath) {
    const fileConfig = loadConfigFile<T>(configFilePath);
    merged = deepMerge(merged, fileConfig as unknown as Record<string, unknown>);
  }

  // Layer 2: Environment variable overrides
  if (envOverrides) {
    merged = deepMerge(merged, envOverrides as unknown as Record<string, unknown>);
  }

  // Layer 3: CLI argument overrides (highest precedence)
  if (cliOverrides) {
    merged = deepMerge(merged, cliOverrides as unknown as Record<string, unknown>);
  }

  return merged as unknown as Required<T>;
}
