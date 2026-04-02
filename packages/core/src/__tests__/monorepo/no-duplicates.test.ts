import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { existsSync } from "node:fs";
import { globSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Property-based test for no duplicate artifacts in wrapper directories.
 *
 * Feature: monorepo-restructure, Property 3: No duplicate artifacts in wrappers
 *
 * Validates: Requirements 9.1, 9.2, 3.5, 3.6, 5.8, 5.9, 6.2, 6.3, 6.6, 6.7, 7.2, 7.3
 */

/** Resolve the repository root (two levels up from packages/core/src). */
const REPO_ROOT = resolve(__dirname, "../../../../..");

/**
 * Files and directories that must NOT exist inside any a2a-* wrapper directory
 * after the monorepo restructure consolidates them at the root.
 */
const FORBIDDEN_ARTIFACTS = [
  ".git",
  ".github",
  ".gitignore",
  "package-lock.json",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "LICENSE",
];

/** Discover all a2a-* wrapper directories at the repository root. */
function getWrapperDirs(): string[] {
  return globSync("a2a-*", { cwd: REPO_ROOT });
}

const wrapperDirs = getWrapperDirs();

// Feature: monorepo-restructure, Property 3: No duplicate artifacts in wrappers
describe("Property 3: No duplicate artifacts in wrapper directories", () => {
  it("no a2a-* wrapper directory contains forbidden duplicate artifacts", () => {
    // Precondition: we discovered at least one wrapper directory
    expect(wrapperDirs.length).toBeGreaterThan(0);

    const arbWrapperDir = fc.constantFrom(...wrapperDirs);

    fc.assert(
      fc.property(arbWrapperDir, (wrapperDir) => {
        for (const artifact of FORBIDDEN_ARTIFACTS) {
          const artifactPath = join(REPO_ROOT, wrapperDir, artifact);

          // **Validates: Requirements 9.1, 9.2** — no duplicate artifacts in wrappers
          // **Validates: Requirements 3.5, 3.6** — community docs removed from wrappers
          // **Validates: Requirements 5.8, 5.9** — .github/ removed from wrappers
          // **Validates: Requirements 6.2, 6.3** — .git/ removed from wrappers
          // **Validates: Requirements 6.6, 6.7** — .gitignore removed from wrappers
          // **Validates: Requirements 7.2, 7.3** — package-lock.json removed from wrappers
          expect(
            existsSync(artifactPath),
            `Expected ${wrapperDir}/${artifact} to NOT exist`,
          ).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
