import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { parseCommonArgs } from "../../cli/scaffold.js";

/**
 * Property-based tests for the CLI scaffold common flag parsing.
 *
 * Validates Requirement 11.3 via Property 19.
 */

// Feature: shared-core-package, Property 19:
// CLI common flag parsing — random valid flag combinations produce correct typed config overrides.
describe("parseCommonArgs — Property 19: CLI common flag parsing", () => {
  /**
   * Arbitrary for a random subset of common CLI flags.
   * Uses fc.record with requiredKeys=[] so every field is optional,
   * producing random combinations of flags on each iteration.
   */
  const arbFlagCombination = fc.record(
    {
      port: fc.integer({ min: 1, max: 65535 }).map(String),
      hostname: fc.stringMatching(/^[a-z][a-z0-9.-]{0,20}$/),
      "advertise-host": fc.stringMatching(/^[a-z][a-z0-9.-]{0,20}$/),
      "agent-name": fc.string({ minLength: 1, maxLength: 30 }),
      "agent-description": fc.string({ minLength: 1, maxLength: 100 }),
      "stream-artifacts": fc.constant(true as const),
      "no-stream-artifacts": fc.constant(true as const),
      "log-level": fc.constantFrom("debug", "info", "warn", "error"),
      "agent-json": fc.stringMatching(/^[a-z][a-z0-9/._-]{0,30}\.json$/),
    },
    { requiredKeys: [] },
  );

  it("random valid flag combinations produce correct typed config overrides", () => {
    fc.assert(
      fc.property(arbFlagCombination, (flags) => {
        const result = parseCommonArgs(flags);

        // --port → server.port as parsed integer
        if (flags.port !== undefined) {
          expect(result.overrides.server?.port).toBe(parseInt(flags.port, 10));
        }

        // --hostname → server.hostname
        if (flags.hostname !== undefined) {
          expect(result.overrides.server?.hostname).toBe(flags.hostname);
        }

        // --advertise-host → server.advertiseHost
        if (flags["advertise-host"] !== undefined) {
          expect(result.overrides.server?.advertiseHost).toBe(flags["advertise-host"]);
        }

        // --agent-name → agentCard.name
        if (flags["agent-name"] !== undefined) {
          expect(result.overrides.agentCard?.name).toBe(flags["agent-name"]);
        }

        // --agent-description → agentCard.description
        if (flags["agent-description"] !== undefined) {
          expect(result.overrides.agentCard?.description).toBe(flags["agent-description"]);
        }

        // --stream-artifacts → features.streamArtifactChunks === true
        // --no-stream-artifacts → features.streamArtifactChunks === false
        // When both are present, --no-stream-artifacts wins (it's processed second)
        if (flags["stream-artifacts"] === true && flags["no-stream-artifacts"] !== true) {
          expect(result.overrides.features?.streamArtifactChunks).toBe(true);
        }
        if (flags["no-stream-artifacts"] === true) {
          expect(result.overrides.features?.streamArtifactChunks).toBe(false);
        }

        // --log-level → logging.level
        if (flags["log-level"] !== undefined) {
          expect(result.overrides.logging?.level).toBe(flags["log-level"]);
        }

        // --agent-json → configPath
        if (flags["agent-json"] !== undefined) {
          expect(result.configPath).toBe(flags["agent-json"]);
        }

        // When no flags are provided, overrides should be empty-ish
        if (
          flags.port === undefined &&
          flags.hostname === undefined &&
          flags["advertise-host"] === undefined
        ) {
          expect(result.overrides.server).toBeUndefined();
        }

        if (
          flags["agent-name"] === undefined &&
          flags["agent-description"] === undefined
        ) {
          expect(result.overrides.agentCard).toBeUndefined();
        }

        if (
          flags["stream-artifacts"] === undefined &&
          flags["no-stream-artifacts"] === undefined
        ) {
          expect(result.overrides.features).toBeUndefined();
        }

        if (flags["log-level"] === undefined) {
          expect(result.overrides.logging).toBeUndefined();
        }

        if (flags["agent-json"] === undefined) {
          expect(result.configPath).toBeUndefined();
        }
      }),
      { numRuns: 100 },
    );
  });
});
