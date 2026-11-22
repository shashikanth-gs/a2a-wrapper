/**
 * Copilot permission requests and `ask_user` questions as core interactions, and core's answers back as Copilot results.
 *
 * Only an explicit `selected` outcome on an `allow_*` option approves (design decision D5); everything else, including
 * `unavailable`, `expired`, `declined` and a malformed answer, denies. The one exception is a deployment on the default
 * interaction policy (`interactions.mode: "auto"`), where core never asks anybody: `unavailable` then means "no rule
 * answered", and the wrapper keeps today's behaviour of approving (the headless default every deployment relies on).
 */

import type {
  CoreInteractionRequest,
  CoreInteractionResult,
  InteractionOption,
  InteractionSubject,
  JsonObject,
  Question,
} from "@a2a-wrapper/core";

/** A Copilot permission request, as the SDK hands it to `onPermissionRequest` (the fields this wrapper reads). */
export interface CopilotPermissionRequest {
  kind?: string;
  intention?: string;
  fullCommandText?: string;
  hasWriteFileRedirection?: boolean;
  fileName?: string;
  path?: string;
  url?: string;
  serverName?: string;
  serverDisplayName?: string;
  toolName?: string;
  toolTitle?: string;
  readOnly?: boolean;
  [extra: string]: unknown;
}

/** What the Copilot SDK accepts back from `onPermissionRequest`. */
export type CopilotPermissionResult =
  | { kind: "approve-once" }
  | { kind: "reject"; feedback?: string }
  | { kind: "user-not-available" };

const ALLOW_ONCE: InteractionOption = { id: "allow", label: "Allow", kind: "allow_once", scope: "call" };
const REJECT_ONCE: InteractionOption = { id: "reject", label: "Deny", kind: "reject_once", allowsFeedback: true };

function subjectOf(r: CopilotPermissionRequest): { subject: InteractionSubject; title: string } {
  const detail: JsonObject = { requestKind: String(r.kind ?? "unknown") };
  switch (r.kind) {
    case "shell":
      return {
        title: "Run a shell command",
        subject: {
          tool: "shell",
          action: "execute",
          ...(r.fullCommandText ? { command: r.fullCommandText } : {}),
          risk: "high",
          detail: { ...detail, writesFiles: r.hasWriteFileRedirection === true },
        },
      };
    case "write":
      return {
        title: "Write a file",
        subject: { tool: "write", action: "edit", ...(r.fileName ? { resources: [r.fileName] } : {}), risk: "high", detail },
      };
    case "read":
      return {
        title: "Read a file",
        subject: { tool: "read", action: "read", ...(r.path ? { resources: [r.path] } : {}), risk: "low", detail },
      };
    case "url":
      return {
        title: "Fetch a URL",
        subject: { tool: "fetch", action: "fetch", ...(r.url ? { resources: [r.url] } : {}), risk: "medium", detail },
      };
    case "mcp": {
      const server = r.serverDisplayName ?? r.serverName ?? "mcp";
      const tool = r.toolTitle ?? r.toolName ?? "tool";
      return {
        title: `Call ${server} / ${tool}`,
        subject: {
          tool: `${r.serverName ?? "mcp"}/${r.toolName ?? "tool"}`,
          action: "mcp",
          risk: r.readOnly === true ? "low" : "medium",
          detail,
        },
      };
    }
    default:
      return { title: `Permission requested (${String(r.kind ?? "unknown")})`, subject: { tool: String(r.kind ?? "unknown"), detail } };
  }
}

/** A Copilot permission request as a core `permission` interaction: allow once, or deny (with optional feedback). */
export function permissionInteraction(request: CopilotPermissionRequest): CoreInteractionRequest {
  const { title, subject } = subjectOf(request);
  return {
    kind: "permission",
    title,
    ...(request.intention ? { description: request.intention } : {}),
    subject,
    options: [ALLOW_ONCE, REJECT_ONCE],
  } as CoreInteractionRequest;
}

/**
 * The Copilot answer to core's answer.
 *
 * @param nobodyAsked `true` when the interaction policy is `auto`: `unavailable` then means no rule answered, and the
 *   headless default (approve) applies. Under `ask` it denies.
 */
export function permissionResult(result: CoreInteractionResult, nobodyAsked: boolean): CopilotPermissionResult {
  switch (result.outcome) {
    case "selected":
      if (result.optionId === ALLOW_ONCE.id) return { kind: "approve-once" };
      return { kind: "reject", ...(result.feedback ? { feedback: result.feedback } : {}) };
    case "unavailable":
      return nobodyAsked ? { kind: "approve-once" } : { kind: "reject", feedback: result.reason };
    case "declined":
      return { kind: "reject", ...(result.feedback ? { feedback: result.feedback } : {}) };
    case "canceled":
    case "expired":
    case "withdrawn":
      return { kind: "user-not-available" };
    default:
      return { kind: "reject" };
  }
}

/** What the Copilot SDK hands to `onUserInputRequest` (the `ask_user` tool). */
export interface CopilotUserInputRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}

/** A Copilot `ask_user` question as a core `question` interaction with one question. */
export function questionInteraction(request: CopilotUserInputRequest): CoreInteractionRequest {
  const question: Question = {
    id: "answer",
    prompt: request.question,
    ...(request.choices && request.choices.length > 0
      ? { options: request.choices.map((c, i) => ({ id: String(i), label: c })) }
      : {}),
    allowFreeform: request.allowFreeform !== false,
  };
  return { kind: "question", title: request.question, questions: [question] } as CoreInteractionRequest;
}

/** The `ask_user` answer, or `undefined` when nobody answered (the tool call then ends without one). */
export function questionAnswer(
  result: CoreInteractionResult,
  request: CopilotUserInputRequest,
): { answer: string; wasFreeform: boolean } | undefined {
  if (result.outcome !== "answered") return undefined;
  const a = result.answers["answer"];
  if (!a) return undefined;
  const free = a.freeText ?? a.text;
  if (free !== undefined && free !== "") return { answer: free, wasFreeform: true };
  const id = a.optionIds?.[0];
  const choice = id !== undefined ? request.choices?.[Number(id)] : undefined;
  return choice !== undefined ? { answer: choice, wasFreeform: false } : undefined;
}
