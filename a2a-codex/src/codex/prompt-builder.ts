/**
 * Prompt Builder
 *
 * Re-exports the shared `extractUserText` helper from `@a2a-wrapper/core`
 * (see `packages/core/src/events/part-utils.ts`) so this wrapper's
 * import paths stay stable. Inbound `Part` parsing is an A2A protocol
 * concern and lives in core, not here.
 */

export { extractUserText } from "@a2a-wrapper/core";
