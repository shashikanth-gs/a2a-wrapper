/**
 * @module model/interaction
 *
 * Interactions: a provider asks the caller something (permission, question,
 * form, auth challenge, confirmation) in core's vocabulary and gets a
 * {@link CoreInteractionResult} back. Results are produced by core only.
 *
 * @see docs/design/core-data-model.md section 3.3
 */

import type { CoreCaller, Meta, Open } from "./primitives.js";

export interface InteractionSubject {
  tool?: string;
  action?: string;
  command?: string;
  /** Paths, URLs, patterns. */
  resources?: string[];
  risk?: Open<"low" | "medium" | "high">;
  detail?: Meta;
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

/** One entry of a `question` interaction. */
export interface Question {
  id: string;
  header?: string;
  prompt: string;
  options?: { id: string; label: string; description?: string }[];
  multi?: boolean;
  allowFreeform?: boolean;
  /** Never logged, persisted or traced in clear. */
  secret?: boolean;
}

/** Flat JSON Schema subset for forms (as MCP elicitation). */
export interface FlatSchema {
  type?: "object";
  properties: Record<
    string,
    {
      type?: Open<"string" | "number" | "integer" | "boolean">;
      title?: string;
      description?: string;
      enum?: unknown[];
      default?: unknown;
      [extra: string]: unknown;
    }
  >;
  required?: string[];
}

/** Out-of-band auth only. There are no credential forms. */
export interface AuthChallenge {
  service: string;
  url?: string;
  /** Device-code flows. */
  userCode?: string;
  instructions?: string;
}

export interface CoreInteraction {
  /** Core-assigned, stable; the idempotency key. */
  id: string;
  kind: Open<"permission" | "question" | "form" | "auth" | "confirm">;
  title: string;
  description?: string;
  subject?: InteractionSubject;
  /** permission, confirm */
  options?: InteractionOption[];
  /** question */
  questions?: Question[];
  /** form */
  schema?: FlatSchema;
  /** auth */
  auth?: AuthChallenge;
  /** ISO timestamp. Core fills it from policy when absent. */
  expiresAt?: string;
  meta?: Meta;
}

/** What a provider passes to `run.ask`: core adds `id` and (by policy) `expiresAt`. */
export type CoreInteractionRequest = Omit<CoreInteraction, "id" | "expiresAt"> & {
  expiresAt?: string;
};

/** Options for `run.ask`. */
export interface AskOptions {
  /**
   * Opaque provider data (a request id, ...). Its presence is the signal that
   * the interaction can be re-attached after a restart; absent means it cannot.
   */
  handle?: string;
}

/** Always produced by core, never by a provider. */
export type CoreInteractionResult =
  | { outcome: "selected"; optionId: string; feedback?: string; by: CoreCaller }
  | {
      outcome: "answered";
      answers: Record<string, { optionIds?: string[]; text?: string }>;
      by: CoreCaller;
    }
  | { outcome: "submitted"; values: Meta; by: CoreCaller }
  | { outcome: "declined"; feedback?: string; by: CoreCaller }
  | { outcome: "completed"; by?: CoreCaller }
  | { outcome: "canceled" }
  | { outcome: "expired" }
  | { outcome: "unavailable"; reason: string };

/** Option kinds that approve. Anything else, including unknown kinds, does not (D5). */
export const APPROVING_OPTION_KINDS: readonly string[] = Object.freeze(["allow_once", "allow_always"]);

/**
 * Does this result approve the interaction? Unknown never approves (D5): only
 * an explicit `selected` outcome whose option exists on the interaction and has
 * a known `allow_*` kind returns `true`. Unknown outcomes, unknown option kinds,
 * unknown option ids, expired, unavailable, canceled, declined and malformed
 * results all return `false`.
 */
export function isApproval(
  interaction: Pick<CoreInteraction, "options">,
  result: CoreInteractionResult | { outcome: string } | null | undefined,
): boolean {
  if (!result || typeof result !== "object") return false;
  if ((result as { outcome?: unknown }).outcome !== "selected") return false;
  const optionId = (result as { optionId?: unknown }).optionId;
  if (typeof optionId !== "string") return false;
  const option = interaction.options?.find((o) => o.id === optionId);
  if (!option) return false;
  return APPROVING_OPTION_KINDS.includes(option.kind);
}
