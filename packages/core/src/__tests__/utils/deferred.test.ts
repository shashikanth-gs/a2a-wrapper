import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { createDeferred } from "../../utils/deferred.js";

/**
 * Property-based tests for the Deferred module.
 *
 * Validates Requirements 3.1 via Property 4.
 */

// Feature: shared-core-package, Property 4: Deferred resolve round trip
describe("Property 4: Deferred resolve round trip", () => {
  /** Arbitrary for diverse values: strings, numbers, booleans, and plain objects. */
  const arbValue = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true }),
    fc.boolean(),
    fc.dictionary(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]*$/).filter((s) => s.length > 0),
      fc.oneof(fc.string(), fc.integer(), fc.boolean()),
      { minKeys: 0, maxKeys: 4 },
    ),
  );

  // Validates: Requirements 3.1
  it("resolve(value) then await promise yields the same value", async () => {
    await fc.assert(
      fc.asyncProperty(arbValue, async (value) => {
        const deferred = createDeferred<unknown>();
        deferred.resolve(value);
        const result = await deferred.promise;
        expect(result).toEqual(value);
      }),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 3.1
  it("reject(reason) then catch yields the same reason", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (reason) => {
        const deferred = createDeferred<unknown>();
        deferred.reject(reason);
        try {
          await deferred.promise;
          // Should not reach here
          expect.fail("Promise should have been rejected");
        } catch (caught) {
          expect(caught).toEqual(reason);
        }
      }),
      { numRuns: 100 },
    );
  });
});
