import { describe, it, expect } from "vitest";
import { relative } from "node:path";
import { CORE_SRC, listCodeFiles, readNormalised, repoRel, stripComments } from "./source-scan.js";

/**
 * Architecture guard: core never branches on provider identity and has no
 * provider feature flags.
 *
 * See docs/design/core-owned-a2a-boundary.md, principle 4 ("No provider
 * conditionals in core") and section 3 ("Enforced by tests"). Core behaves by
 * what a provider implements, never by which provider it is. Provider-specific
 * behaviour lives in that provider's wrapper.
 *
 * How it works: comments are stripped from every core source file (tests
 * excluded), then every remaining occurrence of a provider name, in any
 * identifier or string literal, is counted. Core is expected to contain none.
 * The few existing occurrences are listed below with an exact per-file count
 * and a justification. An exact count means a new occurrence fails the test,
 * and so does a removed one (the entry is then stale and must be updated), so
 * the list can only shrink without a deliberate, reviewed edit.
 */

const PROVIDERS = ["copilot", "claude", "codex", "opencode", "antigravity"] as const;
const PROVIDER_RE = new RegExp(PROVIDERS.join("|"), "gi");

/** Feature-flag style identifiers (`supportsSteering`, `supportsAbort`, ...). */
const FEATURE_FLAG_RE = /\bsupports[A-Z]\w*/g;

interface AllowedOccurrences {
  /** Exact number of provider-name occurrences in the file's code (comments excluded). */
  count: number;
  why: string;
}

/**
 * Legitimate provider-name occurrences in core code, keyed by path relative to
 * packages/core/src. None of them is a condition on provider identity: they
 * are data (config shape, filesystem conventions) that a wrapper selects or
 * passes in. Do not add entries to make a new provider conditional pass.
 */
const ALLOWED_PROVIDER_NAMES: Readonly<Record<string, AllowedOccurrences>> = {
  "index.ts": {
    count: 15,
    why:
      "Public barrel re-exporting the telemetry backend config types and passthrough helpers " +
      "listed under telemetry/. Names only, no logic.",
  },
  "telemetry/index.ts": {
    count: 15,
    why:
      "Telemetry barrel re-exporting the backend config types and passthrough helpers " +
      "defined in telemetry/types.ts and telemetry/backend-passthrough.ts. Names only, no logic.",
  },
  "memory/paths.ts": {
    count: 9,
    why:
      "WELL_KNOWN_PATHS is a data table of on-disk instruction/skill locations. Nothing in core " +
      "looks entries up by provider identity; wrappers import the row they need.",
  },
  "telemetry/backend-passthrough.ts": {
    count: 12,
    why:
      "Pure config-to-options mappers reading the optional `otel.backend.<name>` config blocks " +
      "that a wrapper calls for itself. Core runs none of them conditionally on a provider.",
  },
  "telemetry/types.ts": {
    count: 31,
    why:
      "Type definitions for the optional `otel.backend.<name>` config blocks (config shape, " +
      "not a branch).",
  },
};

/** Feature-flag-looking identifiers that are not provider flags. */
const ALLOWED_FLAG_IDENTIFIERS: Readonly<Record<string, string>> = {
  supportsAuthenticatedExtendedCard:
    "Field name from the A2A agent card spec (not a provider capability flag).",
};

const coreFiles = listCodeFiles(CORE_SRC)
  .filter((f) => !/(^|[\\/])__tests__[\\/]/.test(relative(CORE_SRC, f)))
  .filter((f) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f));

function coreRel(file: string): string {
  return relative(CORE_SRC, file).split("\\").join("/");
}

function findAll(code: string, re: RegExp): string[] {
  return code.match(re) ?? [];
}

describe("architecture: core has no provider conditionals", () => {
  it("scans core source files", () => {
    expect(coreFiles.length).toBeGreaterThan(20);
    expect(coreFiles.every((f) => !repoRel(f).includes("__tests__"))).toBe(true);
  });

  const counts = new Map<string, number>();
  const flagHits: Array<{ file: string; ident: string }> = [];
  for (const file of coreFiles) {
    const code = stripComments(readNormalised(file));
    const n = findAll(code, PROVIDER_RE).length;
    if (n > 0) counts.set(coreRel(file), n);
    for (const ident of findAll(code, FEATURE_FLAG_RE)) {
      flagHits.push({ file: coreRel(file), ident });
    }
  }

  it("does not name a provider in code outside the justified allowlist", () => {
    const unexpected = [...counts.entries()]
      .filter(([f, n]) => !(f in ALLOWED_PROVIDER_NAMES) || n > ALLOWED_PROVIDER_NAMES[f].count)
      .map(([f, n]) => `${f}: ${n} occurrence(s), allowed ${ALLOWED_PROVIDER_NAMES[f]?.count ?? 0}`);
    expect(
      unexpected,
      "Core must not name or branch on a provider (copilot, claude, codex, opencode, antigravity). " +
        "Move the behaviour into the provider wrapper, or pass it in as data.",
    ).toEqual([]);
  });

  it("every allowlist entry is exact (stale or shrunken entries must be updated)", () => {
    const stale = Object.entries(ALLOWED_PROVIDER_NAMES)
      .filter(([f, a]) => (counts.get(f) ?? 0) !== a.count)
      .map(([f, a]) => `${f}: allowlist says ${a.count}, found ${counts.get(f) ?? 0}`);
    expect(stale, "Update ALLOWED_PROVIDER_NAMES so it matches core exactly (it may only shrink).").toEqual([]);
  });

  it("every allowlist entry carries a justification", () => {
    for (const [file, a] of Object.entries(ALLOWED_PROVIDER_NAMES)) {
      expect(a.why.length, file).toBeGreaterThan(20);
    }
  });

  it("defines no provider feature flags (supportsXxx) beyond the A2A spec field", () => {
    const unexpected = flagHits.filter((h) => !(h.ident in ALLOWED_FLAG_IDENTIFIERS));
    expect(
      unexpected.map((h) => `${h.file}: ${h.ident}`),
      "Core behaves by what a provider implements, not by capability flags (principle 4).",
    ).toEqual([]);
  });

  it("every allowed flag identifier is still present", () => {
    const seen = new Set(flagHits.map((h) => h.ident));
    const stale = Object.keys(ALLOWED_FLAG_IDENTIFIERS).filter((i) => !seen.has(i));
    expect(stale).toEqual([]);
  });

  it("matcher ignores comments but catches names in conditions and switches", () => {
    const strip = (s: string): string[] => findAll(stripComments(s), PROVIDER_RE);
    expect(strip(`// copilot\n/* Claude */ const a = 1;`)).toEqual([]);
    expect(strip(`if (name === "copilot") {}`)).toEqual(["copilot"]);
    expect(strip(`switch (b) { case 'Codex': break; }`)).toEqual(["Codex"]);
    expect(strip(`if (isOpenCode) {}`)).toEqual(["OpenCode"]);
    expect(findAll(`if (x.supportsSteering) {}`, FEATURE_FLAG_RE)).toEqual(["supportsSteering"]);
  });
});
