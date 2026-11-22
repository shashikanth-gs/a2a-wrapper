/**
 * @module model/json
 *
 * JSON-safe value types. Everything core persists (records, stored interactions
 * and their results) is built from these, so a record survives
 * `JSON.stringify` / `JSON.parse` unchanged. Live provider-facing metadata
 * (`Meta`) stays loose; only what is stored is held to this.
 *
 * @see docs/design/core-data-model.md section 3.6
 */

/** Any JSON value. `undefined`, functions, bigint, symbols and typed arrays are not JSON. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** A JSON object. */
export type JsonObject = { readonly [key: string]: Json };

/** `true` when `value` is a JSON value (finite numbers only, plain objects only, no cycles beyond a depth bound). */
export function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 64) return false;
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (Array.isArray(value)) return value.every((v) => isJson(v, depth + 1));
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value as object).every((v) => isJson(v, depth + 1));
    }
    default:
      return false;
  }
}

/** `true` when `value` is a JSON object (not an array, not null). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJson(value);
}
