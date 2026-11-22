/**
 * @module runtime/interaction-policy
 *
 * Whether a person is asked, and for how long. "Auto-answer" means an interaction is
 * answered by policy instead of by a person. Today every wrapper does this silently
 * (Copilot approves everything, OpenCode replies `always`); core makes it explicit and keeps
 * today's behaviour as the default, so nothing changes until an operator opts in.
 *
 * - `mode: "auto"` (default): core asks nobody. A provider that still calls `run.ask` gets
 *   `{outcome: "unavailable"}` (a denial, D5) and nothing is published or stored. Providers keep
 *   their native permission configuration.
 * - `mode: "ask"`: an unmatched interaction goes to the A2A client (`input-required`, or
 *   `auth-required` for an auth interaction) and parks the run. `autoAnswer` rules are tried first,
 *   in order; the first match answers without a person.
 *
 * Expiry (ask mode): an unanswered interaction expires after `timeoutMs` (default 10 minutes;
 * 30 for `auth`, where a person signs in on another device). It then resolves `expired`
 * and, per `onTimeout`, the task fails (`"fail"`, default) or the provider just sees the
 * denial and goes on (`"deny"`).
 *
 * `by` of a policy answer is {@link POLICY_CALLER}. `authorize()` (the choke point of
 * decision 3) is for people replying; the policy is the operator's own configuration.
 *
 * @see docs/design/core-data-model.md section 3.9
 */

import {
  type CoreCaller,
  type CoreInteraction,
  type CoreInteractionResult,
  type InteractionOption,
} from "../model/index.js";

/** Who a policy answer is recorded as. */
export const POLICY_CALLER: Readonly<CoreCaller> = Object.freeze({ id: "policy", kind: "service" });

/** Default expiry of permission, confirm, question and form interactions. */
export const DEFAULT_INTERACTION_TIMEOUT_MS = 10 * 60_000;
/** Default expiry of an auth interaction. */
export const DEFAULT_AUTH_TIMEOUT_MS = 30 * 60_000;
/** The longest a timer is armed for (setTimeout overflows at 2^31 - 1 ms). */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** What an auto-answer rule matches. Every field given must match; an empty match matches everything. */
export interface AutoAnswerMatch {
  kind?: string | readonly string[];
  /** `subject.risk` */
  risk?: string | readonly string[];
  /** `subject.tool` */
  tool?: string | readonly string[];
  /** `subject.action` */
  action?: string | readonly string[];
}

/** What a matching rule answers: the first option of this `kind`, or the option with this id, or a decline. */
export type AutoAnswer =
  | { kind: string; optionId?: undefined; decline?: undefined }
  | { optionId: string; kind?: undefined; decline?: undefined }
  | { decline: true; kind?: undefined; optionId?: undefined };

export interface AutoAnswerRule {
  match: AutoAnswerMatch;
  answer: AutoAnswer;
}

export interface InteractionPolicy {
  mode: "auto" | "ask";
  /** Expiry of every kind but `auth`. Default 10 minutes. */
  timeoutMs?: number;
  /** Expiry of `auth`. Default 30 minutes. */
  authTimeoutMs?: number;
  /** What an expiry does to the task. Default `"fail"`. */
  onTimeout: "fail" | "deny";
  /** Ask mode only. First match wins. Only option-based interactions (permission, confirm) can be auto-answered. */
  autoAnswer: readonly AutoAnswerRule[];
}

export const DEFAULT_INTERACTION_POLICY: Readonly<InteractionPolicy> = Object.freeze({
  mode: "auto",
  onTimeout: "fail",
  autoAnswer: Object.freeze([]) as readonly AutoAnswerRule[],
});

/** Fill the defaults and validate. Throws `TypeError` on a malformed policy (a typo must not silently become "ask nobody"). */
export function resolveInteractionPolicy(input: Partial<InteractionPolicy> = {}): InteractionPolicy {
  const p: InteractionPolicy = { ...DEFAULT_INTERACTION_POLICY, ...input } as InteractionPolicy;
  if (p.mode !== "auto" && p.mode !== "ask") throw new TypeError(`interactions.mode must be "auto" or "ask", got ${String(p.mode)}`);
  if (p.onTimeout !== "fail" && p.onTimeout !== "deny")
    throw new TypeError(`interactions.onTimeout must be "fail" or "deny", got ${String(p.onTimeout)}`);
  for (const [name, v] of [["timeoutMs", p.timeoutMs], ["authTimeoutMs", p.authTimeoutMs]] as const) {
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0))
      throw new TypeError(`interactions.${name} must be a positive number`);
  }
  if (!Array.isArray(p.autoAnswer)) throw new TypeError("interactions.autoAnswer must be an array");
  for (const r of p.autoAnswer) {
    const a = r?.answer as Partial<Record<"kind" | "optionId" | "decline", unknown>> | undefined;
    const set = a ? ["kind", "optionId", "decline"].filter((k) => a[k as "kind"] !== undefined).length : 0;
    if (!r || typeof r.match !== "object" || r.match === null || set !== 1)
      throw new TypeError("every autoAnswer rule needs a `match` object and exactly one of answer.kind, answer.optionId, answer.decline");
  }
  return p;
}

/** Expiry of an interaction kind, in ms. */
export function timeoutFor(policy: InteractionPolicy, kind: string): number {
  return kind === "auth"
    ? (policy.authTimeoutMs ?? policy.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS)
    : (policy.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS);
}

const oneOf = (want: string | readonly string[] | undefined, got: string | undefined): boolean => {
  if (want === undefined) return true;
  if (got === undefined) return false;
  return typeof want === "string" ? want === got : want.includes(got);
};

/**
 * The policy's answer to `interaction`, or `undefined` when no rule answers it (it then goes to
 * a person). Never approves by guesswork: a rule that asks for a kind the interaction does not
 * offer does not match, and an unknown option kind is only selected when the rule names exactly
 * that kind.
 */
export function matchAutoAnswer(policy: InteractionPolicy, interaction: CoreInteraction): CoreInteractionResult | undefined {
  const i = interaction as { kind: string; options?: readonly InteractionOption[]; subject?: { risk?: string; tool?: string; action?: string } };
  for (const rule of policy.autoAnswer) {
    const m = rule.match;
    if (!oneOf(m.kind, i.kind) || !oneOf(m.risk, i.subject?.risk) || !oneOf(m.tool, i.subject?.tool) || !oneOf(m.action, i.subject?.action)) continue;
    if (rule.answer.decline) {
      if (i.kind === "permission" || i.kind === "confirm") {
        const reject = i.options?.find((o) => o.kind === "reject_once" && !o.interrupts) ?? i.options?.find((o) => o.kind === "reject_once");
        if (reject) return { outcome: "selected", optionId: reject.id, by: { ...POLICY_CALLER } };
      }
      return { outcome: "declined", by: { ...POLICY_CALLER } };
    }
    if (!i.options?.length) continue;
    const option =
      rule.answer.optionId !== undefined
        ? i.options.find((o) => o.id === rule.answer.optionId)
        : i.options.find((o) => o.kind === rule.answer.kind);
    if (!option) continue;
    return { outcome: "selected", optionId: option.id, by: { ...POLICY_CALLER } };
  }
  return undefined;
}
