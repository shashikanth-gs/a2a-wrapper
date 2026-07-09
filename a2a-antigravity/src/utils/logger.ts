/**
 * Logger
 *
 * Thin wrapper around the shared core logger so this package keeps the same
 * import shape as the existing wrappers.
 */

export { Logger, LogLevel, createLogger } from "@a2a-wrapper/core";
import { createLogger } from "@a2a-wrapper/core";

export const logger = createLogger("a2a-antigravity");
