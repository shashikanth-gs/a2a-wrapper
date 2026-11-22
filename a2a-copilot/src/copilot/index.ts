/**
 * Copilot Module — Public API barrel
 *
 * Re-exports the Copilot provider and event-publisher helpers for programmatic
 * use without importing subdirectory modules directly.
 */

export { CopilotProvider, SESSION_FORMAT, isSessionNotFound } from "./provider.js";
export type { CopilotProviderOptions } from "./provider.js";
export { CopilotTurn } from "./turn.js";
export type { CopilotClientLike, CopilotSession } from "./types.js";
export {
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
} from "@a2a-wrapper/core";
