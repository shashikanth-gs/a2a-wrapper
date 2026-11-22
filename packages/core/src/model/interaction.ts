/**
 * @module model/interaction
 *
 * Interactions: a provider asks the caller something (permission, question,
 * form, auth challenge, confirmation) in core's vocabulary and gets a
 * {@link CoreInteractionResult} back. Results are produced by core only.
 *
 * ### Shapes
 *
 * `CoreInteraction` is a union keyed by `kind`; each known kind has the fields
 * it needs (a permission has options, a question has questions, ...). The open
 * {@link UnknownInteraction} member carries a kind this core version does not
 * model. Because that member accepts any kind string, the compiler alone cannot
 * reject a malformed `permission`; {@link normalizeInteraction} is the check
 * core runs on every request a provider passes to `run.ask`.
 *
 * ### Several asks in one task
 *
 * A task presents one interaction at a time. Asks made while one is presented
 * wait in a per-task FIFO (`PendingInteraction.state: "queued"`), in `seq`
 * order; exactly one is `presented`. When it ends (answered, expired,
 * canceled or withdrawn) the next queued one is presented. See `records.ts`.
 *
 * @see docs/design/core-data-model.md section 3.3
 */

import type { Json, JsonObject } from "./json.js";
import { isJson } from "./json.js";
import type { CoreCaller, Open } from "./primitives.js";

export interface InteractionSubject {
  tool?: string;
  action?: string;
  command?: string;
  /** Paths, URLs, patterns. */
  resources?: readonly string[];
  risk?: Open<"low" | "medium" | "high">;
  detail?: JsonObject;
}

/** A permission option. Shape follows ACP, plus core's own fields. */
export interface InteractionOption {
  id: string;
  label: string;
  kind: Open<"allow_once" | "allow_always" | "reject_once" | "reject_always">;
  scope?: Open<"call" | "session" | "context" | "location" | "project" | "permanent">;
  /** A reject may carry text for the model. */
  allowsFeedback?: boolean;
  /** Choosing it also aborts the turn. */
  interrupts?: boolean;
}

/** One selectable answer of a {@link Question}. */
export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  /** Provider data that rides along with the option. */
  meta?: JsonObject;
}

/** One entry of a `question` interaction. */
export interface Question {
  id: string;
  header?: string;
  prompt: string;
  options?: readonly QuestionOption[];
  multi?: boolean;
  allowFreeform?: boolean;
  /** Never logged, persisted or traced in clear. */
  secret?: boolean;
}

/** An enum member with a display title (JSON Schema `oneOf` of `const` + `title`). */
export interface TitledChoice {
  const: string | number | boolean;
  title: string;
}

/** Items of a multi-select array property: plain or titled string choices. */
export interface FlatArrayItems {
  type?: "string";
  enum?: readonly string[];
  anyOf?: readonly { const: string; title: string }[];
}

/** One property of a {@link FlatSchema}. */
export interface FlatSchemaProperty {
  type?: Open<"string" | "number" | "integer" | "boolean" | "array">;
  title?: string;
  description?: string;
  enum?: readonly Json[];
  /** Titled single choice: each `const` with a display `title`. */
  oneOf?: readonly TitledChoice[];
  /** `type: "array"` only: multi-select of string choices. */
  items?: FlatArrayItems;
  minItems?: number;
  maxItems?: number;
  default?: Json;
  [extra: string]: unknown;
}

/** Flat JSON Schema subset for forms (as MCP elicitation: primitives, enums, multi-select). */
export interface FlatSchema {
  type?: "object";
  properties: Readonly<Record<string, FlatSchemaProperty>>;
  required?: readonly string[];
}

/** Out-of-band auth only. There are no credential forms. */
export interface AuthChallenge {
  service: string;
  url?: string;
  /** Device-code flows. */
  userCode?: string;
  instructions?: string;
}

/** Fields every interaction has. */
export interface InteractionBase {
  /** Core-assigned, stable; the idempotency key. */
  id: string;
  title: string;
  description?: string;
  subject?: InteractionSubject;
  /** ISO timestamp. Core fills it from policy when absent. */
  expiresAt?: string;
  /**
   * Core-assigned short code. A text reply may select an `allow_*` option only
   * when it carries this code, so a stale "yes" meant for an earlier interaction
   * cannot approve this one. Rendered as, for example, "Reply `1 K7`".
   */
  replyCode?: string;
  meta?: JsonObject;
}

type NonEmpty<T> = readonly [T, ...T[]];

export interface PermissionInteraction extends InteractionBase {
  kind: "permission";
  options: NonEmpty<InteractionOption>;
}

