/**
 * OpenCode permission requests and questions as core interactions, and core's answers back as OpenCode's replies.
 *
 * - `permission.asked` (1.x `permission`/`patterns`, 2.x `action`/`resources`, canonicalized by the client) becomes a core
 *   `permission` interaction with three options: allow once, always allow (OpenCode saves the proposed patterns as project rules)
 *   and deny (with optional feedback for the model). Only an explicit `selected` outcome on an allow option approves (decision D5).
 * - `question.asked` (the question tool; 2.x forms, canonicalized by the client) becomes a core `question` interaction, one core
 *   question per OpenCode question, and the answers go back as `string[][]` (one array of labels or typed text per question).
 *
 * What happens when NOBODY is asked (the interaction policy is `auto` and no rule answered) is the wrapper's own, unchanged
 * behaviour: `features.autoApprovePermissions` replies `always` (or rejects) and `features.autoAnswerQuestions` picks the first
 * option of each question (or rejects). That is {@link legacyPermissionReply} / {@link legacyQuestionAnswers}.
 */

import type {
  CoreInteractionRequest,
  CoreInteractionResult,
  InteractionOption,
  InteractionSubject,
  JsonObject,
  Question,
} from "@a2a-wrapper/core";
import type { PermissionReplyValue, PermissionRequest, QuestionRequest } from "./types.js";

export const ONCE: InteractionOption = { id: "once", label: "Allow once", kind: "allow_once", scope: "call" };
export const ALWAYS: InteractionOption = { id: "always", label: "Always allow", kind: "allow_always", scope: "project" };
export const REJECT: InteractionOption = { id: "reject", label: "Deny", kind: "reject_once", allowsFeedback: true };

/** What the model is told when a request could not be put to a person. Fixed: core's own reason text is internal. */
export const UNAVAILABLE_MESSAGE = "The permission request could not be put to a person, so it was denied.";
export const DENIED_MESSAGE = "The user denied this request.";
export const TIMED_OUT_MESSAGE = "Nobody answered this request in time, so it was denied.";
export const CANCELED_MESSAGE = "The task was canceled.";
export const WITHDRAWN_MESSAGE = "The request was withdrawn.";

