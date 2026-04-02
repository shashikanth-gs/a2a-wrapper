import { describe, it, expect, afterEach } from "vitest";
import * as fc from "fast-check";
import { deepMerge, substituteEnvTokens } from "../../utils/deep-merge.js";

/**
 * Property-based tests for the deepMerge and substituteEnvTokens modules.
 *
 * Validates Requirements 4.1, 4.2, 4.3, 4.4, 4.5 via Properties 5, 6
 * and Requirement 6.4 via Property 9.
 */

/**
 * Arbitrary for nested plain objects (2-3 levels deep) with diverse leaf values.
 * Leaves can be strings, numbers, booleans, null, undefined, or arrays.
 */
const arbLeaf = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean()), { minLength: 0, maxLength: 4 }),
);

/** Arbitrary for a valid object key. */
const arbKey = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]*$/).filter((s) => s.length > 0 && s.length <= 10);

/** Arbitrary for a flat record with leaf values. */
const arbFlatRecord = fc.dictionary(arbKey, arbLeaf, { minKeys: 0, maxKeys: 5 });

/** Arbitrary for a nested object (2-3 levels deep). */
const arbNestedObject: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  arbKey,
  fc.oneof(
    arbLeaf,
    // Level 2: nested object
    fc.dictionary(
      arbKey,
      fc.oneof(
        arbLeaf,
        // Level 3: one more nesting level
        arbFlatRecord,
      ),
      { minKeys: 0, maxKeys: 4 },
    ),
  ),
  { minKeys: 1, maxKeys: 5 },
);

/**
 * Deep clone that preserves the original shape including undefined keys.
 * Used to snapshot inputs before calling deepMerge so we can verify immutability.
 */
function snapshotClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(snapshotClone) as T;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    result[key] = snapshotClone((obj as Record<string, unknown>)[key]);
  }
  return result as T;
}

// Feature: shared-core-package, Property 5: deepMerge immutability invariant
// Validates: Requirements 4.3
describe("Property 5: deepMerge immutability invariant", () => {
  it("neither target nor source is mutated after deepMerge", () => {
    fc.assert(
      fc.property(arbNestedObject, arbNestedObject, (target, source) => {
        // Deep-clone both inputs before the call using structuredClone
        const targetSnapshot = snapshotClone(target);
        const sourceSnapshot = snapshotClone(source);

        // Perform the merge
        deepMerge(target, source);

        // Verify neither input was mutated
        expect(target).toEqual(targetSnapshot);
        expect(source).toEqual(sourceSnapshot);
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: shared-core-package, Property 6: deepMerge correctness
// Validates: Requirements 4.1, 4.2, 4.4, 4.5
describe("Property 6: deepMerge correctness", () => {
  it("source keys override target, arrays replaced, undefined skipped, null replaces, nested objects recursively merged", () => {
    fc.assert(
      fc.property(arbNestedObject, arbNestedObject, (target, source) => {
        const result = deepMerge(target, source);

        for (const key of Object.keys(source)) {
          const srcVal = source[key];
          const tgtVal = target[key];

          // Rule: undefined values in source are skipped — target value preserved
          if (srcVal === undefined) {
            if (key in target) {
              expect(result[key]).toEqual(tgtVal);
            }
            continue;
          }

          // Rule: null values in source replace the target value
          if (srcVal === null) {
            expect(result[key]).toBeNull();
            continue;
          }

          // Rule: arrays in source replace (not concatenate) target arrays
          if (Array.isArray(srcVal)) {
            expect(result[key]).toEqual(srcVal);
            // Verify it's not a concatenation of target + source
            if (Array.isArray(tgtVal) && tgtVal.length > 0 && srcVal.length > 0) {
              expect((result[key] as unknown[]).length).toBe(srcVal.length);
            }
            continue;
          }

          // Rule: nested objects are recursively merged
          if (
            typeof srcVal === "object" &&
            typeof tgtVal === "object" &&
            tgtVal !== null &&
            !Array.isArray(tgtVal)
          ) {
            const expectedNested = deepMerge(
              tgtVal as Record<string, unknown>,
              srcVal as Record<string, unknown>,
            );
            expect(result[key]).toEqual(expectedNested);
            continue;
          }

          // Rule: primitive source values override target
          expect(result[key]).toEqual(srcVal);
        }

        // All target keys not overridden by source should be preserved
        for (const key of Object.keys(target)) {
          if (!(key in source) || source[key] === undefined) {
            expect(result[key]).toEqual(target[key]);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: shared-core-package, Property 9: Environment token substitution
// Validates: Requirements 6.4
describe("Property 9: Environment token substitution", () => {
  /** Track env vars set during each test run for cleanup. */
  const envVarsToClean: string[] = [];

  afterEach(() => {
    for (const varName of envVarsToClean) {
      delete process.env[varName];
    }
    envVarsToClean.length = 0;
  });

  /** Arbitrary for a valid environment variable name (uppercase with underscores). */
  const arbEnvVarName = fc
    .stringMatching(/^[A-Z][A-Z0-9_]*$/)
    .filter((s) => s.length >= 2 && s.length <= 20);

  /** Arbitrary for an env var value (non-empty, no special chars that break regex). */
  const arbEnvVarValue = fc.stringMatching(/^[a-zA-Z0-9_/.-]+$/).filter((s) => s.length > 0);

  it("$VAR_NAME tokens replaced when env var exists, left unchanged otherwise", () => {
    fc.assert(
      fc.property(
        // Generate a set of env var bindings (some will be set, some won't)
        fc.array(fc.tuple(arbEnvVarName, arbEnvVarValue), { minLength: 1, maxLength: 5 }),
        // Generate token names — some matching set vars, some not
        fc.array(arbEnvVarName, { minLength: 1, maxLength: 5 }),
        (envBindings, tokenNames) => {
          // Set up env vars
          const envMap = new Map<string, string>();
          for (const [name, value] of envBindings) {
            process.env[name] = value;
            envMap.set(name, value);
            envVarsToClean.push(name);
          }

          // Build input args with $TOKEN patterns and plain strings
          const args = tokenNames.map((name) => "$" + name);
          // Also add a plain string that should pass through unchanged
          args.push("plain-string");

          const result = substituteEnvTokens(args);

          // Verify each token
          for (let i = 0; i < tokenNames.length; i++) {
            const tokenName = tokenNames[i];
            if (envMap.has(tokenName)) {
              // Token should be replaced with the env var value
              expect(result[i]).toBe(envMap.get(tokenName));
            } else {
              // Token should be left unchanged (kept as $VAR_NAME)
              expect(result[i]).toBe("$" + tokenName);
            }
          }

          // Plain string should pass through unchanged
          expect(result[result.length - 1]).toBe("plain-string");

          // Result should be a new array (not the same reference)
          expect(result).not.toBe(args);

          // Clean up for next iteration
          for (const varName of envVarsToClean) {
            delete process.env[varName];
          }
          envVarsToClean.length = 0;
        },
      ),
      { numRuns: 100 },
    );
  });
});
