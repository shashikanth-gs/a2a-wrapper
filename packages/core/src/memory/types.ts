/**
 * Memory Persistence Type Definitions
 *
 * Core TypeScript interfaces for the memory persistence feature. These types
 * define the contract for declaring, parsing, and materializing agent memory
 * (instructions and skills) into backend-specific workspace paths at startup.
 *
 * The key design principle is **wrapper-owned path mapping**: the materializer
 * accepts a `BackendPaths` interface directly rather than a fixed enum. Each
 * wrapper defines its own `BackendPaths` constant, making the system extensible
 * without modifying core. TypeScript enforces the contract at compile time.
 *
 * @module memory/types
 */

// ─── Memory Config ──────────────────────────────────────────────────────────

/**
 * Optional memory configuration section in agent config.json.
 *
 * Declares instructions and skills to materialize into the agent's workspace
 * at startup. Both fields are optional — operators can declare instructions
 * only, skills only, or both.
 *
 * Paths are resolved relative to the directory containing config.json
 * (Config_Directory) unless they are absolute.
 *
 * @example
 * ```json
 * {
 *   "memory": {
 *     "instructions": "./memory/instructions.md",
 *     "skills": ["./memory/skills/code-review", "./memory/skills/testing"]
 *   }
 * }
 * ```
 */
export interface MemoryConfig {
  /**
   * Path to a markdown instructions file.
   * Resolved relative to Config_Directory when relative, used as-is when absolute.
   */
  instructions?: string;

  /**
   * Paths to skill directories, each containing a SKILL.md file.
   * Resolved relative to Config_Directory when relative, used as-is when absolute.
   */
  skills?: string[];
}

// ─── Skill Manifest ─────────────────────────────────────────────────────────

/**
 * Parsed SKILL.md YAML frontmatter metadata.
 *
 * Represents the structured metadata extracted from a SKILL.md file's
 * frontmatter section. The `name` and `description` fields are required;
 * all other fields are optional extensions.
 */
export interface SkillManifest {
  /**
   * Skill name in kebab-case format.
   * Used as the output directory name. Must be lowercase alphanumeric
   * characters and hyphens only, no leading/trailing hyphens, max 64 chars.
   */
  name: string;

  /** Human-readable description of the skill's capabilities. */
  description: string;

  /** Optional SPDX license identifier. */
  license?: string;

  /** Optional compatibility constraints (e.g. backend identifiers). */
  compatibility?: string[];

  /** Optional arbitrary metadata key-value pairs. */
  metadata?: Record<string, unknown>;

  /** Optional list of tools this skill is allowed to use. */
  allowedTools?: string[];
}

// ─── Parsed Skill ───────────────────────────────────────────────────────────

/**
 * Result of parsing a SKILL.md file.
 *
 * Contains the validated manifest (or null if frontmatter is missing/invalid),
 * the markdown body content, and the raw frontmatter object for round-trip
 * fidelity.
 */
export interface ParsedSkill {
  /** Parsed and typed YAML frontmatter, or null if no frontmatter found. */
  manifest: SkillManifest | null;

  /** Markdown body content (everything after the closing `---` delimiter). */
  body: string;

  /** Raw frontmatter object preserving all fields including unknown ones. */
  rawFrontmatter: Record<string, unknown>;
}

// ─── Backend Paths ──────────────────────────────────────────────────────────

/**
 * Resolved filesystem paths for a specific backend runtime.
 *
 * This is the compile-time contract each wrapper must satisfy. The core
 * materializer has zero knowledge of which runtimes exist — it simply
 * writes to the paths provided here.
 *
 * Adding a new runtime (a2a-claude, a2a-codex, etc.) requires only defining
 * a `BackendPaths` object in the new wrapper project, with no changes to core.
 * TypeScript enforces the contract: if a wrapper forgets `instructionsPath`
 * or `skillsBaseDir`, it won't compile.
 *
 * @example
 * ```typescript
 * const CLAUDE_PATHS: BackendPaths = {
 *   instructionsPath: "CLAUDE.md",
 *   skillsBaseDir: ".claude/skills",
 * };
 * ```
 */
export interface BackendPaths {
  /** Where to write the instructions file (relative to workspace root). */
  instructionsPath: string;

  /** Directory where skill subdirectories are created (relative to workspace root). */
  skillsBaseDir: string;
}

// ─── Materialize Options ────────────────────────────────────────────────────

/**
 * Input parameters for the {@link materializeMemory} function.
 *
 * Bundles all information the materializer needs: what to materialize
 * (memoryConfig), where sources live (configDir), where to write
 * (workspaceDir), and the backend-specific path layout (paths).
 */
export interface MaterializeOptions {
  /** The parsed memory config section from agent config.json. */
  memoryConfig: MemoryConfig;

  /**
   * Directory containing the agent's config.json file.
   * Used as the base for resolving relative paths in memoryConfig.
   */
  configDir: string;

  /** The agent's workspace directory where materialized files are written. */
  workspaceDir: string;

  /** Backend-specific paths — each wrapper provides its own. */
  paths: BackendPaths;
}
