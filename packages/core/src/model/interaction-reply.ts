/**
 * @module model/interaction-reply
 *
 * Parse a caller's reply to the PRESENTED interaction into a {@link CoreInteractionResult}.
 * Pure and SDK-free (the runtime calls it); the A2A adapter re-exports it.
 *
 * @see docs/design/core-data-model.md sections 3.3 and 4
 */

import { isJsonObject, type JsonObject } from "./json.js";
import {
  APPROVING_OPTION_KINDS,
  type CoreInteraction,
  type CoreInteractionResult,
  type FlatSchemaProperty,
  type UnknownInteraction,
} from "./interaction.js";
import type { CoreCaller, CorePart } from "./primitives.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every field of every kind, for code that handles all kinds the same way. */
const view = (i: CoreInteraction): UnknownInteraction => i as UnknownInteraction;

const norm = (s: string) => s.trim().toLowerCase();
const APPROVE_WORDS = new Set(["approve", "allow", "yes", "y"]);
const DENY_WORDS = new Set(["deny", "reject", "no", "n", "decline"]);
const DONE_WORDS = new Set(["done", "completed", "authenticated", "signed in"]);

function replyText(parts: readonly CorePart[]): string {
  return parts
    .map((p) => (p.kind === "text" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Match a token against numbered options by 1-based number, id, then label. */
function matchByToken<T extends { id: string; label: string }>(token: string, options: readonly T[]): T | undefined {
  const t = norm(token);
  if (!t) return undefined;
  if (/^\d+$/.test(t)) return options[Number(t) - 1];
  return options.find((o) => norm(o.id) === t) ?? options.find((o) => norm(o.label) === t);
}

/** Remove one token equal to the reply code (ignoring case and wrapping punctuation). */
function takeReplyCode(text: string, code: string | undefined): { text: string; hadCode: boolean } {
  if (!code) return { text, hadCode: false };
  const tokens = text.trim().split(/\s+/);
  const at = tokens.findIndex((t) => t.replace(/^[`#*_([]+|[`*_.,;:!)\]]+$/g, "").toUpperCase() === code.toUpperCase());
  if (at < 0) return { text, hadCode: false };
  tokens.splice(at, 1);
  return { text: tokens.join(" "), hadCode: true };
}

/** Does `v` satisfy one property of a flat form schema? */
function matchesProperty(p: FlatSchemaProperty, v: unknown): boolean {
  if (p.type === "array") {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return false;
    if (typeof p.minItems === "number" && v.length < p.minItems) return false;
    if (typeof p.maxItems === "number" && v.length > p.maxItems) return false;
    const allowed = p.items?.enum ?? p.items?.anyOf?.map((c) => c.const);
    return !allowed || v.every((x) => allowed.includes(x));
  }
  if (p.type === "string" && typeof v !== "string") return false;
  if ((p.type === "number" || p.type === "integer") && typeof v !== "number") return false;
  if (p.type === "integer" && !Number.isInteger(v)) return false;
  if (p.type === "boolean" && typeof v !== "boolean") return false;
  if (Array.isArray(p.enum) && !p.enum.includes(v as never)) return false;
  if (Array.isArray(p.oneOf) && !p.oneOf.some((c) => c.const === v)) return false;
  return true;
}

function parseStructured(
  interaction: CoreInteraction,
  data: Record<string, unknown>,
  by: CoreCaller,
): CoreInteractionResult | undefined {
  const i = view(interaction);

  if (typeof data.optionId === "string") {
    const option = i.options?.find((o) => o.id === data.optionId);
    if (!option) return undefined;
    if (data.amendment !== undefined && !isJsonObject(data.amendment)) return undefined;
    return {
      outcome: "selected",
      optionId: option.id,
      ...(typeof data.feedback === "string" && data.feedback ? { feedback: data.feedback } : {}),
      ...(data.amendment !== undefined ? { amendment: data.amendment as JsonObject } : {}),
      by,
    };
  }

  if (isObject(data.answers) && i.questions?.length) {
    const answers: Record<string, { optionIds?: string[]; text?: string; freeText?: string }> = {};
    const given = data.answers as Record<string, unknown>;
    for (const key of Object.keys(given)) {
      if (!i.questions.some((q) => q.id === key)) return undefined;
    }
    for (const q of i.questions) {
      const a = Object.hasOwn(given, q.id) ? given[q.id] : undefined;
      if (!isObject(a)) return undefined;
      const entry: { optionIds?: string[]; text?: string; freeText?: string } = {};
      if (a.optionIds !== undefined) {
        if (!Array.isArray(a.optionIds) || !a.optionIds.every((x) => typeof x === "string")) return undefined;
        const ids = a.optionIds as string[];
        if (!ids.every((id) => q.options?.some((o) => o.id === id))) return undefined;
        if (ids.length > 1 && !q.multi) return undefined;
        entry.optionIds = ids;
      }
      if (a.text !== undefined) {
        if (typeof a.text !== "string") return undefined;
        if (q.options?.length && !q.allowFreeform) return undefined;
        entry.text = a.text;
      }
      if (a.freeText !== undefined) {
        if (typeof a.freeText !== "string" || !q.allowFreeform) return undefined;
        entry.freeText = a.freeText;
      }
      if (entry.optionIds === undefined && entry.text === undefined && entry.freeText === undefined) return undefined;
      answers[q.id] = entry;
    }
    return { outcome: "answered", answers, by };
  }

  if (isObject(data.values) && i.schema) {
    if (!isJsonObject(data.values)) return undefined;
    const values = data.values;
    const props = i.schema.properties ?? {};
    for (const [k, v] of Object.entries(values)) {
      // Own properties only: a key like "constructor" must not pass for a declared field.
      if (!Object.hasOwn(props, k)) return undefined;
      if (!matchesProperty(props[k]!, v)) return undefined;
    }
    for (const r of i.schema.required ?? []) if (!Object.hasOwn(values, r)) return undefined;
    return { outcome: "submitted", values, by };
  }

  if (data.declined === true) {
    return {
      outcome: "declined",
      ...(typeof data.feedback === "string" && data.feedback ? { feedback: data.feedback } : {}),
      by,
    };
  }
  if (data.dismissed === true) return { outcome: "dismissed", by };
  if (data.completed === true && i.kind === "auth") return { outcome: "completed", by };
  return undefined;
}

function parseText(interaction: CoreInteraction, rawText: string, by: CoreCaller): CoreInteractionResult | undefined {
  const i = view(interaction);
  if (!norm(rawText)) return undefined;

  const options = i.options;
  if (options?.length) {
    // An allow_* option is chosen from text only with the presented interaction's
    // code, so a stale "yes" meant for an earlier interaction cannot approve this one.
    const { text, hadCode } = takeReplyCode(rawText.trim().replace(/^`+|`+$/g, ""), i.replyCode);
    const t = norm(text);
    if (!t) return undefined;
    const approving = (o: { kind: string }) => APPROVING_OPTION_KINDS.includes(o.kind);
    const hit = matchByToken(text, options);
    if (hit) {
      if (approving(hit) && !hadCode) return undefined;
      return { outcome: "selected", optionId: hit.id, by };
    }
    if (APPROVE_WORDS.has(t)) {
      if (!hadCode) return undefined;
      const allow = options.find((o) => o.kind === "allow_once");
      return allow ? { outcome: "selected", optionId: allow.id, by } : undefined;
    }
    if (DENY_WORDS.has(t)) {
      // Prefer a plain reject; an interrupting one (it also aborts the turn) only when there is no other.
      const rejects = options.filter((o) => o.kind === "reject_once");
      const reject = rejects.find((o) => !o.interrupts) ?? rejects[0];
      return reject ? { outcome: "selected", optionId: reject.id, by } : { outcome: "declined", by };
    }
    return undefined;
  }

  const t = norm(rawText);
  const qs = i.questions;
  // With questions, "no" and "n" are answers, not refusals: decline only via a structured `declined`.
  if (!qs?.length && DENY_WORDS.has(t)) return { outcome: "declined", by };
  if (i.kind === "auth" && DONE_WORDS.has(t)) return { outcome: "completed", by };

  if (qs?.length === 1) {
    const q = qs[0]!;
    const text = rawText;
    if (q.options?.length) {
      const tokens = q.multi ? text.split(",") : [text];
      const hits = tokens.map((tok) => matchByToken(tok, q.options!));
      if (hits.every(Boolean)) {
        return { outcome: "answered", answers: { [q.id]: { optionIds: hits.map((h) => h!.id) } }, by };
      }
    }
    if (q.allowFreeform || !q.options?.length) {
      return { outcome: "answered", answers: { [q.id]: { text: text.trim() } }, by };
    }
  }
  return undefined;
}

/**
 * Parse a caller's reply to the PRESENTED interaction into a result, or
 * `undefined` when the message is not a valid reply (so core ignores it with no
 * side effect).
 *
 * Structured first: a data part `{interactionId, optionId | answers | values |
 * declined | dismissed | completed}`. A data part naming another interaction id
 * makes the whole message not-a-reply. Text fallback second: option number, id
 * or label; `approve`/`allow`/`yes` select the first `allow_once` option only
 * (never an `allow_always`); `deny`/`reject`/`no` select the first `reject_once`
 * option or decline. Selecting any `allow_*` option from text requires the
 * interaction's `replyCode` in the reply ("1 K7"); no code, a wrong code, or an
 * interaction with no code means the reply is ignored. Anything ambiguous,
 * unknown or invalid is `undefined`: a reply never approves by guesswork (D5).
 * With questions, a free-form answer such as "no" is an answer, never a refusal.
 */
export function parseInteractionReply(
  interaction: CoreInteraction,
  parts: readonly CorePart[],
  by: CoreCaller,
): CoreInteractionResult | undefined {
  const structured = parts.filter(
    (p): p is Extract<CorePart, { kind: "data" }> =>
      p.kind === "data" && isObject(p.data) && typeof (p.data as Record<string, unknown>).interactionId === "string",
  );
  if (structured.length > 0) {
    const mine = structured.filter((p) => (p.data as Record<string, unknown>).interactionId === interaction.id);
    if (mine.length === 0 || mine.length !== structured.length) return undefined;
    return parseStructured(interaction, mine[0]!.data as Record<string, unknown>, by);
  }
  return parseText(interaction, replyText(parts), by);
}
