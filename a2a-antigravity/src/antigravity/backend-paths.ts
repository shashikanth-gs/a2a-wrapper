/**
 * Backend-specific path hooks for shared memory materialization.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendPaths } from "@a2a-wrapper/core";

export const ANTIGRAVITY_BACKEND_PATHS: BackendPaths = {
  instructionsPath: "AGENTS.md",
  skillsBaseDir: ".antigravity/skills",
};

export function resolveBridgePath(override?: string): string {
  if (override) return resolve(override);

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "python/bridge.py"),
    resolve(here, "../../src/antigravity/python/bridge.py"),
    resolve(here, "../src/antigravity/python/bridge.py"),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Unable to locate Antigravity bridge.py. Checked: ${candidates.join(", ")}`,
    );
  }
  return found;
}
