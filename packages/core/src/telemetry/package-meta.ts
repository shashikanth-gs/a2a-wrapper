/**
 * Resolve package identity for OTel attributes without hard-coding versions
 * in every call site. Core version always comes from `@a2a-wrapper/core`'s
 * package.json; wrapper SDK name/version are supplied by each `a2a-*` package.
 *
 * @module telemetry/package-meta
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let _coreVersion: string | undefined;

/**
 * Version of the installed `@a2a-wrapper/core` package (from its package.json).
 * Falls back to `"unknown"` only if package.json cannot be read.
 */
export function getCorePackageVersion(): string {
  if (_coreVersion) return _coreVersion;
  try {
    // Dist layout: …/packages/core/dist/telemetry/package-meta.js → ../../package.json
    // Src/vitest:  …/packages/core/src/telemetry/package-meta.ts → ../../package.json
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = require(join(here, "..", "..", "package.json")) as { version?: string };
    _coreVersion = pkg.version ?? "unknown";
  } catch {
    _coreVersion = "unknown";
  }
  return _coreVersion;
}

/** Read `{ name, version }` from a package.json via createRequire from a caller URL. */
export function readPackageIdentity(
  requireFromUrl: string,
  relativePackageJson = "../package.json",
): { name: string; version: string } {
  const req = createRequire(requireFromUrl);
  const pkg = req(relativePackageJson) as { name?: string; version?: string };
  return {
    name: pkg.name ?? "unknown",
    version: pkg.version ?? "unknown",
  };
}
