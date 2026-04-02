/**
 * Permission & Question Handler
 *
 * Automatically responds to permission and question requests during
 * headless agent execution. Wires into EventStreamManager to catch
 * permission.asked / question.asked events.
 */

import type { OpenCodeClientWrapper } from "./client.js";
import type { EventStreamManager } from "./event-stream.js";
import type {
  PermissionRequest,
  QuestionRequest,
  PermissionReplyValue,
  OpenCodeEvent,
} from "./types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("permissions");

// ─── Config ─────────────────────────────────────────────────────────────────

export interface PermissionHandlerConfig {
  autoApproveAll?: boolean;
  autoApprovePermissions?: string[];
  defaultPermissionReply?: PermissionReplyValue;
  autoAnswerQuestions?: boolean;
  questionAnswerer?: (q: QuestionRequest) => string[][] | null;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export class PermissionHandler {
  private readonly client: OpenCodeClientWrapper;
  private readonly cfg: Required<Omit<PermissionHandlerConfig, "questionAnswerer">> & {
    questionAnswerer?: PermissionHandlerConfig["questionAnswerer"];
  };
  private handledPerms = new Set<string>();
  private handledQs = new Set<string>();

  constructor(client: OpenCodeClientWrapper, config?: PermissionHandlerConfig) {
    this.client = client;
    this.cfg = {
      autoApproveAll: config?.autoApproveAll ?? true,
      autoApprovePermissions: config?.autoApprovePermissions ?? [],
      defaultPermissionReply: config?.defaultPermissionReply ?? "always",
      autoAnswerQuestions: config?.autoAnswerQuestions ?? true,
      questionAnswerer: config?.questionAnswerer,
    };
    log.info("Created", {
      autoApproveAll: this.cfg.autoApproveAll,
      autoAnswer: this.cfg.autoAnswerQuestions,
    });
  }

  /** Wire into an EventStreamManager. */
  attachToStream(stream: EventStreamManager): void {
    stream.on("permission.asked", (event: OpenCodeEvent) => {
      const props = (event as Record<string, unknown>).properties as PermissionRequest;
      if (props?.id) this.handlePermission(props).catch((e) =>
        log.error("Permission handling failed", { id: props.id, error: (e as Error).message }),
      );
    });
    stream.on("question.asked", (event: OpenCodeEvent) => {
      const props = (event as Record<string, unknown>).properties as QuestionRequest;
      if (props?.id) this.handleQuestion(props).catch((e) =>
        log.error("Question handling failed", { id: props.id, error: (e as Error).message }),
      );
    });
    log.info("Attached to event stream");
  }

  // ── Permission ──────────────────────────────────────────────────────────

  async handlePermission(req: PermissionRequest): Promise<void> {
    if (this.handledPerms.has(req.id)) return;
    this.handledPerms.add(req.id);

    const shouldApprove =
      this.cfg.autoApproveAll ||
      this.cfg.autoApprovePermissions.includes(req.permission);
    const reply: PermissionReplyValue = shouldApprove ? this.cfg.defaultPermissionReply : "reject";

    log.info("Handling permission", {
      id: req.id, permission: req.permission, reply,
    });

    try {
      await this.client.permissionReply(req.id, reply);
    } catch (e) {
      this.handledPerms.delete(req.id);
      throw e;
    }
  }

  // ── Question ────────────────────────────────────────────────────────────

  async handleQuestion(req: QuestionRequest): Promise<void> {
    if (this.handledQs.has(req.id)) return;
    this.handledQs.add(req.id);

    log.info("Handling question", { id: req.id, count: req.questions.length });

    // Custom answerer
    if (this.cfg.questionAnswerer) {
      const custom = this.cfg.questionAnswerer(req);
      if (custom) {
        try { await this.client.questionReply(req.id, custom); return; }
        catch (e) { this.handledQs.delete(req.id); throw e; }
      }
    }

    if (!this.cfg.autoAnswerQuestions) {
      log.info("Auto-answer disabled, rejecting", { id: req.id });
      try { await this.client.questionReject(req.id); }
      catch (e) { this.handledQs.delete(req.id); throw e; }
      return;
    }

    // Auto: pick first option per question
    const answers: string[][] = req.questions.map((q) =>
      q.options.length > 0 ? [q.options[0].label] : [""],
    );

    log.info("Auto-answering", { id: req.id, answers });
    try { await this.client.questionReply(req.id, answers); }
    catch (e) { this.handledQs.delete(req.id); throw e; }
  }

  // ── Pending Poll ────────────────────────────────────────────────────────

  /** Poll and handle any pending permissions/questions (safety net). */
  async handlePending(directory?: string): Promise<void> {
    try {
      const [perms, qs] = await Promise.all([
        this.client.permissionList(directory),
        this.client.questionList(directory),
      ]);
      for (const p of perms) await this.handlePermission(p);
      for (const q of qs) await this.handleQuestion(q);
    } catch (e) {
      log.warn("Pending poll failed", { error: (e as Error).message });
    }
  }

  reset(): void {
    this.handledPerms.clear();
    this.handledQs.clear();
  }
}
