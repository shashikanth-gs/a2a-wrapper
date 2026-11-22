/** What a tool call's arguments and result look like in a trace event: secrets redacted, size capped. */

const MAX_DATA_SIZE = 100_000;
const SENSITIVE_KEYS = new Set([
  "token", "access_token", "authorization", "api_key", "apikey",
  "password", "secret", "credential",
]);

export function sanitize(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(sanitize);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "<redacted>" : sanitize(val);
  }
  return out;
}

export function truncate(data: unknown): unknown {
  if (typeof data === "string" && data.length > MAX_DATA_SIZE) {
    return data.substring(0, MAX_DATA_SIZE) + `... [truncated, total ${data.length} chars]`;
  }
  let json: string;
  try { json = JSON.stringify(data); } catch { json = '"<unserializable>"'; }
  if (json.length > MAX_DATA_SIZE) {
    return { _truncated: true, _original_size: json.length, preview: json.substring(0, MAX_DATA_SIZE) };
  }
  return data;
}
