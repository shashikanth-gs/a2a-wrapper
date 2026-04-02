import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Property-based test for workspace package publish configuration consistency.
 *
 * Feature: monorepo-restructure, Property 2: Workspace package publish configuration
 *
 * Validates: Requirements 8.1, 8.2, 8.4, 8.5, 8.6
 */

/** Resolve the repository root (two levels up from packages/core/src). */
const REPO_ROOT = resolve(__dirname, "../../../../..");

/** Semver pattern: major.minor.patch (optionally with pre-release / build metadata). */
const SEMVER_REGEX = /^\d+\.\d+\.\d+/;

/** Read workspace globs from root package.json and resolve directories. */
function getWorkspacePackageDirs(): string[] {
  const rootPkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
  );
  const workspaceGlobs: string[] = rootPkg.workspaces ?? [];
  const dirs: string[] = [];
  for (const pattern of workspaceGlobs) {
    dirs.push(...globSync(pattern, { cwd: REPO_ROOT }));
  }
  return dirs;
}

const workspaceDirs = getWorkspacePackageDirs();

// Feature: monorepo-restructure, Property 2: Workspace package publish configuration
describe("Property 2: Workspace package publish configuration consistency", () => {
  it("all workspace packages have valid version, publishConfig.access, and files array", () => {
    // Precondition: we discovered at least one workspace package
    expect(workspaceDirs.length).toBeGreaterThan(0);

    const arbWorkspaceDir = fc.constantFrom(...workspaceDirs);

    fc.assert(
      fc.property(arbWorkspaceDir, (pkgDir) => {
        const pkgJsonPath = join(REPO_ROOT, pkgDir, "package.json");
        const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));

        // **Validates: Requirement 8.1** — each package has a version field with valid semver
        expect(pkg.version).toBeDefined();
        expect(typeof pkg.version).toBe("string");
        expect(pkg.version).toMatch(SEMVER_REGEX);

        // **Validates: Requirement 8.2** — publishConfig.access is "public"
        expect(pkg.publishConfig).toBeDefined();
        expect(pkg.publishConfig.access).toBe("public");

        // **Validates: Requirements 8.4, 8.5, 8.6** — files array exists
        expect(Array.isArray(pkg.files)).toBe(true);
        expect(pkg.files.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });
});