export interface ConfirmInteraction extends InteractionBase {
  kind: "confirm";
  options: NonEmpty<InteractionOption>;
}

export interface QuestionInteraction extends InteractionBase {
  kind: "question";
  questions: NonEmpty<Question>;
}

export interface FormInteraction extends InteractionBase {
  kind: "form";
  schema: FlatSchema;
}

export interface AuthInteraction extends InteractionBase {
  kind: "auth";
  auth: AuthChallenge;
}

/** A kind this core version does not model. Carried intact; only explicit option selection answers it. */
export interface UnknownInteraction extends InteractionBase {
  kind: string & {};
  options?: readonly InteractionOption[];
  questions?: readonly Question[];
  schema?: FlatSchema;
  auth?: AuthChallenge;
}

export type CoreInteraction =
  | PermissionInteraction
  | ConfirmInteraction
  | QuestionInteraction
  | FormInteraction
  | AuthInteraction
  | UnknownInteraction;

/** What `run.ask` takes: an interaction without the fields core assigns. */
type AsRequest<T> = T extends unknown ? Omit<T, "id" | "expiresAt" | "replyCode"> & { expiresAt?: string } : never;

/**
 * What a provider passes to `run.ask`: core adds `id`, `replyCode` and (by
 * policy) `expiresAt`. A `confirm` may omit `options`; core fills in
 * allow_once / reject_once.
 */
export type CoreInteractionRequest =
  | AsRequest<Exclude<CoreInteraction, ConfirmInteraction>>
  | (Omit<AsRequest<ConfirmInteraction>, "options"> & { options?: readonly InteractionOption[] });

/** Options for `run.ask`. */
export interface AskOptions {
  /**
   * Opaque provider data (a request id, ...). Its presence is the signal that
   * the interaction can be re-attached after a restart; absent means it cannot.
   */
  handle?: string;
  /**
   * Withdraw the ask: when it aborts before an answer, core resolves the ask with
   * `{outcome: "withdrawn"}` and the interaction ends `withdrawn`. Use it when
   * the backend no longer needs the answer (the tool call was canceled).
   */
  signal?: AbortSignal;
}

/** Always produced by core, never by a provider. */
export type CoreInteractionResult =
  | {
      outcome: "selected";
      optionId: string;
      feedback?: string;
      /** Edits to the proposed action (for example changed tool input), as the provider defines them. */
      amendment?: JsonObject;
      by: CoreCaller;
    }
  | {
      outcome: "answered";
      answers: Readonly<
        Record<
          string,
          {
            optionIds?: readonly string[];
            /** Free-form answer. */
            text?: string;
            /** Free text typed in addition to or instead of the options ("other"), when the question allows it. */
            freeText?: string;
          }
        >
      >;
      by: CoreCaller;
    }
  | { outcome: "submitted"; values: JsonObject; by: CoreCaller }
  /** The caller explicitly refused. */
  | { outcome: "declined"; feedback?: string; by: CoreCaller }
  /** The caller closed the prompt without choosing (MCP elicitation `cancel`). */
  | { outcome: "dismissed"; by?: CoreCaller }
  | { outcome: "completed"; by?: CoreCaller }
  | { outcome: "canceled" }
  | { outcome: "expired" }
  /** The provider withdrew the ask through `AskOptions.signal`. */
  | { outcome: "withdrawn" }
  | { outcome: "unavailable"; reason: string; code?: UnavailableCode };

/**
 * Why `ask` answered `unavailable`, for a provider to act on without parsing `reason` (which is for people) and without
 * reading its own configuration. Open: a code this version does not know is treated as an ordinary denial.
 *
 * - `policy-auto`: nobody is asked (`interactions.mode: "auto"`) and no rule answered. The provider's native handling applies.
 * - `interactions-disabled`: the runtime has no interactions runtime.
 * - `invalid-request`: the request was malformed; never approve.
 * - `internal`: core failed internally; never approve.
 */
export type UnavailableCode = "policy-auto" | "interactions-disabled" | "invalid-request" | "internal" | (string & {});

/** Option kinds that approve. Anything else, including unknown kinds, does not (D5). */
export const APPROVING_OPTION_KINDS: readonly string[] = Object.freeze(["allow_once", "allow_always"]);

/**
 * Does this result approve the interaction? Unknown never approves (D5): only
 * an explicit `selected` outcome whose option exists on the interaction and has
 * a known `allow_*` kind returns `true`. Unknown outcomes, unknown option kinds,
 * unknown option ids, expired, unavailable, canceled, withdrawn, dismissed,
 * declined and malformed results all return `false`.
 */
