import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  listCodeFiles,
  readNormalised,
  repoRel,
  stripComments,
} from "./source-scan.js";

/**
 * Architecture guard: only `@a2a-wrapper/core` may depend on `@a2a-js/sdk`.
 *
 * See docs/design/core-owned-a2a-boundary.md (section 3, "Enforced by tests").
 * Core owns the A2A protocol and the SDK; provider wrappers speak core's types.
 *
 * Wrappers that have not been migrated yet still import the SDK. That debt is
 * recorded in the allowlists below. THE ALLOWLISTS MAY ONLY SHRINK: delete an
 * entry as each wrapper is migrated (issue #111). Adding an entry means adding
 * new SDK coupling outside core, which this test exists to prevent. A stale
 * entry (one that no longer needs to be there) also fails, so the lists cannot
 * quietly rot.
 */

/** Repo-relative source files (src, tests included) allowed to import the SDK. */
const ALLOWED_SOURCE_FILES: readonly string[] = [
  "a2a-antigravity/src/antigravity/executor.ts",
];

/** Repo-relative package.json files allowed to declare the SDK as a dependency. */
const ALLOWED_PACKAGE_JSON: readonly string[] = [
  "a2a-antigravity/package.json",
];

const SDK = "@a2a-js/sdk";
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Workspace package directories other than core, derived from the root workspaces globs. */
function nonCorePackageDirs(): string[] {
  const root = JSON.parse(readNormalised(join(REPO_ROOT, "package.json"))) as {
    workspaces: string[];
  };
  const dirs: string[] = [];
  for (const glob of root.workspaces) {
    const m = /^(.*)\*(.*)$/.exec(glob);
    if (!m) {
      dirs.push(glob);
      continue;
    }
    const [, prefix, suffix] = m;
    const slash = prefix.lastIndexOf("/");
    const base = slash >= 0 ? prefix.slice(0, slash) : "";
    const namePrefix = slash >= 0 ? prefix.slice(slash + 1) : prefix;
    for (const entry of readdirSync(join(REPO_ROOT, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(namePrefix) || !entry.name.endsWith(suffix)) continue;
      dirs.push(base ? `${base}/${entry.name}` : entry.name);
    }
  }
  return dirs
    .filter((d) => d !== "packages/core")
    .filter((d) => existsSync(join(REPO_ROOT, d, "package.json")))
    .sort();
}

const SDK_STRING = /["'`]@a2a-js\/sdk(?:\/[^"'`]*)?["'`]/;

/** True when the code (comments removed) references the SDK in a string literal. */
function importsSdk(file: string): boolean {
  return SDK_STRING.test(stripComments(readNormalised(file)));
}

function declaresSdk(pkgJsonPath: string): boolean {
  const pkg = JSON.parse(readNormalised(pkgJsonPath)) as Record<
    string,
    Record<string, string> | undefined
  >;
  return DEP_FIELDS.some((f) => pkg[f] !== undefined && SDK in (pkg[f] as Record<string, string>));
}

describe("architecture: only core imports @a2a-js/sdk", () => {
  const packageDirs = nonCorePackageDirs();

  it("discovers the wrapper packages", () => {
    expect(packageDirs).toEqual(
      expect.arrayContaining([
        "a2a-antigravity",
        "a2a-claude",
        "a2a-codex",
        "a2a-copilot",
        "a2a-opencode",
      ]),
    );
  });

  const importers = packageDirs.flatMap((dir) => {
    const src = join(REPO_ROOT, dir, "src");
    return existsSync(src) ? listCodeFiles(src).filter(importsSdk).map(repoRel) : [];
  });

  it("no source file outside core imports the SDK, except the shrinking allowlist", () => {
    const unexpected = importers.filter((f) => !ALLOWED_SOURCE_FILES.includes(f));
    expect(
      unexpected,
      `New ${SDK} import outside packages/core. Use core's own types instead.`,
    ).toEqual([]);
  });

  it("every source allowlist entry still imports the SDK (the list must shrink)", () => {
    const stale = ALLOWED_SOURCE_FILES.filter((f) => !importers.includes(f));
    expect(
      stale,
      `These files no longer import ${SDK} (or no longer exist). Remove them from ALLOWED_SOURCE_FILES.`,
    ).toEqual([]);
  });

  const declarers = packageDirs
    .map((d) => `${d}/package.json`)
    .filter((p) => declaresSdk(join(REPO_ROOT, p)));

  it("no package.json outside core declares the SDK, except the shrinking allowlist", () => {
    const unexpected = declarers.filter((p) => !ALLOWED_PACKAGE_JSON.includes(p));
    expect(unexpected, `New ${SDK} dependency outside packages/core.`).toEqual([]);
  });

  it("every package.json allowlist entry still declares the SDK (the list must shrink)", () => {
    const stale = ALLOWED_PACKAGE_JSON.filter((p) => !declarers.includes(p));
    expect(
      stale,
      `These package.json files no longer declare ${SDK}. Remove them from ALLOWED_PACKAGE_JSON.`,
    ).toEqual([]);
  });

  it("stripComments ignores mentions in comments but sees string imports", () => {
    expect(SDK_STRING.test(stripComments(`// from "${SDK}"\n/* "${SDK}" */\nconst a = 1;`))).toBe(false);
    expect(SDK_STRING.test(stripComments(`import type { X } from "${SDK}/server";`))).toBe(true);
    expect(SDK_STRING.test(stripComments(`vi.mock('${SDK}', () => ({}));`))).toBe(true);
  });
});
