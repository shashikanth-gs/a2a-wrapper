/**
 * The wrapper's own answers to permission requests and questions when nobody is asked: the headless default this wrapper has
 * always had, used where there is no running task to ask through (the context build).
 *
 * `features.autoApprovePermissions` replies `always` (a saved project rule) or rejects; `features.autoAnswerQuestions` picks the
 * first option of every question or rejects. A task's own turn goes through `run.ask` first (see `turn.ts`).
 */

import type { OpenCodeBackend } from "./backend.js";
import type { EventStreamManager } from "./event-stream.js";
import { legacyPermissionReply, legacyQuestionAnswers } from "./interactions.js";
import type { OpenCodeEvent, PermissionRequest, QuestionRequest } from "./types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("auto-replies");

export interface AutoReplyConfig {
  autoApprove: boolean;
  autoAnswer: boolean;
}

/** Answer one permission request. */
export async function autoReplyPermission(backend: OpenCodeBackend, req: PermissionRequest, cfg: AutoReplyConfig, directory?: string): Promise<void> {
  const reply = legacyPermissionReply(cfg.autoApprove);
  log.info("Handling permission", { id: req.id, permission: req.permission, reply });
  await backend.permissionReply(req.id, reply, directory);
}

/** Answer one question. */
export async function autoReplyQuestion(backend: OpenCodeBackend, req: QuestionRequest, cfg: AutoReplyConfig, directory?: string): Promise<void> {
  log.info("Handling question", { id: req.id, count: req.questions?.length ?? 0 });
  if (!cfg.autoAnswer) {
    await backend.questionReject(req.id, directory);
    return;
  }
  await backend.questionReply(req.id, legacyQuestionAnswers(req), directory);
}

/** Wire the replies into an event stream. */
export function attachAutoReplies(stream: EventStreamManager, backend: OpenCodeBackend, cfg: AutoReplyConfig, directory?: string): void {
  const handled = new Set<string>();
  stream.on("permission.asked", (event: OpenCodeEvent) => {
    const req = (event as Record<string, unknown>).properties as PermissionRequest;
    if (!req?.id || handled.has(req.id)) return;
    handled.add(req.id);
    autoReplyPermission(backend, req, cfg, directory).catch((e) => {
      handled.delete(req.id);
      log.error("Permission handling failed", { id: req.id, error: (e as Error).message });
    });
  });
  stream.on("question.asked", (event: OpenCodeEvent) => {
    const req = (event as Record<string, unknown>).properties as QuestionRequest;
    if (!req?.id || handled.has(req.id)) return;
    handled.add(req.id);
    autoReplyQuestion(backend, req, cfg, directory).catch((e) => {
      handled.delete(req.id);
      log.error("Question handling failed", { id: req.id, error: (e as Error).message });
    });
  });
}

/** Safety net: answer what is pending on the server for one session (the stream may have missed it while reconnecting). */
export async function autoReplyPending(backend: OpenCodeBackend, directory: string | undefined, sessionId: string, cfg: AutoReplyConfig): Promise<void> {
  try {
    const [perms, qs] = await Promise.all([backend.permissionList(directory), backend.questionList(directory)]);
    for (const p of perms) if (p.sessionID === sessionId) await autoReplyPermission(backend, p, cfg, directory);
    for (const q of qs) if (q.sessionID === sessionId) await autoReplyQuestion(backend, q, cfg, directory);
  } catch (e) {
    log.warn("Pending poll failed", { error: (e as Error).message });
  }
}
