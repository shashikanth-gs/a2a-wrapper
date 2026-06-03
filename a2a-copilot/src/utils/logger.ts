/**
 * Structured Logger
 *
 * Leveled, structured logging with child logger support.
 * Output: [ISO timestamp] [LEVEL] [name] message { data }
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
};

export class Logger {
  private readonly name: string;
  /**
   * Mutable level holder shared between a logger and all of its descendants.
   * Because children share the parent's holder, calling `setLevel()` on the
   * root logger (e.g. after config resolution in cli.ts) propagates to every
   * child logger — even ones created at module-import time before the level
   * was configured.
   */
  private readonly levelRef: { value: LogLevel };

  constructor(name: string, level: LogLevel | { value: LogLevel } = LogLevel.INFO) {
    this.name = name;
    // Accept either a concrete level (root logger) or a shared holder (child).
    this.levelRef = typeof level === "object" ? level : { value: level };
  }

  setLevel(level: LogLevel): void {
    this.levelRef.value = level;
  }

  get level(): LogLevel {
    return this.levelRef.value;
  }

  static parseLevel(str: string): LogLevel {
    switch (str.toLowerCase()) {
      case "debug": return LogLevel.DEBUG;
      case "warn":
      case "warning": return LogLevel.WARN;
      case "error": return LogLevel.ERROR;
      default: return LogLevel.INFO;
    }
  }

  child(childName: string): Logger {
    // Share the same level holder so root setLevel() reaches this child.
    return new Logger(`${this.name}:${childName}`, this.levelRef);
  }

  debug(msg: string, data?: Record<string, unknown>): void { this.write(LogLevel.DEBUG, msg, data); }
  info(msg: string, data?: Record<string, unknown>): void  { this.write(LogLevel.INFO, msg, data); }
  warn(msg: string, data?: Record<string, unknown>): void  { this.write(LogLevel.WARN, msg, data); }
  error(msg: string, data?: Record<string, unknown>): void { this.write(LogLevel.ERROR, msg, data); }

  private write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (level < this.levelRef.value) return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${LEVEL_NAMES[level]}] [${this.name}]`;
    const line = data ? `${prefix} ${msg} ${JSON.stringify(data)}` : `${prefix} ${msg}`;

    if (level === LogLevel.ERROR) console.error(line);
    else if (level === LogLevel.WARN) console.warn(line);
    else console.log(line);
  }
}

/** Root logger singleton. */
export const logger = new Logger("a2a-copilot");
