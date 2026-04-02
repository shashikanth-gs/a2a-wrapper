/**
 * Copilot Module — Public API barrel
 *
 * Re-exports core Copilot integration classes and event-publisher helpers
 * for programmatic use without importing subdirectory modules directly.
 */

export { CopilotExecutor } from "./executor.js";
export { SessionManager } from "./session-manager.js";
export {
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
} from "./event-publisher.js";