const READ_TOOLS = new Set(["read", "glob", "grep", "list", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
const SHELL_TOOLS = new Set(["bash", "shell"]);
const FETCH_TOOLS = new Set(["webfetch", "websearch", "fetch"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Strip `undefined` so the detail stays JSON-safe. */
function json(o: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(o)) as JsonObject;
}

function subjectOf(req: PermissionRequest): InteractionSubject {
  const name = String(req.permission ?? "");
  const patterns = (Array.isArray(req.patterns) ? req.patterns : []).filter((p): p is string => typeof p === "string");
  const meta = (req.metadata ?? {}) as Record<string, unknown>;
  const detail = json({ always: Array.isArray(req.always) ? req.always : undefined, requestId: req.id });
  const base = { tool: name, ...(patterns.length > 0 ? { resources: patterns } : {}), detail };
  if (SHELL_TOOLS.has(name)) {
    const command = str(meta["command"]) ?? (patterns.length === 1 ? patterns[0] : undefined);
    return { ...base, action: "execute", ...(command ? { command } : {}), risk: "high" };
  }
  if (EDIT_TOOLS.has(name)) return { ...base, action: "edit", risk: "high" };
  if (READ_TOOLS.has(name)) return { ...base, action: "read", risk: "low" };
  if (FETCH_TOOLS.has(name)) return { ...base, action: "fetch", risk: "medium" };
  if (name === "mcp" || name === "execute") return { ...base, action: "mcp", risk: "medium" };
  return { ...base, risk: "medium" };
}

/** A permission request as a core `permission` interaction. */
export function permissionInteraction(req: PermissionRequest): CoreInteractionRequest {
  const name = String(req.permission ?? "a tool");
  const always = (Array.isArray(req.always) ? req.always : []).filter((p): p is string => typeof p === "string");
  const resources = (Array.isArray(req.patterns) ? req.patterns : []).filter((p): p is string => typeof p === "string");
  const message = str((req as unknown as { message?: unknown }).message);
  const lines = [
    ...(message ? [message] : []),
    ...(resources.length > 0 ? [`Resources: ${resources.join(", ")}`] : []),
    ...(always.length > 0 ? [`"Always allow" saves these as project rules: ${always.join(", ")}`] : []),
    "Denying rejects every other pending permission request of this session too.",
  ];
  return {
    kind: "permission",
    title: `Allow ${name}?`,
    description: lines.join("\n").slice(0, 4000),
    subject: subjectOf(req),
    options: [ONCE, ALWAYS, REJECT],
  } as CoreInteractionRequest;
}

/** The server reply for core's answer to a permission interaction. */
export function permissionReply(result: CoreInteractionResult): { reply: PermissionReplyValue; message?: string } {
  switch (result.outcome) {
    case "selected":
      if (result.optionId === ONCE.id) return { reply: "once" };
      if (result.optionId === ALWAYS.id) return { reply: "always" };
      return { reply: "reject", message: result.feedback ? result.feedback : DENIED_MESSAGE };
    case "declined":
      return { reply: "reject", message: result.feedback ? result.feedback : DENIED_MESSAGE };
    case "expired":
      return { reply: "reject", message: TIMED_OUT_MESSAGE };
    case "canceled":
      return { reply: "reject", message: CANCELED_MESSAGE };
    case "withdrawn":
      return { reply: "reject", message: WITHDRAWN_MESSAGE };
    case "unavailable":
    default:
      return { reply: "reject", message: UNAVAILABLE_MESSAGE };
  }
}

/** Does this `unavailable` say nobody is asked (the policy is `auto` and no rule answered)? */
export function nobodyWasAsked(result: CoreInteractionResult): boolean {
  return result.outcome === "unavailable" && (result.code === "policy-auto" || result.code === "interactions-disabled");
}

/** What the wrapper has always replied when nobody is asked: `always` (a saved project rule) when auto-approving, else `reject`. */
export function legacyPermissionReply(autoApprove: boolean): PermissionReplyValue {
  return autoApprove ? "always" : "reject";
}

// ─── Questions ──────────────────────────────────────────────────────────────

/** A question request as a core `question` interaction (one core question per OpenCode question). */
export function questionInteraction(req: QuestionRequest): CoreInteractionRequest {
  const items = req.questions ?? [];
  const questions: Question[] = items.map((item, i) => ({
    id: `q${i}`,
    ...(str(item.header) ? { header: item.header } : {}),
    prompt: String(item.question ?? ""),
    ...(item.options && item.options.length > 0
      ? {
          options: item.options.map((o, j) => ({
            id: String(j),
            label: String(o.label),
            ...(str(o.description) ? { description: o.description } : {}),
          })),
        }
      : {}),
    ...(item.multiple === true ? { multi: true } : {}),
    allowFreeform: item.custom !== false,
  }));
  return {
    kind: "question",
    title: items.length === 1 ? String(items[0]!.question ?? "OpenCode has a question") : "OpenCode has some questions",
    questions: questions as unknown as readonly [Question, ...Question[]],
  } as CoreInteractionRequest;
}

/** The answers for an OpenCode question reply, or `undefined` when nobody answered (the question is rejected). */
export function questionAnswers(result: CoreInteractionResult, req: QuestionRequest): string[][] | undefined {
  if (result.outcome !== "answered") return undefined;
  return (req.questions ?? []).map((item, i) => {
    const a = result.answers[`q${i}`];
    const free = a?.freeText ?? a?.text;
    if (free !== undefined && free !== "") return [free];
    return (a?.optionIds ?? [])
      .map((id) => item.options?.[Number(id)]?.label)
      .filter((l): l is string => typeof l === "string");
  });
}

/** What the wrapper has always answered when nobody is asked: the first option of every question (or an empty answer). */
export function legacyQuestionAnswers(req: QuestionRequest): string[][] {
  return (req.questions ?? []).map((q) => (q.options && q.options.length > 0 ? [q.options[0]!.label] : [""]));
}
