#!/usr/bin/env node

/**
 * Postinstall patch for vscode-jsonrpc ESM compatibility (Node 22+).
 *
 * vscode-jsonrpc@8.2.1 (transitive dep of @github/copilot-sdk) ships without
 * an `exports` map.  Node 22's stricter ESM resolver rejects the
 * `vscode-jsonrpc/node` subpath import, crashing a2a-copilot at startup.
 *
 * This script adds the missing `exports` field so the subpath resolves on
 * every supported Node version.  It is idempotent — if `exports` already
 * exists the file is left untouched.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const EXPORTS_PATCH = {
  "./node": "./lib/node/main.js",
  ".": "./lib/common/api.js",
};

/** Candidate locations where vscode-jsonrpc may be installed. */
const candidates = [
  join(root, "node_modules", "vscode-jsonrpc", "package.json"),
  join(
    root,
    "node_modules",
    "@github",
    "copilot-sdk",
    "node_modules",
    "vscode-jsonrpc",
    "package.json",
  ),
];

let found = false;

for (const pkgPath of candidates) {
  let raw;
  try {
    raw = readFileSync(pkgPath, "utf-8");
  } catch {
    // This candidate doesn't exist — try the next one.
    continue;
  }

  found = true;

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    console.warn(`[postinstall] Could not parse ${pkgPath} — skipping.`);
    continue;
  }

  if (pkg.exports) {
    console.log(
      `[postinstall] vscode-jsonrpc already has exports — no patch needed.`,
    );
    continue;
  }

  pkg.exports = EXPORTS_PATCH;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n", "utf-8");
  console.log(
    `[postinstall] Patched vscode-jsonrpc exports in ${pkgPath}`,
  );
}

if (!found) {
  console.warn(
    "[postinstall] vscode-jsonrpc not found in node_modules — skipping patch.",
  );
}
