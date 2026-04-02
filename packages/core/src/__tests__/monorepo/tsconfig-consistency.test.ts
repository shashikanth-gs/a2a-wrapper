import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Property-based test for TypeScript configuration consistency
 * across all workspace packages in the monorepo.
 *
 * Validates: Requirements 11.2, 11.3, 11.4, 11.5
 */

/** Resolve the repository root (two levels up from packages/core/src). */
const REPO_ROOT = resolve(__dirname, "../../../../..");

/** Resolve workspace directories from root package.json globs. */
function getWorkspacePackageDirs(): string[] {
  const rootPkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
  );
  const workspaceGlobs: string[] = rootPkg.workspaces ?? [];
  const dirs: string[] = [];
  for (const pattern of workspaceGlobs) {
    if (pattern === "packages/*") {
      const packagesDir = join(REPO_ROOT, "packages");
      if (existsSync(packagesDir)) {
        for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
          if (entry.isDirectory()) dirs.push(`packages/${entry.name}`);
        }
      }
    } else if (pattern === "a2a-*") {
      for (const entry of readdirSync(REPO_ROOT, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("a2a-")) {
          dirs.push(entry.name);
        }
      }
    }
  }
  return dirs;
}

const workspaceDirs = getWorkspacePackageDirs();

// Feature: monorepo-restructure, Property 1: TypeScript configuration consistency
describe("Property 1: TypeScript configuration consistency", () => {
  it("all workspace packages have consistent tsconfig.json compilerOptions", () => {
    // Precondition: we discovered at least one workspace package
    expect(workspaceDirs.length).toBeGreaterThan(0);

    /**
     * Arbitrary that samples from the discovered workspace directories.
     * fast-check picks a random package each iteration, ensuring the
     * property is exercised across all packages over many runs.
     */
    const arbWorkspaceDir = fc.constantFrom(...workspaceDirs);

    fc.assert(
      fc.property(arbWorkspaceDir, (pkgDir) => {
        const tsconfigPath = join(REPO_ROOT, pkgDir, "tsconfig.json");
        const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
        const opts = tsconfig.compilerOptions;

        // **Validates: Requirement 11.4** — module and moduleResolution
        expect(opts.module).toBe("NodeNext");
        expect(opts.moduleResolution).toBe("NodeNext");

        // **Validates: Requirement 11.5** — target ES2022
        expect(opts.target).toBe("ES2022");

        // **Validates: Requirement 11.2** — declaration files
        expect(opts.declaration).toBe(true);
        expect(opts.declarationMap).toBe(true);

        // **Validates: Requirement 11.3** — source maps
        expect(opts.sourceMap).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
