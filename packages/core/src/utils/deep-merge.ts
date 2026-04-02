/**
 * Deep Merge and Environment Token Substitution Utilities
 *
 * This module provides two core utility functions used throughout the
 * configuration loading pipeline:
 *
 * 1. `deepMerge` — Recursively merges a source object into a target object,
 *    producing a new object without mutating either input. Used by the config
 *    loader to layer defaults ← file ← env ← CLI overrides.
 *
 * 2. `substituteEnvTokens` — Replaces `$VAR_NAME` tokens in string arrays
 *    with matching environment variable values. Used to resolve environment
 *    references in MCP server arguments and other configuration arrays.
 *
 * Both functions are pure (no side effects beyond reading `process.env`) and
 * return new data structures rather than mutating inputs.
 *
 * @module utils/deep-merge
 */

/**
 * Recursively merge `source` into `target`, producing a new object.
 *
 * This function implements a deterministic, recursive merge strategy designed
 * for layered configuration loading. The merge follows these rules:
 *
 * **Merge Rules:**
 * - **Arrays are replaced** — If the source value for a key is an array, it
 *   completely replaces the target's array (no concatenation).
 * - **Neither input is mutated** — A new object is always returned. Both
 *   `target` and `source` remain unchanged after the call.
 * - **`undefined` values in source are skipped** — If a source key has the
 *   value `undefined`, the corresponding target value is preserved.
 * - **`null` values in source replace the target value** — An explicit `null`
 *   in the source overwrites whatever the target had for that key.
 * - **Nested objects are recursively merged** — When both the target and
 *   source values for a key are plain objects (non-null, non-array), the
 *   merge recurses into them.
 *
 * @typeParam T - The shape of the target object. The return type preserves
 *   this shape so that downstream consumers retain full type information.
 *
 * @param target - The base object providing default values. Not mutated.
 * @param source - The override object whose defined, non-undefined values
 *   take precedence over `target`. Not mutated.
 * @returns A new object containing the merged result of `target` and `source`.
 *
 * @example
 * ```typescript
 * const base = { server: { port: 3000, host: "localhost" }, tags: ["a"] };
 * const overrides = { server: { port: 8080 }, tags: ["b", "c"] };
 * const result = deepMerge(base, overrides);
 * // result = { server: { port: 8080, host: "localhost" }, tags: ["b", "c"] }
 * // base and overrides are unchanged
 * ```
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = (source as Record<string, unknown>)[key];

    // Skip undefined values — preserve the target's value
    if (srcVal === undefined) continue;

    const tgtVal = (result as Record<string, unknown>)[key];

    // Recursively merge when both sides are plain objects (non-null, non-array)
    if (
      tgtVal !== null &&
      srcVal !== null &&
      typeof tgtVal === "object" &&
      typeof srcVal === "object" &&
      !Array.isArray(tgtVal) &&
      !Array.isArray(srcVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      // Arrays, primitives, and null — direct replacement
      (result as Record<string, unknown>)[key] = srcVal;
    }
  }

  return result;
}

/**
 * Replace `$VAR_NAME` tokens in a string array with matching environment
 * variable values from `process.env`.
 *
 * Each string in the input array is scanned for tokens matching the pattern
 * `$WORD_CHARS` (i.e. `$` followed by one or more `[A-Za-z0-9_]` characters).
 * When a matching environment variable exists, the token is replaced with its
 * value. Unmatched tokens (no corresponding env var) are left unchanged.
 *
 * The function returns a **new array** — the input array is not mutated.
 *
 * @param args - Array of strings potentially containing `$VAR_NAME` tokens.
 *   Each element is independently processed for token substitution.
 * @returns A new array with environment variable tokens substituted where
 *   matching values exist. Unmatched tokens remain as-is.
 *
 * @example
 * ```typescript
 * // Given: process.env.HOME = "/home/user"
 * // Given: process.env.WORKSPACE_DIR is not set
 *
 * substituteEnvTokens(["--dir", "$HOME/projects", "$WORKSPACE_DIR"])
 * // Returns: ["--dir", "/home/user/projects", "$WORKSPACE_DIR"]
 * ```
 */
export function substituteEnvTokens(args: string[]): string[] {
  return args.map((arg) =>
    arg.replace(/\$(\w+)/g, (_match, name: string) => process.env[name] ?? _match),
  );
}
