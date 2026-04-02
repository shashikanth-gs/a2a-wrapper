/**
 * @module utils/logger
 *
 * Structured, leveled logging with child-logger support and configurable root names.
 *
 * This module provides the logging infrastructure for all A2A wrapper projects.
 * Each wrapper creates its own root logger via {@link createLogger}, avoiding
 * hardcoded singletons and enabling independent log hierarchies per project.
 *
 * Output format: `[ISO_timestamp] [LEVEL] [name] message {data}`
 *
 * - ERROR messages route to `console.error`
 * - WARN messages route to `console.warn`
 * - DEBUG and INFO messages route to `console.log`
 *
 * @example
 * ```ts
 * import { createLogger, LogLevel } from '@a2a-wrapper/core';
 *
 * const logger = createLogger('a2a-copilot');
 * logger.setLevel(LogLevel.DEBUG);
 *
 * const child = logger.child('session');
 * child.info('session started', { contextId: 'abc-123' });
 * // => [2024-01-15T10:30:00.000Z] [INFO] [a2a-copilot:session] session started {"contextId":"abc-123"}
 * ```
 */

/**
 * Numeric log levels controlling message suppression.
 *
 * Messages are emitted only when their level is greater than or equal to the
 * logger's configured minimum level. Lower numeric values represent more
 * verbose output.
 */
export enum LogLevel {
  /** Verbose diagnostic output, typically disabled in production. */
  DEBUG = 0,
  /** General operational messages indicating normal behavior. */
  INFO = 1,
  /** Potentially harmful situations that deserve attention. */
  WARN = 2,
  /** Failures requiring immediate investigation. */
  ERROR = 3,
}

/**
 * Human-readable label for each {@link LogLevel}, used in formatted output.
 *
 * @internal
 */
const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
};

/**
 * Structured logger with hierarchical naming and runtime level control.
 *
 * Each Logger instance has a `name` (used as a prefix in output) and a minimum
 * {@link LogLevel}. Child loggers inherit the parent's level at creation time
 * and format their name as `{parent}:{child}`.
 *
 * @example
 * ```ts
 * const root = new Logger('myApp', LogLevel.DEBUG);
 * const child = root.child('http');
 * child.info('request received', { method: 'GET', path: '/' });
 * ```
 */
export class Logger {
  /**
   * Dot-colon-separated name identifying this logger in output.
   *
   * @readonly
   */
  private readonly name: string;

  /**
   * Current minimum log level. Messages below this level are suppressed.
   */
  private level: LogLevel;

  /**
   * Creates a new Logger instance.
   *
   * @param name  - Identifier included in every log line (e.g. `"a2a-copilot"` or `"a2a-copilot:session"`).
   * @param level - Minimum log level; defaults to {@link LogLevel.INFO}.
   */
  constructor(name: string, level: LogLevel = LogLevel.INFO) {
    this.name = name;
    this.level = level;
  }

  /**
   * Changes the minimum log level at runtime.
   *
   * All subsequent calls to {@link debug}, {@link info}, {@link warn}, and
   * {@link error} will be filtered against the new level.
   *
   * @param level - The new minimum {@link LogLevel}.
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Parses a string into a {@link LogLevel}.
   *
   * Matching is case-insensitive. The string `"warning"` is accepted as an
   * alias for {@link LogLevel.WARN}. Unrecognized strings default to
   * {@link LogLevel.INFO}.
   *
   * @param str - The string to parse (e.g. `"debug"`, `"WARN"`, `"error"`).
   * @returns The corresponding {@link LogLevel} value.
   */
  static parseLevel(str: string): LogLevel {
    switch (str.toLowerCase()) {
      case "debug":
        return LogLevel.DEBUG;
      case "warn":
      case "warning":
        return LogLevel.WARN;
      case "error":
        return LogLevel.ERROR;
      default:
        return LogLevel.INFO;
    }
  }

  /**
   * Creates a child logger that inherits this logger's current level.
   *
   * The child's name is formatted as `{parentName}:{childName}`, producing
   * a colon-separated hierarchy visible in log output.
   *
   * @param childName - Short identifier appended to the parent name.
   * @returns A new {@link Logger} instance with the composite name.
   *
   * @example
   * ```ts
   * const root = createLogger('app');
   * const child = root.child('db');
   * const grandchild = child.child('query');
   * // grandchild.name === 'app:db:query'
   * ```
   */
  child(childName: string): Logger {
    return new Logger(`${this.name}:${childName}`, this.level);
  }

  /**
   * Logs a message at {@link LogLevel.DEBUG}.
   *
   * @param msg  - Human-readable log message.
   * @param data - Optional structured data appended as JSON.
   */
  debug(msg: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.DEBUG, msg, data);
  }

  /**
   * Logs a message at {@link LogLevel.INFO}.
   *
   * @param msg  - Human-readable log message.
   * @param data - Optional structured data appended as JSON.
   */
  info(msg: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.INFO, msg, data);
  }

  /**
   * Logs a message at {@link LogLevel.WARN}.
   *
   * @param msg  - Human-readable log message.
   * @param data - Optional structured data appended as JSON.
   */
  warn(msg: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.WARN, msg, data);
  }

  /**
   * Logs a message at {@link LogLevel.ERROR}.
   *
   * @param msg  - Human-readable log message.
   * @param data - Optional structured data appended as JSON.
   */
  error(msg: string, data?: Record<string, unknown>): void {
    this.write(LogLevel.ERROR, msg, data);
  }

  /**
   * Internal method that formats and emits a log line if the message level
   * meets or exceeds the configured minimum.
   *
   * Output format: `[ISO_timestamp] [LEVEL] [name] message {data}`
   *
   * Routing:
   * - {@link LogLevel.ERROR} → `console.error`
   * - {@link LogLevel.WARN} → `console.warn`
   * - All others → `console.log`
   *
   * @param level - The severity level of this message.
   * @param msg   - Human-readable log message.
   * @param data  - Optional structured data serialized as JSON.
   *
   * @internal
   */
  private write(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    if (level < this.level) return;

    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${LEVEL_NAMES[level]}] [${this.name}]`;
    const line = data
      ? `${prefix} ${msg} ${JSON.stringify(data)}`
      : `${prefix} ${msg}`;

    if (level === LogLevel.ERROR) {
      console.error(line);
    } else if (level === LogLevel.WARN) {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

/**
 * Creates a new root {@link Logger} instance with the given name.
 *
 * This is the recommended entry point for obtaining a logger. Each wrapper
 * project should call this once with its own root name, then use
 * {@link Logger.child} to create scoped loggers for subsystems.
 *
 * Unlike a singleton, this factory allows multiple independent logger
 * hierarchies to coexist — one per wrapper project or test suite.
 *
 * @param rootName - The root identifier for the logger hierarchy
 *                   (e.g. `"a2a-copilot"`, `"a2a-opencode"`).
 * @returns A new {@link Logger} instance with the default level {@link LogLevel.INFO}.
 *
 * @example
 * ```ts
 * import { createLogger } from '@a2a-wrapper/core';
 *
 * const logger = createLogger('a2a-copilot');
 * const sessionLog = logger.child('session');
 * sessionLog.info('ready');
 * ```
 */
export function createLogger(rootName: string): Logger {
  return new Logger(rootName);
}
