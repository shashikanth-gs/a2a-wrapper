import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { Logger, LogLevel, createLogger } from "../../utils/logger.js";

/**
 * Property-based tests for the Logger module.
 *
 * Validates Requirements 2.3, 2.4, 2.5, 2.6, 2.7 via Properties 1, 2, 3.
 */

/** Arbitrary for non-empty alphanumeric strings (valid logger names). */
const arbName = fc.stringMatching(/^[a-zA-Z0-9]+$/).filter((s) => s.length > 0);

/** All LogLevel values in ascending order. */
const ALL_LEVELS = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR] as const;

/** Arbitrary for a LogLevel value. */
const arbLogLevel = fc.constantFrom(...ALL_LEVELS);

describe("Logger property tests", () => {
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Feature: shared-core-package, Property 1: Logger naming chain
  // Validates: Requirements 2.3, 2.6
  describe("Property 1: Logger naming chain", () => {
    it("createLogger(root).child(c1).child(c2) produces name root:c1:c2", () => {
      fc.assert(
        fc.property(
          arbName,
          fc.array(arbName, { minLength: 0, maxLength: 5 }),
          (root, childNames) => {
            let logger = createLogger(root);
            logger.setLevel(LogLevel.DEBUG);
            for (const c of childNames) {
              logger = logger.child(c);
            }

            // Emit a message and capture the output
            logger.debug("probe");

            const expectedName = [root, ...childNames].join(":");
            const lastCall = consoleSpy.log.mock.calls[
              consoleSpy.log.mock.calls.length - 1
            ] as string[];
            const output = lastCall[0];

            // Verify the [name] portion of the output
            expect(output).toContain(`[${expectedName}]`);

            // Clean up spy calls for next iteration
            consoleSpy.log.mockClear();
            consoleSpy.warn.mockClear();
            consoleSpy.error.mockClear();
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: shared-core-package, Property 2: Logger level suppression
  // Validates: Requirements 2.4, 2.7
  describe("Property 2: Logger level suppression", () => {
    it("after setLevel(L), only levels >= L produce output", () => {
      fc.assert(
        fc.property(
          arbName,
          arbLogLevel,
          arbLogLevel,
          (name, configuredLevel, emitLevel) => {
            const logger = createLogger(name);
            logger.setLevel(configuredLevel);

            // Clear any prior calls
            consoleSpy.log.mockClear();
            consoleSpy.warn.mockClear();
            consoleSpy.error.mockClear();

            // Call the log method corresponding to emitLevel
            const methods: Record<LogLevel, (msg: string, data?: Record<string, unknown>) => void> = {
              [LogLevel.DEBUG]: (m, d) => logger.debug(m, d),
              [LogLevel.INFO]: (m, d) => logger.info(m, d),
              [LogLevel.WARN]: (m, d) => logger.warn(m, d),
              [LogLevel.ERROR]: (m, d) => logger.error(m, d),
            };

            methods[emitLevel]("test-message");

            const totalCalls =
              consoleSpy.log.mock.calls.length +
              consoleSpy.warn.mock.calls.length +
              consoleSpy.error.mock.calls.length;

            if (emitLevel >= configuredLevel) {
              // Should have produced output
              expect(totalCalls).toBe(1);
            } else {
              // Should have been suppressed
              expect(totalCalls).toBe(0);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: shared-core-package, Property 3: Logger output format
  // Validates: Requirements 2.5
  describe("Property 3: Logger output format", () => {
    /** Arbitrary for a non-empty message string (no newlines to keep output on one line). */
    const arbMessage = fc.stringMatching(/^[a-zA-Z0-9 _-]+$/).filter((s) => s.length > 0);

    /** Arbitrary for an optional Record<string, unknown> data object. */
    const arbData = fc.option(
      fc.dictionary(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]*$/).filter((s) => s.length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        { minKeys: 1, maxKeys: 3 },
      ),
      { nil: undefined },
    );

    /** ISO 8601 timestamp pattern. */
    const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    it("output matches [ISO] [LEVEL] [name] msg {data} and routes to correct console method", () => {
      fc.assert(
        fc.property(
          arbName,
          arbLogLevel,
          arbMessage,
          arbData,
          (name, level, msg, data) => {
            const logger = createLogger(name);
            logger.setLevel(LogLevel.DEBUG); // Ensure all levels emit

            // Clear spies
            consoleSpy.log.mockClear();
            consoleSpy.warn.mockClear();
            consoleSpy.error.mockClear();

            // Emit at the given level
            const methods: Record<LogLevel, (m: string, d?: Record<string, unknown>) => void> = {
              [LogLevel.DEBUG]: (m, d) => logger.debug(m, d),
              [LogLevel.INFO]: (m, d) => logger.info(m, d),
              [LogLevel.WARN]: (m, d) => logger.warn(m, d),
              [LogLevel.ERROR]: (m, d) => logger.error(m, d),
            };

            methods[level](msg, data);

            // Determine which spy should have been called
            const LEVEL_NAMES: Record<LogLevel, string> = {
              [LogLevel.DEBUG]: "DEBUG",
              [LogLevel.INFO]: "INFO",
              [LogLevel.WARN]: "WARN",
              [LogLevel.ERROR]: "ERROR",
            };

            let targetSpy: ReturnType<typeof vi.spyOn>;
            if (level === LogLevel.ERROR) {
              targetSpy = consoleSpy.error;
            } else if (level === LogLevel.WARN) {
              targetSpy = consoleSpy.warn;
            } else {
              targetSpy = consoleSpy.log;
            }

            // Verify routing: only the correct spy was called
            expect(targetSpy).toHaveBeenCalledTimes(1);

            // Verify the other spies were NOT called
            const otherSpies = [consoleSpy.log, consoleSpy.warn, consoleSpy.error].filter(
              (s) => s !== targetSpy,
            );
            for (const spy of otherSpies) {
              expect(spy).not.toHaveBeenCalled();
            }

            // Verify output format
            const output = (targetSpy.mock.calls[0] as string[])[0];

            // Pattern: [ISO] [LEVEL] [name] msg {data?}
            const levelName = LEVEL_NAMES[level];

            // Extract the ISO timestamp from the output
            const tsMatch = output.match(/^\[([^\]]+)\]/);
            expect(tsMatch).not.toBeNull();
            expect(tsMatch![1]).toMatch(ISO_PATTERN);

            // Verify level tag
            expect(output).toContain(`[${levelName}]`);

            // Verify name tag
            expect(output).toContain(`[${name}]`);

            // Verify message is present
            expect(output).toContain(msg);

            // Verify data serialization
            if (data !== undefined) {
              expect(output).toContain(JSON.stringify(data));
            } else {
              // When no data, output should NOT have trailing JSON
              // The output should end with the message (no extra braces)
              const afterName = output.split(`[${name}] `)[1];
              expect(afterName).toBe(msg);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
