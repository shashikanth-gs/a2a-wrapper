/**
 * Well-Known Path Defaults & Resolution
 *
 * Provides convenience path mappings for known backend runtimes and a utility
 * function for resolving memory config paths (relative or absolute) to absolute
 * filesystem paths.
 *
 * Wrappers MAY use the well-known defaults directly or define their own
 * `BackendPaths` constant. Adding a new runtime does NOT require modifying
 * this file — just define a `BackendPaths` constant in the new wrapper project.
 *
 * @module memory/paths
 */

import path from "node:path";
import type { BackendPaths } from "./types.js";

/**
 * Well-known backend path mappings exported as a convenience.
 *
 * Wrappers MAY use these directly or define their own BackendPaths.
 * Adding a new runtime does NOT require modifying this file — just
 * define a BackendPaths constant in the new wrapper project.
 *
 * These are reference implementations, not an authoritative registry.
 */
export const WELL_KNOWN_PATHS = {
  copilot: {
    instructionsPath: ".github/copilot-instructions.md",
    skillsBaseDir: ".github/skills",
  } satisfies BackendPaths,

  claude: {
    instructionsPath: "CLAUDE.md",
    skillsBaseDir: ".claude/skills",
  } satisfies BackendPaths,

  opencode: {
    instructionsPath: ".opencode/instructions.md",
    skillsBaseDir: ".opencode/skills",
  } satisfies BackendPaths,

  codex: {
    instructionsPath: ".codex/instructions.md",
    skillsBaseDir: ".agents/skills",
  } satisfies BackendPaths,
} as const;

/**
 * Resolve a memory config path (instructions or skill directory) to an
 * absolute filesystem path.
 *
 * - If the input is an absolute path, returns `path.normalize(inputPath)`.
 * - If the input is a relative path, resolves it against `configDir`.
 *
 * @param inputPath - The path from memory config (relative or absolute)
 * @param configDir - The directory containing the agent's config.json
 * @returns An absolute, normalized filesystem path
 */
export function resolveMemoryPath(inputPath: string, configDir: string): string {
  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }
  return path.resolve(configDir, inputPath);
}
