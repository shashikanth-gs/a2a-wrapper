/**
 * @module codex/model-resolver
 *
 * Resolves the `codex.model` setting.
 *
 * An explicit name is used as is. `auto` (the default, also unset, empty or
 * `default`) picks the first model Codex itself lists for the logged-in account,
 * so the wrapper works out of the box instead of inheriting whatever the
 * desktop app pinned in `~/.codex/config.toml` (a ChatGPT account rejects models
 * that are not in its catalog).
 *
 * The catalog comes from `codex debug models` (the supported way to list it),
 * falling back to the cache file Codex keeps (`<CODEX_HOME>/models_cache.json`).
 * If neither is available the model is left unset and Codex applies its own
 * default, which is the previous behaviour.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isAutoModel, normalizeModel } from "@a2a-wrapper/core";
import { logger } from "../utils/logger.js";

const log = logger.child("model");

/** Upper bound for `codex debug models`; a slow CLI must not block startup. */
const CATALOG_TIMEOUT_MS = 15_000;

interface CatalogModel {
  slug?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

/** Test seams. */
export interface ModelResolverDeps {
  /** stdout of `codex debug models`. */
  runCatalog?: (codexPath: string | undefined) => Promise<string>;
  /** Contents of the catalog cache file. */
  readCache?: () => Promise<string>;
}

export interface ModelResolverOptions {
  /** `codex.codexPathOverride`: the binary to run for `debug models`. */
  codexPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The first listed model by priority, or `undefined` when the catalog has none.
 * Accepts the raw catalog JSON (`{ models: [...] }` or a bare array).
 */
export function pickModelFromCatalog(catalog: unknown): string | undefined {
  const raw = Array.isArray(catalog) ? catalog : (catalog as { models?: unknown } | null)?.models;
  if (!Array.isArray(raw)) return undefined;

  const models = (raw as CatalogModel[]).filter(
    (m): m is CatalogModel & { slug: string } => typeof m?.slug === "string" && m.slug.length > 0,
  );
  const byPriority = (a: CatalogModel, b: CatalogModel) =>
    (typeof a.priority === "number" ? a.priority : Infinity) -
    (typeof b.priority === "number" ? b.priority : Infinity);

  const listed = models.filter((m) => m.visibility === "list").sort(byPriority);
  if (listed.length) return listed[0]!.slug;

  // Unknown or missing visibility values: take the best model that is not hidden.
  const visible = models.filter((m) => m.visibility !== "hide" && m.visibility !== "none").sort(byPriority);
  return visible[0]?.slug;
}

function defaultRunCatalog(codexPath: string | undefined): Promise<string> {
  const bin = codexPath || "codex";
  // On Windows the npm shim is codex.cmd, which cannot be spawned without a shell.
  // The arguments are constants; only the operator-configured path is interpolated.
  const useShell = process.platform === "win32";
  const cmd = useShell && /\s/.test(bin) ? `"${bin}"` : bin;
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      ["debug", "models"],
      { timeout: CATALOG_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: useShell },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

function defaultReadCache(env: NodeJS.ProcessEnv): () => Promise<string> {
  const home = env["CODEX_HOME"] || join(homedir(), ".codex");
  return () => readFile(join(home, "models_cache.json"), "utf8");
}

/**
 * Resolve the model to pass to Codex. Never throws: any failure to read the
 * catalog leaves the model unset so Codex chooses.
 */
export async function resolveCodexModel(
  configured: unknown,
  options: ModelResolverOptions = {},
  deps: ModelResolverDeps = {},
): Promise<string | undefined> {
  if (!isAutoModel(configured)) return normalizeModel(configured);

  const env = options.env ?? process.env;
  const runCatalog = deps.runCatalog ?? defaultRunCatalog;
  const readCache = deps.readCache ?? defaultReadCache(env);

  for (const [source, load] of [
    ["codex debug models", () => runCatalog(options.codexPath)],
    ["models cache file", readCache],
  ] as const) {
    try {
      const picked = pickModelFromCatalog(JSON.parse(await load()));
      if (picked) {
        log.info("Resolved model from the Codex account catalog", { model: picked, source });
        return picked;
      }
    } catch (e) {
      log.debug("Model catalog unavailable", { source, error: (e as Error).message });
    }
  }

  log.info("No model catalog available; Codex will use its own default model");
  return undefined;
}
