/**
 * Claude permission requests and questions as core interactions, and core's answers back as Claude's answers.
 *
 * The SDK asks through ONE callback, `canUseTool(toolName, input, options)`, for two different things: a tool call that needs
 * permission, and the built-in `AskUserQuestion` tool (a question with up to four choices). Both become a core interaction
 * (`permission` / `question`), and the result is mapped back:
 *
 * - permission: only an explicit `selected` outcome on the `allow` option approves (design decision D5); the model sees a
 *   deny `message` (the caller's feedback when it gave one) and goes on. `interrupt` is set only when the task was canceled.
 * - question: the answers go back as `updatedInput.answers`, keyed by the question text, as the SDK requires (the original
 *   `questions` must be sent back too). Several picked options are joined with ", "; free text wins over options.
 *
 * "Always allow" is not offered: it would make the SDK write permission rules into the project's settings files, which is
 * configuration, not an answer to one request.
 */

import type {
  CoreInteractionRequest,
  CoreInteractionResult,
  InteractionOption,
  InteractionSubject,
  JsonObject,
  Question,
} from "@a2a-wrapper/core";
import type { CanUseToolOptionsLike, PermissionResultLike } from "./client-factory.js";

const ALLOW_ONCE: InteractionOption = { id: "allow", label: "Allow", kind: "allow_once", scope: "call" };
const REJECT_ONCE: InteractionOption = { id: "reject", label: "Deny", kind: "reject_once", allowsFeedback: true };

/** What the model is told when a request could not be put to a person. Fixed: core's own reason text is internal. */
export const UNAVAILABLE_MESSAGE = "The permission request could not be put to a person, so it was denied.";
export const DENIED_MESSAGE = "The user denied this request.";
export const TIMED_OUT_MESSAGE = "Nobody answered this request in time, so it was denied.";
export const NOT_ANSWERED_MESSAGE = "The user did not answer the question.";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const FETCH_TOOLS = new Set(["WebFetch", "WebSearch"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Strip `undefined` so the detail stays JSON-safe. */
function json(o: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(o)) as JsonObject;
}

function subjectOf(toolName: string, input: Record<string, unknown>, opts: CanUseToolOptionsLike): InteractionSubject {
  const resources = [str(input.file_path), str(input.notebook_path), str(input.path), str(input.url), str(opts.blockedPath)].filter(
    (r): r is string => r !== undefined,
  );
  const detail = json({ toolUseID: opts.toolUseID, agentID: opts.agentID, decisionReason: opts.decisionReason });
  const base = { tool: toolName, ...(resources.length > 0 ? { resources: [...new Set(resources)] } : {}), detail };
  if (toolName === "Bash") {
    const command = str(input.command);
    return { ...base, action: "execute", ...(command ? { command } : {}), risk: "high" };
  }
  if (EDIT_TOOLS.has(toolName)) return { ...base, action: "edit", risk: "high" };
  if (READ_TOOLS.has(toolName)) return { ...base, action: "read", risk: "low" };
  if (FETCH_TOOLS.has(toolName)) return { ...base, action: "fetch", risk: "medium" };
  if (toolName.startsWith("mcp__")) return { ...base, action: "mcp", risk: "medium" };
  return { ...base, risk: "medium" };
}

/** A tool call that needs permission, as a core `permission` interaction: allow once, or deny (with optional feedback). */
export function permissionInteraction(
  toolName: string,
  input: Record<string, unknown>,
  opts: CanUseToolOptionsLike,
): CoreInteractionRequest {
  const plan = toolName === "ExitPlanMode" ? str(input.plan) : undefined;
  const description = plan ?? str(opts.description) ?? str(opts.decisionReason);
  return {
    kind: "permission",
    title: str(opts.title) ?? `Use ${str(opts.displayName) ?? toolName}`,
    ...(description ? { description: description.slice(0, 4000) } : {}),
    subject: subjectOf(toolName, input, opts),
    options: [ALLOW_ONCE, REJECT_ONCE],
  } as CoreInteractionRequest;
}

/** The SDK's answer to core's answer for a permission request. */
export function permissionResult(
  result: CoreInteractionResult,
  input: Record<string, unknown>,
): PermissionResultLike {
  switch (result.outcome) {
    case "selected":
      if (result.optionId === ALLOW_ONCE.id) return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: result.feedback ? result.feedback : DENIED_MESSAGE };
    case "declined":
      return { behavior: "deny", message: result.feedback ? result.feedback : DENIED_MESSAGE };
    case "expired":
      return { behavior: "deny", message: TIMED_OUT_MESSAGE };
    case "canceled":
      return { behavior: "deny", message: "The task was canceled.", interrupt: true };
    case "withdrawn":
      return { behavior: "deny", message: "The request was withdrawn." };
    case "unavailable":
    default:
      return { behavior: "deny", message: UNAVAILABLE_MESSAGE };
  }
}

