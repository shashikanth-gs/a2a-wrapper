/**
 * SKILL.md Parser
 *
 * Provides functions to parse, format, and validate SKILL.md files.
 * Uses a simple regex-based YAML parser for flat key-value frontmatter
 * to avoid adding a js-yaml dependency to the core package.
 *
 * The parser handles:
 * - Simple string values: `name: my-skill`
 * - Quoted strings: `description: "A skill that does things"`
 * - Arrays: `compatibility:\n  - backend-a\n  - backend-b`
 *
 * @module memory/parser
 */

import type { ParsedSkill, SkillManifest } from "./types.js";

/**
 * Regex pattern for valid kebab-case names.
 * Lowercase alphanumeric characters and hyphens only.
 * No leading/trailing hyphens, no consecutive hyphens.
 */
const KEBAB_CASE_REGEX = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/;

/**
 * Maximum allowed length for a skill name.
 */
const MAX_NAME_LENGTH = 64;

/**
 * Parse a SKILL.md file content into frontmatter and body.
 *
 * Extracts YAML frontmatter delimited by --- markers at the start of the file.
 * If no frontmatter delimiters are found, returns empty frontmatter and the
 * entire content as body.
 *
 * @param content - Raw SKILL.md file content
 * @returns Parsed skill with manifest, body, and raw frontmatter
 */
export function parseSkillManifest(content: string): ParsedSkill {
  // Check if content starts with --- delimiter
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return {
      manifest: null,
      body: content,
      rawFrontmatter: {},
    };
  }

  // Find the closing --- delimiter after the opening one
  const openingDelimiterEnd = content.indexOf("\n") + 1;
  const closingIndex = findClosingDelimiter(content, openingDelimiterEnd);

  if (closingIndex === -1) {
    // No closing delimiter found — treat entire content as body
    return {
      manifest: null,
      body: content,
      rawFrontmatter: {},
    };
  }

  // Extract frontmatter text between delimiters
  const frontmatterText = content.slice(openingDelimiterEnd, closingIndex);

  // Find the end of the closing delimiter line
  const closingLineEnd = content.indexOf("\n", closingIndex);
  const bodyStart = closingLineEnd === -1 ? content.length : closingLineEnd + 1;
  const body = content.slice(bodyStart);

  // Parse the YAML frontmatter (keys preserved verbatim)
  const rawFrontmatter = parseSimpleYaml(frontmatterText);

  // Normalize keys to camelCase for building the typed manifest
  const normalized = normalizeKeys(rawFrontmatter);
  const manifest = buildManifest(normalized);

  return {
    manifest,
    body,
    rawFrontmatter,
  };
}

/**
 * Format a parsed skill back into SKILL.md file content.
 * Used for round-trip testing and potential future skill generation.
 *
 * @param frontmatter - The frontmatter fields to serialize as YAML
 * @param body - The markdown body content
 * @returns Formatted SKILL.md content string
 */
export function formatSkillManifest(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const keys = Object.keys(frontmatter);

  if (keys.length === 0) {
    return body;
  }

  const yamlLines = serializeToYaml(frontmatter);
  const frontmatterBlock = `---\n${yamlLines}---\n`;

  return frontmatterBlock + body;
}

/**
 * Validate a skill manifest against naming rules.
 *
 * Rules:
 * - name is required and must be a non-empty string
 * - description is required and must be a non-empty string
 * - name must be kebab-case (lowercase alphanumeric + hyphens, no leading/trailing hyphens)
 * - name must not exceed 64 characters
 *
 * @returns null if valid, or a string describing the validation error
 */
