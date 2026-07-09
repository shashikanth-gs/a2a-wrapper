/**
 * Backend Paths — Claude Code Memory Materialization Targets
 *
 * Claude Code reads project instructions from CLAUDE.md and skills from
 * .claude/skills within the workspace.
 */

import type { BackendPaths } from "@a2a-wrapper/core";

export const CLAUDE_BACKEND_PATHS: BackendPaths = {
  instructionsPath: "CLAUDE.md",
  skillsBaseDir: ".claude/skills",
};
