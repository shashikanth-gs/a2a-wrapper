import { describe, it, expect, afterEach } from "vitest";
import * as fc from "fast-check";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { loadConfigFile } from "../../config/loader.js";
import { resolveConfig } from "../../config/loader.js";
import type { BaseAgentConfig } from "../../config/types.js";

/**
 * Property-based tests for the configuration loader module.
 *
 * Validates Requirements 6.1 via Property 7 and Requirements 6.2 via Property 8.
 */

// Feature: shared-core-package, Property 7: Config file round trip
// Validates: Requirements 6.1
describe("Property 7: Config file round trip", () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const f of tempFiles) {
      try {
        unlinkSync(f);
      } catch {
        // ignore cleanup errors
      }
    }
    tempFiles.length = 0;
  });

  /**
   * Arbitrary for JSON-serializable objects (no undefined, no functions).
   * Generates nested structures with strings, numbers, booleans, null, and arrays.
   */
  const arbJsonLeaf = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
  );

  const arbJsonObject: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]*$/).filter((s) => s.length > 0 && s.length <= 10),
    fc.oneof(
      arbJsonLeaf,
      fc.array(arbJsonLeaf, { minLength: 0, maxLength: 4 }),
      fc.dictionary(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]*$/).filter((s) => s.length > 0 && s.length <= 10),
        arbJsonLeaf,
        { minKeys: 0, maxKeys: 4 },
      ),
    ),
    { minKeys: 1, maxKeys: 6 },
  );

  it("write JSON to temp file, loadConfigFile returns deeply equal object", () => {
    fc.assert(
      fc.property(arbJsonObject, (obj) => {
        const tmpFile = path.join(os.tmpdir(), `core-test-p7-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        tempFiles.push(tmpFile);

        writeFileSync(tmpFile, JSON.stringify(obj), "utf-8");

        const loaded = loadConfigFile<Record<string, unknown>>(tmpFile);
        expect(loaded).toEqual(obj);
      }),
      { numRuns: 100 },
    );
  });
});


// Feature: shared-core-package, Property 8: Config merge precedence
// Validates: Requirements 6.2
describe("Property 8: Config merge precedence", () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const f of tempFiles) {
      try {
        unlinkSync(f);
      } catch {
        // ignore cleanup errors
      }
    }
    tempFiles.length = 0;
  });

  /**
   * Create a minimal BaseAgentConfig-compatible defaults object with a given port.
   */
  const makeDefaults = (port: number) => ({
    agentCard: { name: "test", description: "test" },
    server: { port, hostname: "0.0.0.0", advertiseHost: "localhost", advertiseProtocol: "http" as const },
    backend: {},
    session: { titlePrefix: "test", reuseByContext: true, ttl: 3600000, cleanupInterval: 300000 },
    features: { streamArtifactChunks: false },
    timeouts: { prompt: 600000 },
    logging: { level: "info" },
    mcp: {},
  });

  it("CLI > env > file > defaults for any overlapping key (server.port)", () => {
    fc.assert(
      fc.property(
        // Generate 4 distinct port numbers for each layer
        fc.integer({ min: 1024, max: 9999 }),
        fc.integer({ min: 10000, max: 19999 }),
        fc.integer({ min: 20000, max: 29999 }),
        fc.integer({ min: 30000, max: 39999 }),
        (defaultPort, filePort, envPort, cliPort) => {
          const defaults = makeDefaults(defaultPort) as Required<BaseAgentConfig>;

          // Write file layer to a temp file
          const fileConfig = { server: { port: filePort } };
          const tmpFile = path.join(os.tmpdir(), `core-test-p8-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
          tempFiles.push(tmpFile);
          writeFileSync(tmpFile, JSON.stringify(fileConfig), "utf-8");

          const envOverrides = { server: { port: envPort } } as Partial<BaseAgentConfig>;
          const cliOverrides = { server: { port: cliPort } } as Partial<BaseAgentConfig>;

          // CLI wins over all
          const resultAll = resolveConfig(defaults, tmpFile, envOverrides, cliOverrides);
          expect(resultAll.server.port).toBe(cliPort);

          // Without CLI, env wins
          const resultNoCliOverrides = resolveConfig(defaults, tmpFile, envOverrides, undefined);
          expect(resultNoCliOverrides.server.port).toBe(envPort);

          // Without CLI and env, file wins
          const resultFileOnly = resolveConfig(defaults, tmpFile, undefined, undefined);
          expect(resultFileOnly.server.port).toBe(filePort);

          // Without CLI, env, and file, defaults win
          const resultDefaultsOnly = resolveConfig(defaults, undefined, undefined, undefined);
          expect(resultDefaultsOnly.server.port).toBe(defaultPort);
        },
      ),
      { numRuns: 100 },
    );
  });
});
