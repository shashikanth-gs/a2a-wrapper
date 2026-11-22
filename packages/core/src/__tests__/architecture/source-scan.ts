import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Shared helpers for the architecture guard tests. These read repository
 * files from disk, so they work on any checkout (CRLF or LF) and any OS.
 */

/** Repository root: this file lives at packages/core/src/__tests__/architecture. */
export const REPO_ROOT = resolve(__dirname, "../../../../..");

export const CORE_SRC = join(REPO_ROOT, "packages", "core", "src");

/** Read a file with line endings normalised to LF. */
export function readNormalised(file: string): string {
  return readFileSync(file, "utf-8").replace(/\r\n?/g, "\n");
}

/** Repo-relative path using forward slashes, for stable allowlist keys. */
export function repoRel(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join("/");
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);
const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Recursively list code files under `dir` (sorted, absolute paths). */
export function listCodeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (CODE_FILE.test(name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Remove `//` and block comments from source while keeping string, template
 * and character content intact. Newlines inside comments are preserved so
 * line numbers stay accurate. Regex literals are not special-cased; none of
 * the guarded sources need it.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === "\n" && quote !== "`") break; // unterminated: bail out
        out += src[i];
        i++;
      }
      if (i < n && src[i] === quote) {
        out += quote;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