/** Does this `unavailable` say nobody is asked (the policy is `auto` and no rule answered)? */
export function nobodyWasAsked(result: CoreInteractionResult): boolean {
  return result.outcome === "unavailable" && (result.code === "policy-auto" || result.code === "interactions-disabled");
}

// ─── AskUserQuestion ────────────────────────────────────────────────────────

interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** The questions of an `AskUserQuestion` input, or `undefined` when the input is not that shape. */
export function questionItems(input: Record<string, unknown>): AskUserQuestionItem[] | undefined {
  const q = input.questions;
  if (!Array.isArray(q) || q.length === 0) return undefined;
  const items: AskUserQuestionItem[] = [];
  for (const raw of q) {
    if (typeof raw !== "object" || raw === null || typeof (raw as { question?: unknown }).question !== "string") return undefined;
    items.push(raw as AskUserQuestionItem);
  }
  return items;
}

/** An `AskUserQuestion` call as a core `question` interaction (one core question per SDK question). */
export function questionInteraction(items: AskUserQuestionItem[]): CoreInteractionRequest {
  const questions: Question[] = items.map((item, i) => ({
    id: `q${i}`,
    ...(str(item.header) ? { header: item.header } : {}),
    prompt: item.question,
    ...(item.options && item.options.length > 0
      ? {
          options: item.options.map((o, j) => ({
            id: String(j),
            label: String(o.label),
            ...(str(o.description) ? { description: o.description } : {}),
          })),
        }
      : {}),
    ...(item.multiSelect === true ? { multi: true } : {}),
    allowFreeform: true,
  }));
  return {
    kind: "question",
    title: items.length === 1 ? items[0]!.question : "Claude has some questions",
    questions: questions as unknown as readonly [Question, ...Question[]],
  } as CoreInteractionRequest;
}

/**
 * The SDK answer for an `AskUserQuestion`: allow with the answers by question text, or deny when nobody answered. A question
 * the caller left unanswered while answering others is sent back empty.
 */
export function questionResult(
  result: CoreInteractionResult,
  input: Record<string, unknown>,
  items: AskUserQuestionItem[],
): PermissionResultLike {
  if (result.outcome !== "answered") {
    return result.outcome === "canceled"
      ? { behavior: "deny", message: "The task was canceled.", interrupt: true }
      : { behavior: "deny", message: NOT_ANSWERED_MESSAGE };
  }
  const answers: Record<string, string> = {};
  items.forEach((item, i) => {
    const a = result.answers[`q${i}`];
    const free = a?.freeText ?? a?.text;
    if (free !== undefined && free !== "") {
      answers[item.question] = free;
      return;
    }
    const labels = (a?.optionIds ?? [])
      .map((id) => item.options?.[Number(id)]?.label)
      .filter((l): l is string => typeof l === "string");
    answers[item.question] = labels.join(", ");
  });
  return { behavior: "allow", updatedInput: { ...input, questions: input.questions, answers } };
}