export function isApproval(
  interaction: CoreInteraction | { readonly options?: readonly InteractionOption[] },
  result: CoreInteractionResult | { outcome: string } | null | undefined,
): boolean {
  if (!result || typeof result !== "object") return false;
  if ((result as { outcome?: unknown }).outcome !== "selected") return false;
  const optionId = (result as { optionId?: unknown }).optionId;
  if (typeof optionId !== "string") return false;
  const option = (interaction as { readonly options?: readonly InteractionOption[] }).options?.find((o) => o.id === optionId);
  if (!option) return false;
  return APPROVING_OPTION_KINDS.includes(option.kind);
}

// ─── Normalizing constructor ────────────────────────────────────────────────

/** The options a `confirm` gets when the provider gives none. */
export const DEFAULT_CONFIRM_OPTIONS: NonEmpty<InteractionOption> = Object.freeze([
  Object.freeze({ id: "allow", label: "Yes", kind: "allow_once", scope: "call" }),
  Object.freeze({ id: "reject", label: "No", kind: "reject_once" }),
]) as unknown as NonEmpty<InteractionOption>;

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/1/I/L/O

/** Length of a reply code. 31^4 is about 920,000 values. */
export const REPLY_CODE_LENGTH = 4;

/**
 * Short reply code for an interaction: {@link REPLY_CODE_LENGTH} characters from
 * an alphabet with no look-alikes, deterministic from the id and the per-task
 * `seq` (so re-rendering the prompt shows the same code, and two interactions of
 * one task never share a code by construction of `seq`). It guards against a
 * stale reply being applied to a different interaction; it is not a secret and
 * not authentication.
 */
export function replyCodeFor(interactionId: string, seq = 0): string {
  const input = `${interactionId}|${seq}`;
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Mix so the characters do not just follow the low bits of one multiply.
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  const n = CODE_ALPHABET.length;
  let code = "";
  let x = h >>> 0;
  for (let k = 0; k < REPLY_CODE_LENGTH; k++) {
    code += CODE_ALPHABET[x % n]!;
    x = Math.floor(x / n);
    if (x === 0) x = Math.imul(h ^ (k + 1), 2654435761) >>> 0;
  }
  return code;
}

/** Result of {@link normalizeInteraction}. */
export type NormalizeResult = { ok: true; interaction: CoreInteraction } | { ok: false; errors: string[] };

const KNOWN_KINDS: readonly string[] = ["permission", "confirm", "question", "form", "auth"];

/** Copy without `undefined`-valued keys (JSON has none), so optional fields set to undefined do not count as non-JSON. */
function withoutUndefined(v: unknown, depth = 0): unknown {
  if (depth > 64) return v;
  if (Array.isArray(v)) return v.map((x) => withoutUndefined(x, depth + 1));
  if (typeof v === "object" && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, withoutUndefined(x, depth + 1)]),
    );
  }
  return v;
}

const dupes = (ids: readonly string[]) => ids.filter((id, n) => ids.indexOf(id) !== n);

/**
 * Validate a provider's interaction request and build the {@link CoreInteraction}.
 * Core assigns `id`, `replyCode` (default {@link replyCodeFor}) and `expiresAt`.
 *
 * - `permission`: needs at least one option, with unique ids.
 * - `confirm`: options optional; without them it gets {@link DEFAULT_CONFIRM_OPTIONS}.
 * - `question`: needs at least one question with unique ids, option ids unique per question.
 * - `form`: needs a `schema` with `properties`.
 * - `auth`: needs `auth.service`.
 * - any other kind: accepted as is (open union).
 *
 * A malformed request is `{ok: false, errors}`; core then answers the ask with
 * `unavailable`, never a guess.
 */
