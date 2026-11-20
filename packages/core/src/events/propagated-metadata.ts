/**
 * Orchestrator-supplied `propagated_metadata` is stamped on every sideband
 * event. It is caller-controlled, so it is bounded and scrubbed first
 * (design: docs/design/distributed-tracing.md, section 8.7).
 *
 * @module events/propagated-metadata
 */

/** Maximum number of keys kept. */
export const MAX_PROPAGATED_KEYS = 64;
/** Maximum serialized size (UTF-8 bytes) of the kept metadata. */
export const MAX_PROPAGATED_BYTES = 8 * 1024;

const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const SECRET_KEY = /(pass(word|key|phrase)?|secret|token|authorization|api[-_.]?key|cookie|credential|private[-_.]?key)/i;

export const REDACTED = "[redacted]";

/**
 * Return a bounded, scrubbed copy of caller-supplied metadata, or `undefined`
 * when nothing usable remains.
 *
 * - Only plain objects are accepted.
 * - Keys must match `[A-Za-z0-9_.-]{1,64}`; others are dropped.
 * - Keys that look like secrets (password, token, authorization, ...) keep the
 *   key but have their value replaced by `"[redacted]"`.
 * - At most 64 keys and 8 KB serialized; later keys are dropped first.
 * - Values that cannot be serialized as JSON are dropped.
 */
export function sanitizePropagatedMetadata(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;

  const out: Record<string, unknown> = {};
  let bytes = 2; // "{}"
  let count = 0;

  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_PROPAGATED_KEYS) break;
    if (!KEY_PATTERN.test(key)) continue;

    const value = SECRET_KEY.test(key) ? REDACTED : raw;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      continue;
    }
    if (serialized === undefined) continue;

    // key + quotes + colon + comma
    const cost = Buffer.byteLength(key, "utf8") + Buffer.byteLength(serialized, "utf8") + 4;
    if (bytes + cost > MAX_PROPAGATED_BYTES) continue;

    out[key] = value;
    bytes += cost;
    count++;
  }

  return count > 0 ? out : undefined;
}
