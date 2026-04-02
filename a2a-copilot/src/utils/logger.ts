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
  private level: LogLevel;

  constructor(name: string, level: LogLevel = LogLevel.INFO) {
    this.name = name;
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
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
    return new Logger(`${this.name}:${childName}`, this.level);
  }

  debug(msg: string, data?: Record<string, unknown>): void { this.write(LogLevel.DEBUG, msg, data); }
  info(msg: string, data?: Record<string, unknown>): void  { this.write(LogLevel.INFO, msg, data); }
  warn(msg: string, data?: Record<string, unknown>): void  { this.write(LogLevel.WARN, msg, data); }
  error(msg: string, data?: Record<string, unknown>): void { this.write(LogLevel.ERROR, msg, data); }

  private write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (level < this.level) return;
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