export function normalizeInteraction(
  request: CoreInteractionRequest,
  assigned: { id: string; seq?: number; expiresAt?: string; replyCode?: string },
): NormalizeResult {
  const errors: string[] = [];
  const r = request as unknown as Record<string, unknown> & {
    kind?: unknown;
    options?: readonly InteractionOption[];
    questions?: readonly Question[];
    schema?: FlatSchema;
    auth?: AuthChallenge;
    meta?: unknown;
    subject?: unknown;
  };
  if (typeof r.kind !== "string" || !r.kind) errors.push("kind is required");
  else if (!KNOWN_KINDS.includes(r.kind) && KNOWN_KINDS.includes(r.kind.trim().toLowerCase()))
    errors.push(`kind "${r.kind}" looks like the known kind "${r.kind.trim().toLowerCase()}"; use the exact spelling`);
  if (typeof r.title !== "string") errors.push("title is required");
  if (!assigned.id) errors.push("id is required");

  const checkOptions = (required: boolean) => {
    const o = r.options;
    if (o === undefined && !required) return;
    if (!Array.isArray(o) || o.length === 0) return void errors.push(`${r.kind} needs at least one option`);
    if (o.some((x) => !x || typeof x.id !== "string" || typeof x.label !== "string" || typeof x.kind !== "string"))
      errors.push("every option needs id, label and kind");
    if (dupes(o.map((x) => x?.id)).length) errors.push("option ids must be unique");
  };

  switch (r.kind) {
    case "permission":
      checkOptions(true);
      break;
    case "confirm":
      checkOptions(false);
      break;
    case "question": {
      const q = r.questions;
      if (!Array.isArray(q) || q.length === 0) {
        errors.push("question needs at least one question");
        break;
      }
      if (q.some((x) => !x || typeof x.id !== "string" || typeof x.prompt !== "string"))
        errors.push("every question needs id and prompt");
      if (dupes(q.map((x) => x?.id)).length) errors.push("question ids must be unique");
      for (const x of q) {
        if (x?.options && dupes(x.options.map((o: { id: string }) => o?.id)).length) errors.push(`option ids of question ${x.id} must be unique`);
        if (x?.options?.length === 0 && !x.allowFreeform) errors.push(`question ${x.id} has no way to be answered`);
      }
      break;
    }
    case "form":
      if (!r.schema || typeof r.schema !== "object" || !r.schema.properties || typeof r.schema.properties !== "object")
        errors.push("form needs a schema with properties");
      break;
    case "auth":
      if (!r.auth || typeof r.auth.service !== "string" || !r.auth.service) errors.push("auth needs auth.service");
      break;
    default:
      break;
  }
  // The whole request is persisted with the interaction: schema defaults and extra fields included.
  if (!isJson(withoutUndefined(request))) errors.push("request must be JSON-safe");
  if (r.meta !== undefined && !isJson(r.meta)) errors.push("meta must be JSON-safe");
  const subject = r.subject as { detail?: unknown } | undefined;
  if (subject?.detail !== undefined && !isJson(subject.detail)) errors.push("subject.detail must be JSON-safe");
  for (const o of (r.options ?? []) as readonly { meta?: unknown }[]) {
    if (o && (o as { meta?: unknown }).meta !== undefined && !isJson((o as { meta?: unknown }).meta))
      errors.push("option meta must be JSON-safe");
  }
  for (const q of (r.questions ?? []) as readonly { options?: readonly { meta?: unknown }[] }[]) {
    for (const o of q?.options ?? []) if (o?.meta !== undefined && !isJson(o.meta)) errors.push("option meta must be JSON-safe");
  }

  if (errors.length) return { ok: false, errors };

  const interaction = {
    ...(request as object),
    ...(r.kind === "confirm" && r.options === undefined ? { options: DEFAULT_CONFIRM_OPTIONS } : {}),
    id: assigned.id,
    replyCode: assigned.replyCode ?? replyCodeFor(assigned.id, assigned.seq ?? 0),
    ...(assigned.expiresAt ?? r.expiresAt ? { expiresAt: assigned.expiresAt ?? (r.expiresAt as string) } : {}),
  } as unknown as CoreInteraction;
  return { ok: true, interaction };
}

// ─── Redaction ──────────────────────────────────────────────────────────────

/**
 * Drop the answers of `secret` questions from a result before it is stored.
 * Returns the result without those fields and the list of removed paths
 * (`answers.<questionId>.text`, `.freeText`), which is what
 * `PendingInteraction.result.redacted` records. Option ids are kept: choosing an
 * option of a secret question is not the secret.
 */
export function redactSecretAnswers<R extends CoreInteractionResult>(
  interaction: CoreInteraction | { readonly questions?: readonly Question[] },
  result: R,
): { result: R; redacted: string[] } {
  if (result.outcome !== "answered") return { result, redacted: [] };
  const redacted: string[] = [];
  const answers: Record<string, { optionIds?: readonly string[]; text?: string; freeText?: string }> = {};
  for (const [qid, a] of Object.entries(result.answers)) {
    const secret = (interaction as { readonly questions?: readonly Question[] }).questions?.find((q) => q.id === qid)?.secret === true;
    if (!secret) {
      answers[qid] = a;
      continue;
    }
    const { text, freeText, ...rest } = a;
    if (text !== undefined) redacted.push(`answers.${qid}.text`);
    if (freeText !== undefined) redacted.push(`answers.${qid}.freeText`);
    answers[qid] = rest;
  }
  return { result: { ...result, answers }, redacted };
}
