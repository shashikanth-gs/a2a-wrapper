/**
 * @module config/model
 *
 * One rule for the `model` setting across every wrapper: never pin a model name
 * in code. A model that is unset, empty, `"auto"` or `"default"` means "let the
 * provider choose". What the provider does with that is provider-specific (Copilot
 * accepts the literal `auto`; most others simply omit the model so the backend
 * applies its own default; Codex resolves it from its account catalog), but the
 * *meaning* of the setting is shared and lives here.
 */

/** The canonical spelling of "let the provider choose". */
export const AUTO_MODEL = "auto";

/** Values that mean "let the provider choose", compared case-insensitively. */
const AUTO_VALUES = new Set(["", "auto", "default"]);

/**
 * `true` when the setting asks the provider to choose: not a string, empty or
 * whitespace-only, `"auto"` or `"default"` (any case).
 */
export function isAutoModel(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return true;
  return AUTO_VALUES.has(value.trim().toLowerCase());
}

/**
 * The explicit model name to pass to a backend, or `undefined` when the
 * provider should choose. Trims surrounding whitespace.
 */
export function normalizeModel(value: unknown): string | undefined {
  return isAutoModel(value) ? undefined : (value as string).trim();
}
