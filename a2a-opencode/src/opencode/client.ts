/**
 * OpenCode Client Wrapper
 *
 * Wraps @opencode-ai/sdk/v2 with a simplified, directory-aware API.
 * Every method auto-injects the configured defaultDirectory.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpencodeClient as SdkClient } from "@opencode-ai/sdk/v2";
import type {
  Session,
  SessionStatus,
  PermissionRuleset,
  PermissionRequest,
  QuestionRequest,
  MessageWithParts,
  PathInfo,
  PermissionReplyValue,
  OpenCodeEvent,
} from "./types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("client");

// ─── Error ──────────────────────────────────────────────────────────────────

export class OpenCodeApiError extends Error {
  readonly statusCode: number;
  readonly errorData: unknown;
  constructor(message: string, statusCode: number, errorData?: unknown) {
    super(message);
    this.name = "OpenCodeApiError";
    this.statusCode = statusCode;
    this.errorData = errorData;
  }
}

// ─── Event Stream Handle ────────────────────────────────────────────────────

export interface EventStreamHandle {
  readonly stream: AsyncGenerator<unknown>;
  abort(): void;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface ClientConfig {
  baseUrl: string;
  defaultDirectory?: string;
  timeout?: number;
  healthCheckInterval?: number;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class OpenCodeClientWrapper {
  private readonly sdk: SdkClient;
  private readonly cfg: Required<ClientConfig>;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ClientConfig) {
    this.cfg = {
      baseUrl: config.baseUrl,
      defaultDirectory: config.defaultDirectory ?? "",
      timeout: config.timeout ?? 30_000,
      healthCheckInterval: config.healthCheckInterval ?? 30_000,
    };
    this.sdk = createOpencodeClient({
      baseUrl: this.cfg.baseUrl as `${string}://${string}`,
      ...(this.cfg.defaultDirectory ? { directory: this.cfg.defaultDirectory } : {}),
    });
    log.info("Client created", { baseUrl: this.cfg.baseUrl, directory: this.cfg.defaultDirectory || "(default)" });
  }

  get raw(): SdkClient { return this.sdk; }

  private dir(d?: string): string | undefined {
    return d || this.cfg.defaultDirectory || undefined;
  }

  private unwrap<T>(result: { data?: T; error?: unknown; response: Response }, label: string): T {
    if (result.error !== undefined && result.error !== null) {
      const status = result.response?.status ?? 0;
      log.error(`${label} failed`, { status, error: result.error });
      throw new OpenCodeApiError(`${label}: HTTP ${status}`, status, result.error);
    }
    return result.data as T;
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async health(): Promise<{ healthy: true; version: string }> {
    const r = await this.sdk.global.health();
    return this.unwrap(r, "health");
  }

  startHealthCheck(): void {
    if (this.cfg.healthCheckInterval <= 0 || this.healthTimer) return;
    this.healthTimer = setInterval(async () => {
      try { await this.health(); log.debug("Health OK"); }
      catch (e) { log.warn("Health check failed", { error: e instanceof Error ? e.message : String(e) }); }
    }, this.cfg.healthCheckInterval);
    if (this.healthTimer.unref) this.healthTimer.unref();
  }

  stopHealthCheck(): void {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
  }

  // ── Project ─────────────────────────────────────────────────────────────

  async projectList(directory?: string) {
    return this.unwrap(await this.sdk.project.list({ directory: this.dir(directory) }), "project.list");
  }

  async projectCurrent(directory?: string) {
    return this.unwrap(await this.sdk.project.current({ directory: this.dir(directory) }), "project.current");
  }

  // ── Session ─────────────────────────────────────────────────────────────

  async sessionList(directory?: string, opts?: { roots?: boolean; start?: number; search?: string; limit?: number }) {
    return this.unwrap(await this.sdk.session.list({ directory: this.dir(directory), ...opts }), "session.list");
  }

  async sessionCreate(directory?: string, opts?: { title?: string; parentID?: string; permission?: PermissionRuleset }): Promise<Session> {
    const r = await this.sdk.session.create({ directory: this.dir(directory), title: opts?.title, parentID: opts?.parentID, permission: opts?.permission });
    const s = this.unwrap(r, "session.create");
    log.info("Session created", { id: s.id, title: s.title });
    return s;
  }

  async sessionGet(sessionID: string, directory?: string): Promise<Session> {
    return this.unwrap(await this.sdk.session.get({ sessionID, directory: this.dir(directory) }), "session.get");
  }

  async sessionDelete(sessionID: string, directory?: string): Promise<boolean> {
    return this.unwrap(await this.sdk.session.delete({ sessionID, directory: this.dir(directory) }), "session.delete");
  }

  async sessionStatus(directory?: string): Promise<Record<string, SessionStatus>> {
    return this.unwrap(await this.sdk.session.status({ directory: this.dir(directory) }), "session.status");
  }

  async sessionAbort(sessionID: string, directory?: string): Promise<boolean> {
    const ok = this.unwrap(await this.sdk.session.abort({ sessionID, directory: this.dir(directory) }), "session.abort");
    log.info("Session aborted", { sessionID });
    return ok;
  }

  // ── Messaging ───────────────────────────────────────────────────────────

  async sessionMessages(sessionID: string, directory?: string, limit?: number): Promise<MessageWithParts[]> {
    return this.unwrap(await this.sdk.session.messages({ sessionID, directory: this.dir(directory), limit }), "session.messages") as MessageWithParts[];
  }

  async sessionMessage(sessionID: string, messageID: string, directory?: string): Promise<MessageWithParts> {
    return this.unwrap(await this.sdk.session.message({ sessionID, messageID, directory: this.dir(directory) }), "session.message") as MessageWithParts;
  }

  async sessionPromptAsync(
    sessionID: string,
    body: {
      parts: Array<
        | { type: "text"; text: string; id?: string }
        | { type: "file"; mime: string; url: string; id?: string; filename?: string }
        | { type: "agent"; name: string; id?: string }
        | { type: "subtask"; prompt: string; description: string; agent: string; id?: string }
      >;
      model?: { providerID: string; modelID: string };
      agent?: string;
      system?: string;
    },
    directory?: string,
  ): Promise<void> {
    this.unwrap(await this.sdk.session.promptAsync({ sessionID, directory: this.dir(directory), ...body }), "session.promptAsync");
    log.debug("Prompt sent", { sessionID });
  }

  // ── Permissions ─────────────────────────────────────────────────────────

  async permissionList(directory?: string): Promise<PermissionRequest[]> {
    return this.unwrap(await this.sdk.permission.list({ directory: this.dir(directory) }), "permission.list") as PermissionRequest[];
  }

  async permissionReply(requestID: string, reply: PermissionReplyValue, directory?: string, message?: string): Promise<void> {
    this.unwrap(await this.sdk.permission.reply({ requestID, directory: this.dir(directory), reply, message }), "permission.reply");
    log.info("Permission replied", { requestID, reply });
  }

  // ── Questions ───────────────────────────────────────────────────────────

  async questionList(directory?: string): Promise<QuestionRequest[]> {
    return this.unwrap(await this.sdk.question.list({ directory: this.dir(directory) }), "question.list") as QuestionRequest[];
  }

  async questionReply(requestID: string, answers: string[][], directory?: string): Promise<void> {
    this.unwrap(await this.sdk.question.reply({ requestID, directory: this.dir(directory), answers }), "question.reply");
    log.info("Question replied", { requestID });
  }

  async questionReject(requestID: string, directory?: string): Promise<void> {
    this.unwrap(await this.sdk.question.reject({ requestID, directory: this.dir(directory) }), "question.reject");
    log.info("Question rejected", { requestID });
  }

  // ── Events (SSE) ───────────────────────────────────────────────────────

  async subscribeEvents(directory?: string): Promise<EventStreamHandle> {
    const abortController = new AbortController();
    const r = await this.sdk.event.subscribe({ directory: this.dir(directory) });
    log.info("SSE connected");
    return {
      stream: r.stream as AsyncGenerator<unknown>,
      abort() { abortController.abort(); },
    };
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  async agentList(directory?: string) {
    return this.unwrap(await this.sdk.app.agents({ directory: this.dir(directory) }), "app.agents");
  }

  // ── Path ────────────────────────────────────────────────────────────────

  async pathGet(directory?: string): Promise<PathInfo> {
    return this.unwrap(await this.sdk.path.get({ directory: this.dir(directory) }), "path.get") as PathInfo;
  }

  // ── MCP ─────────────────────────────────────────────────────────────────

  async mcpStatus(directory?: string) {
    const dir = this.dir(directory);
    log.debug("mcp.status request", { directory: dir });
    const r = await this.sdk.mcp.status({ directory: dir });
    const data = this.unwrap(r, "mcp.status");
    log.debug("mcp.status response", { data: JSON.stringify(data) });
    return data;
  }

  async mcpAdd(name: string, config: Record<string, unknown>, directory?: string) {
    const dir = this.dir(directory);
    const payload = { directory: dir, name, config };
    log.info("mcp.add request", { name, directory: dir, config: JSON.stringify(config) });
    const r = await this.sdk.mcp.add({ directory: dir, name, config: config as any });
    log.info("mcp.add response", { name, status: r.response?.status, data: JSON.stringify(r.data), error: r.error ? JSON.stringify(r.error) : undefined });
    return this.unwrap(r, "mcp.add");
  }

  async mcpConnect(name: string, directory?: string) {
    const dir = this.dir(directory);
    log.info("mcp.connect request", { name, directory: dir });
    const r = await this.sdk.mcp.connect({ name, directory: dir });
    log.info("mcp.connect response", { name, status: r.response?.status, data: JSON.stringify(r.data), error: r.error ? JSON.stringify(r.error) : undefined });
    return this.unwrap(r, "mcp.connect");
  }

  async mcpDisconnect(name: string, directory?: string) {
    const dir = this.dir(directory);
    log.info("mcp.disconnect request", { name, directory: dir });
    const r = await this.sdk.mcp.disconnect({ name, directory: dir });
    log.info("mcp.disconnect response", { name, status: r.response?.status });
    return this.unwrap(r, "mcp.disconnect");
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async dispose(directory?: string): Promise<void> {
    this.stopHealthCheck();
    try { await this.sdk.instance.dispose({ directory: this.dir(directory) }); log.info("Disposed"); }
    catch (e) { log.warn("Dispose failed", { error: e instanceof Error ? e.message : String(e) }); }
  }

  cleanup(): void {
    this.stopHealthCheck();
    log.info("Client cleaned up");
  }
}