export function validateSkillManifest(
  manifest: Partial<SkillManifest>,
): string | null {
  // Check name is present and non-empty
  if (!manifest.name || typeof manifest.name !== "string" || manifest.name.trim() === "") {
    return "name is required and must be a non-empty string";
  }

  // Check description is present and non-empty
  if (
    !manifest.description ||
    typeof manifest.description !== "string" ||
    manifest.description.trim() === ""
  ) {
    return "description is required and must be a non-empty string";
  }

  // Check name length
  if (manifest.name.length > MAX_NAME_LENGTH) {
    return `name must not exceed ${MAX_NAME_LENGTH} characters (got ${manifest.name.length})`;
  }

  // Check kebab-case format
  if (!KEBAB_CASE_REGEX.test(manifest.name)) {
    return "name must be kebab-case (lowercase alphanumeric and hyphens, no leading/trailing/consecutive hyphens)";
  }

  return null;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Find the closing `---` delimiter in content starting from a given offset.
 * The closing delimiter must be on its own line.
 */
function findClosingDelimiter(content: string, startOffset: number): number {
  let pos = startOffset;

  while (pos < content.length) {
    const lineEnd = content.indexOf("\n", pos);
    const line = lineEnd === -1 ? content.slice(pos) : content.slice(pos, lineEnd);

    // Check if this line is exactly "---" (possibly with \r)
    const trimmed = line.replace(/\r$/, "");
    if (trimmed === "---") {
      return pos;
    }

    if (lineEnd === -1) {
      break;
    }
    pos = lineEnd + 1;
  }

  return -1;
}

/**
 * Parse simple YAML frontmatter into a key-value object.
 * Handles:
 * - Simple string values: `key: value`
 * - Quoted strings: `key: "value"` or `key: 'value'`
 * - Arrays: `key:\n  - item1\n  - item2`
 *
 * Keys are stored verbatim (preserving original casing and hyphens).
 * Use {@link normalizeKeys} to get a camelCase version for manifest building.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\r$/, "");

    // Skip empty lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Match a key-value pair: `key: value` or `key:`
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)/);
    if (!kvMatch) {
      i++;
      continue;
    }

    const key = kvMatch[1];
    const valueStr = kvMatch[2].trim();

    // Check if next lines are array items (indented with `- `)
    if (valueStr === "" && i + 1 < lines.length) {
      const nextLine = lines[i + 1]?.replace(/\r$/, "") ?? "";
      if (nextLine.match(/^\s+-\s/)) {
        // Parse array
        const items: string[] = [];
        i++;
        while (i < lines.length) {
          const arrLine = lines[i].replace(/\r$/, "");
          const arrMatch = arrLine.match(/^\s+-\s+(.*)/);
          if (arrMatch) {
            items.push(unquote(arrMatch[1].trim()));
            i++;
          } else {
            break;
          }
        }
        result[key] = items;
        continue;
      }
    }

    // Simple value
    result[key] = valueStr === "" ? "" : unquote(valueStr);
    i++;
  }

  return result;
}

/**
 * Normalize a raw frontmatter object's keys to camelCase.
 * Used internally for building the typed SkillManifest from raw YAML keys.
 * e.g., "allowed-tools" → "allowedTools"
 */
function normalizeKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key.includes("-")
      ? key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      : key;
    result[normalized] = value;
  }
  return result;
}

/**
 * Remove surrounding quotes from a string value.
 */
function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Serialize a frontmatter object to YAML lines.
 * Keys are written as-is (they should already be in their original YAML form
 * when coming from rawFrontmatter, or in camelCase when coming from code).
 * CamelCase keys are converted to kebab-case for YAML output.
 */
function serializeToYaml(obj: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    // Convert camelCase to kebab-case only if the key contains uppercase letters
    // (i.e., it was programmatically constructed). Keys from rawFrontmatter are
    // already in their original form and pass through unchanged.
    const yamlKey = /[A-Z]/.test(key) ? camelToKebab(key) : key;

    if (Array.isArray(value)) {
      lines.push(`${yamlKey}:`);
      for (const item of value) {
        lines.push(`  - ${serializeValue(String(item))}`);
      }
    } else if (value !== undefined && value !== null) {
      lines.push(`${yamlKey}: ${serializeValue(String(value))}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

/**
 * Convert a camelCase key to kebab-case for YAML output.
 */
function camelToKebab(key: string): string {
  return key.replace(/([A-Z])/g, "-$1").toLowerCase();
}

/**
 * Serialize a single value, quoting if it contains special characters.
 */
function serializeValue(value: string): string {
  // Quote values that contain characters that could be ambiguous in YAML
  if (
    value.includes(":") ||
    value.includes("#") ||
    value.includes("{") ||
    value.includes("}") ||
    value.includes("[") ||
    value.includes("]") ||
    value.includes(",") ||
    value.includes("&") ||
    value.includes("*") ||
    value.includes("!") ||
    value.includes("|") ||
    value.includes(">") ||
    value.includes("'") ||
    value.includes('"') ||
    value.includes("%") ||
    value.includes("@") ||
    value.includes("`") ||
    value.startsWith(" ") ||
    value.endsWith(" ")
  ) {
    // Use double quotes, escaping internal double quotes
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Build a typed SkillManifest from raw frontmatter, or return null if
 * required fields are missing.
 */
function buildManifest(raw: Record<string, unknown>): SkillManifest | null {
  const name = raw.name;
  const description = raw.description;

  if (typeof name !== "string" || typeof description !== "string") {
    return null;
  }

  if (name.trim() === "" || description.trim() === "") {
    return null;
  }

  const manifest: SkillManifest = {
    name,
    description,
  };

  if (typeof raw.license === "string" && raw.license !== "") {
    manifest.license = raw.license;
  }

  if (Array.isArray(raw.compatibility)) {
    manifest.compatibility = raw.compatibility.map(String);
  }

  if (Array.isArray(raw.allowedTools)) {
    manifest.allowedTools = raw.allowedTools.map(String);
  }

  // Collect remaining fields as metadata
  const knownKeys = new Set(["name", "description", "license", "compatibility", "allowedTools"]);
  const metadataEntries = Object.entries(raw).filter(([k]) => !knownKeys.has(k));
  if (metadataEntries.length > 0) {
    manifest.metadata = Object.fromEntries(metadataEntries);
  }

  return manifest;
}
