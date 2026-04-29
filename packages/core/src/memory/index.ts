/**
 * Memory Persistence Module
 *
 * Barrel exports for the memory persistence feature. Provides types,
 * parser utilities, path resolution, and the materializer entry point.
 *
 * @module memory
 */

export type {
  MemoryConfig,
  SkillManifest,
  ParsedSkill,
  BackendPaths,
  MaterializeOptions,
} from "./types.js";

export { materializeMemory } from "./materializer.js";
export { parseSkillManifest, formatSkillManifest, validateSkillManifest } from "./parser.js";
export { WELL_KNOWN_PATHS, resolveMemoryPath } from "./paths.js";
