/**
 * Memory Materializer
 *
 * Reads source files (instructions and skills) declared in the agent's memory
 * config and writes them to backend-specific paths in the workspace directory.
 *
 * Behavior:
 * - Missing source files: logs warning, skips (does not throw)
 * - Invalid skill manifests: logs warning with reason and path, skips
 * - Filesystem write errors: throws (prevents agent startup)
 * - Creates intermediate directories as needed (mkdir -p semantics)
 * - Overwrites existing files for idempotent behavior
 *
 * @module memory/materializer
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../utils/logger.js";
import { parseSkillManifest, validateSkillManifest } from "./parser.js";
import { resolveMemoryPath } from "./paths.js";
import type { MaterializeOptions } from "./types.js";

const logger = createLogger("a2a-core").child("memory");

/**
 * Known resource directory names that are copied alongside SKILL.md.
 */
const RESOURCE_DIRS = ["scripts", "references", "assets"] as const;

/**
 * Materialize memory (instructions and skills) into the agent's workspace.
 *
 * This is the primary entry point called by executors during initialize().
 * It reads source files, validates skill manifests, and writes content to
 * backend-specific paths in the workspace directory.
 *
 * @param options - Materialization parameters
 * @throws Error if filesystem write operations fail
 */
export async function materializeMemory(options: MaterializeOptions): Promise<void> {
  const { memoryConfig, configDir, workspaceDir, paths } = options;

  // Materialize instructions if configured
  if (memoryConfig.instructions) {
    await materializeInstructions(memoryConfig.instructions, configDir, workspaceDir, paths.instructionsPath);
  }

  // Materialize skills if configured
  if (memoryConfig.skills && memoryConfig.skills.length > 0) {
    for (const skillPath of memoryConfig.skills) {
      await materializeSkill(skillPath, configDir, workspaceDir, paths.skillsBaseDir);
    }
  }
}

/**
 * Materialize a single instructions file to the backend-specific target path.
 */
async function materializeInstructions(
  instructionsPath: string,
  configDir: string,
  workspaceDir: string,
  targetRelativePath: string,
): Promise<void> {
  const resolvedSource = resolveMemoryPath(instructionsPath, configDir);

  // Try to read the source file
  let content: string;
  try {
    content = await fs.readFile(resolvedSource, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) {
      logger.warn("instructions file not found, skipping", { path: resolvedSource });
      return;
    }
    throw err;
  }

  // Compute target path and write
  const targetPath = path.join(workspaceDir, targetRelativePath);
  await writeFileWithDirs(targetPath, content);
  logger.info("materialized instructions", { target: targetPath });
}

/**
 * Materialize a single skill directory to the backend-specific target.
 */
async function materializeSkill(
  skillPath: string,
  configDir: string,
  workspaceDir: string,
  skillsBaseDir: string,
): Promise<void> {
  const resolvedSkillDir = resolveMemoryPath(skillPath, configDir);
  const skillMdPath = path.join(resolvedSkillDir, "SKILL.md");

  // Check for SKILL.md
  let skillContent: string;
  try {
    skillContent = await fs.readFile(skillMdPath, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) {
      logger.warn("skill directory missing SKILL.md, skipping", { path: resolvedSkillDir });
      return;
    }
    throw err;
  }

  // Parse the SKILL.md
  const parsed = parseSkillManifest(skillContent);

  if (!parsed.manifest) {
    logger.warn("invalid skill manifest: missing required frontmatter fields", { path: skillMdPath });
    return;
  }

  // Validate the manifest
  const validationError = validateSkillManifest(parsed.manifest);
  if (validationError) {
    logger.warn("invalid skill manifest", { path: skillMdPath, reason: validationError });
    return;
  }

  // Compute target directory using the manifest name
  const targetDir = path.join(workspaceDir, skillsBaseDir, parsed.manifest.name);

  // Create target directory
  await fs.mkdir(targetDir, { recursive: true });

  // Write SKILL.md to target
  const targetSkillMd = path.join(targetDir, "SKILL.md");
  await writeFileWithDirs(targetSkillMd, skillContent);
  logger.info("materialized skill", { name: parsed.manifest.name, target: targetDir });

  // Copy resource directories if they exist
  for (const resourceDir of RESOURCE_DIRS) {
    const sourceResourceDir = path.join(resolvedSkillDir, resourceDir);
    const targetResourceDir = path.join(targetDir, resourceDir);

    try {
      const stat = await fs.stat(sourceResourceDir);
      if (stat.isDirectory()) {
        await copyDirectoryRecursive(sourceResourceDir, targetResourceDir);
      }
    } catch (err: unknown) {
      if (isEnoent(err)) {
        // Resource directory doesn't exist, skip silently
        continue;
      }
      throw err;
    }
  }
}

/**
 * Write content to a file, creating intermediate directories as needed.
 * Overwrites existing files for idempotent behavior.
 */
async function writeFileWithDirs(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Recursively copy a directory and its contents to a target location.
 * Preserves relative directory structure and file contents.
 */
async function copyDirectoryRecursive(source: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });

  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, targetPath);
    } else {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

/**
 * Type guard to check if an error is an ENOENT (file not found) error.
 */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
