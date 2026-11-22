/**
 * OpenCode 2.x Client
 *
 * Implements {@link OpenCodeBackend} on top of `@opencode/client` (the OpenCode
 * 2.x `/api/*` surface). It translates between the 2.x protocol and the
 * canonical shapes the executor consumes (see backend.ts):
 *
 *  - `directory`  → `location: { directory }` (absolute path)
 *  - prompts      → durable inbox admission; completion is observed on `/api/event`
 *  - events       → `session.text.delta` etc. become `message.part.updated`,
 *                   `session.execution.*` become `session.idle` / `session.error`
 *  - permissions  → `{ permission, pattern, action }` ⇄ `{ action, resource, effect }`
 *  - questions    → 2.x forms
 *  - auth         → HTTP Basic (the server prints a password at startup)
 */

import "../utils/polyfills.js"; // Promise.withResolvers for Node 20 (needed by @opencode/client)
import { posix, resolve as resolvePath, win32 } from "node:path";
import { OpenCode } from "@opencode/client";

import type {
  Session,
  PermissionRequest,
  QuestionRequest,
  MessageWithParts,
  PermissionReplyValue,
} from "./types.js";
import {
  OpenCodeApiError,
  OpenCodeAuthError,
} from "./backend.js";
import type {
  InboxEntry,
  OpenCodeBackend,
  EventStreamHandle,
  McpStatusMap,
  PromptBody,
  PromptResult,
  SessionCreateOptions,
} from "./backend.js";
import { logger } from "../utils/logger.js";

const log = logger.child("client-v2");

// ─── Config ─────────────────────────────────────────────────────────────────

export interface ClientV2Config {
  baseUrl: string;
  defaultDirectory?: string;
  /** Basic-auth username (default "opencode"). */
  username?: string;
  /** Server password. Omit only for servers started without one. */
  password?: string;
  healthCheckInterval?: number;
}

/** Loose view of the pieces of an SDK response we read. */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface FormFieldLike {
  key: string;
  title?: string;
  type: string;
  default?: unknown;
  options?: Array<{ value: string; label: string; description?: string }>;
}

interface FormLike {
  id: string;
  sessionID: string;
  title?: string;
  fields: FormFieldLike[];
}

/**
 * 2.x requires an absolute directory. The OpenCode server may run on a different OS than
 * the wrapper (e.g. wrapper in a Linux container, server on a Windows host), so a path that
 * is absolute in either POSIX or Windows style is passed through untouched; only relative
 * paths are resolved (against the wrapper's working directory).
 */
export function toAbsoluteDirectory(dir: string): string {
  return posix.isAbsolute(dir) || win32.isAbsolute(dir) ? dir : resolvePath(dir);
}

// ─── Translation helpers (exported for tests) ───────────────────────────────

/** Canonical (1.x) permission ruleset → 2.x ruleset. */
export function toV2Permissions(
  rules: ReadonlyArray<{ permission: string; pattern: string; action: string }> | undefined,
): Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> | undefined {
  if (!rules || rules.length === 0) return undefined;
  return rules.flatMap((r) => {
    const rule = { action: r.permission, resource: r.pattern, effect: r.action as "allow" | "deny" | "ask" };
    // 1.x calls the shell tool "bash"; 2.x calls it "shell". Emit both so one ruleset works on either.
    return r.permission === "bash" ? [rule, { ...rule, action: "shell" }] : [rule];
  });
}

/** Canonical (1.x) MCP entry → 2.x MCP config. */
export function toV2McpConfig(config: Record<string, unknown>): Json {
  const c = config as Json;
  const timeout = typeof c.timeout === "number" ? { startup: c.timeout } : undefined;
  if (c.type === "remote") {
    return {
      type: "remote",
      url: c.url,
      ...(c.headers ? { headers: c.headers } : {}),
      ...(c.oauth !== undefined ? { oauth: c.oauth } : {}),
      ...(c.enabled === false ? { disabled: true } : {}),
      ...(timeout ? { timeout } : {}),
    };
  }
  return {
    type: "local",
    command: c.command,
    ...(c.environment ? { environment: c.environment } : {}),
    ...(c.enabled === false ? { disabled: true } : {}),
    ...(timeout ? { timeout } : {}),
  };
}

/** 2.x MCP status value → the snake_case strings the MCP manager understands. */
export function normalizeMcpStatus(raw: unknown): { status: string; error?: string } {
  const o = (raw ?? {}) as Json;
  const s = typeof raw === "string" ? raw : (o.type ?? o.status ?? o._tag ?? "unknown");
  const status = String(s)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
  const error = typeof o.error === "string" ? o.error : o.error?.message;
  return { status, ...(error ? { error } : {}) };
}

/** Flatten 2.x tool result content to text. */
function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: Json) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Build a 2.x form answer from canonical `string[][]` answers (one entry per field). */
export function buildFormAnswer(fields: FormFieldLike[], answers: string[][]): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  fields.forEach((f, i) => {
    const picked = (answers[i] ?? []).filter((a) => a !== "");
    const byLabel = (label: string) => f.options?.find((o) => o.label === label || o.value === label)?.value ?? label;
    switch (f.type) {
      case "multiselect":
        out[f.key] = picked.length ? picked.map(byLabel) : ((f.default as string[] | undefined) ?? []);
        break;
      case "boolean":
        out[f.key] = picked.length ? /^(true|yes|y|1)$/i.test(picked[0]) : ((f.default as boolean | undefined) ?? true);
        break;
      case "number":
      case "integer":
        out[f.key] = picked.length ? Number(picked[0]) : ((f.default as number | undefined) ?? 0);
        break;
      default:
        out[f.key] = picked.length ? byLabel(picked[0]) : ((f.default as string | undefined) ?? "");
    }
  });
  return out;
}

function toQuestionRequest(form: FormLike): QuestionRequest {
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: form.fields.map((f) => ({
      question: f.title ?? f.key,
      header: f.key,
      options: (f.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })),
      multiple: f.type === "multiselect",
    })),
  } as unknown as QuestionRequest;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class OpenCodeClientV2 implements OpenCodeBackend {
  readonly kind = "v2" as const;

  private readonly sdk: ReturnType<typeof OpenCode.make>;
  private readonly cfg: { baseUrl: string; defaultDirectory: string; healthCheckInterval: number; hasPassword: boolean };
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /** requestID → sessionID, needed because 2.x replies are session-scoped. */
  private permissionSessions = new Map<string, string>();
  private forms = new Map<string, FormLike>();

  constructor(config: ClientV2Config) {
    this.cfg = {
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      defaultDirectory: config.defaultDirectory ?? "",
      healthCheckInterval: config.healthCheckInterval ?? 30_000,
      hasPassword: !!config.password,
    };
    const headers: Record<string, string> = {};
    if (config.password) {
      const token = Buffer.from(`${config.username || "opencode"}:${config.password}`).toString("base64");
      headers["authorization"] = `Basic ${token}`;
    }
    this.sdk = OpenCode.make({ baseUrl: this.cfg.baseUrl, headers });
    log.info("Client created", {
      baseUrl: this.cfg.baseUrl,
      directory: this.cfg.defaultDirectory || "(default)",
      auth: this.cfg.hasPassword ? "basic" : "none",
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private loc(d?: string): { location: { directory: string } } | Record<string, never> {
    const dir = d || this.cfg.defaultDirectory;
    return dir ? { location: { directory: toAbsoluteDirectory(dir) } } : {};
  }

  /** Run an SDK call, mapping transport/auth failures to wrapper errors. */
  private async call<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const err = e as Json;
      const status: number = err?.status ?? err?.response?.status ?? err?.statusCode ?? 0;
      const msg = err instanceof Error ? err.message : String(e);
      if (
        err?._tag === "UnauthorizedError" ||
        status === 401 || status === 403 ||
        /\b(401|403)\b|unauthori[sz]ed|forbidden|authentication required/i.test(msg)
      ) {
        throw new OpenCodeAuthError(this.cfg.baseUrl, this.cfg.hasPassword);
      }
      if (e instanceof OpenCodeApiError) throw e;
      // A session the server does not know is a 404 for the provider (`session-not-found`), not an error to log.
      if (err?._tag === "SessionNotFoundError" || err?.name === "SessionNotFoundError") throw new OpenCodeApiError(`${label}: ${msg}`, 404, e);
      log.error(`${label} failed`, { status, error: msg });
      throw new OpenCodeApiError(`${label}: ${msg}`, status, e);
    }
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async health(): Promise<{ healthy: true; version: string }> {
    const info = (await this.call("server.info", () => this.sdk.server.info())) as Json;
    return { healthy: true, version: String(info.version ?? "unknown") };
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

  cleanup(): void {
    this.stopHealthCheck();
    log.info("Client cleaned up");
  }

  // ── Project / agents ────────────────────────────────────────────────────

  async projectCurrent(directory?: string): Promise<unknown> {
    const r = (await this.call("location.get", () => this.sdk.location.get(this.loc(directory)))) as Json;
    return { id: r.project?.id, directory: r.directory ?? r.project?.directory };
  }

  async agentList(directory?: string): Promise<unknown> {
    const r = (await this.call("agent.list", () => this.sdk.agent.list(this.loc(directory)))) as Json;
    return r.data ?? r;
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  async sessionCreate(directory?: string, opts?: SessionCreateOptions): Promise<Session> {
    const permissions = toV2Permissions(opts?.permission as never);
    const s = (await this.call("session.create", () =>
      this.sdk.session.create({
        ...(opts?.title ? { title: opts.title } : {}),
        ...(opts?.parentID ? { parentID: opts.parentID } : {}),
        ...(opts?.agent ? { agent: opts.agent } : {}),
        ...(opts?.model ? { model: { id: opts.model.modelID, providerID: opts.model.providerID } } : {}),
        ...(permissions ? { permissions } : {}),
        ...this.loc(directory),
      } as never),
    )) as Json;
    log.info("Session created", { id: s.id, title: s.title });
    return { id: s.id, title: s.title } as unknown as Session;
  }

  async sessionGet(sessionID: string, _directory?: string): Promise<Session> {
    const s = (await this.call("session.get", () => this.sdk.session.get({ sessionID }))) as Json;
    return { id: s.id, title: s.title } as unknown as Session;
  }

  /** `interrupt` with `resume: false`: the running work stops and nothing parked in the inbox starts. */
  async sessionAbort(sessionID: string, _directory?: string): Promise<boolean> {
    const r = (await this.call("session.interrupt", () => this.sdk.session.interrupt({ sessionID, resume: false }))) as Json;
    log.info("Session interrupted", { sessionID, interrupted: r?.interrupted });
    return true;
  }

  async sessionIdle(sessionID: string, _directory?: string): Promise<boolean> {
    const active = (await this.call("session.active", () => this.sdk.session.active())) as Json;
    const map = (active?.data ?? active) as Json;
    return !(map && Object.prototype.hasOwnProperty.call(map, sessionID));
  }

  // ── Messaging ───────────────────────────────────────────────────────────

  async sessionMessages(sessionID: string, _directory?: string, limit?: number): Promise<MessageWithParts[]> {
    const r = (await this.call("message.list", () =>
      this.sdk.message.list({ sessionID, ...(limit ? { limit } : {}) } as never),
    )) as Json;
    const items: Json[] = Array.isArray(r) ? r : (r.data ?? []);
    // 2.x lists newest first; the executor expects chronological order.
    const chronological = items.length > 1 && (items[0]?.time?.created ?? 0) > (items[items.length - 1]?.time?.created ?? 0)
      ? [...items].reverse()
      : items;
    return chronological.flatMap((m) => this.toMessageWithParts(m));
  }

  private toMessageWithParts(m: Json): MessageWithParts[] {
    if (m.type === "user") {
      const text = m.text ?? m.payload?.text ?? "";
      return [{
        info: { id: m.id, role: "user", time: m.time },
        parts: text ? [{ type: "text", text }] : [],
      } as unknown as MessageWithParts];
    }
    if (m.type !== "assistant") return [];
    const parts = (Array.isArray(m.content) ? m.content : []).flatMap((c: Json): Json[] => {
      if (c.type === "text") return [{ type: "text", text: c.text ?? "" }];
      if (c.type === "tool") {
        const st: Json = c.state ?? {};
        const raw = String(st.status ?? "");
        const status = raw === "completed" ? "completed" : raw === "error" || raw === "failed" ? "error" : "running";
        const errMsg = st.error?.message ?? (typeof st.error === "string" ? st.error : undefined);
        return [{
          type: "tool", tool: c.name ?? "unknown", callID: c.id,
          state: { status, input: st.input, output: toolContentText(st.content), ...(errMsg ? { error: errMsg } : {}) },
        }];
      }
      return [];
    });
    return [{
      info: { id: m.id, role: "assistant", time: { created: m.time?.created, completed: m.time?.completed } },
      parts,
    } as unknown as MessageWithParts];
  }

  async sessionPromptAsync(sessionID: string, body: PromptBody, _directory?: string): Promise<PromptResult> {
    const text: string[] = [];
    const files: Array<{ uri: string; name?: string }> = [];
    const agents: Array<{ name: string }> = [];
    for (const p of body.parts) {
      if (p.type === "text") text.push(p.text);
      else if (p.type === "file") files.push({ uri: p.url, ...(p.filename ? { name: p.filename } : {}) });
      else if (p.type === "agent") agents.push({ name: p.name });
      else if (p.type === "subtask") {
        log.warn("subtask parts are not supported on OpenCode 2.x; sending as text", { agent: p.agent });
        text.push(p.prompt);
      }
    }
    const item = (await this.call("session.prompt", () =>
      this.sdk.session.prompt({
        sessionID,
        text: text.join("\n"),
        ...(files.length ? { files } : {}),
        ...(agents.length ? { agents } : {}),
        ...(body.delivery ? { delivery: body.delivery } : {}),
      } as never),
    )) as Json;
    log.debug("Prompt admitted", { sessionID, inboxId: item?.id, delivery: item?.delivery });
    return {
      ...(typeof item?.id === "string" ? { inboxId: item.id } : {}),
      ...(item?.delivery === "steer" || item?.delivery === "queue" ? { delivery: item.delivery } : {}),
    };
  }

  // ── Durable inbox ───────────────────────────────────────────────────────

  async inboxList(sessionID: string, _directory?: string): Promise<InboxEntry[]> {
    const r = (await this.call("inbox.list", () => this.sdk.session.inbox.list({ sessionID }))) as Json;
    const items: Json[] = Array.isArray(r) ? r : (r.data ?? []);
    return items.map((i) => ({
      id: String(i.id),
      ...(typeof i.delivery === "string" ? { delivery: i.delivery } : {}),
      ...(typeof i.payload?.text === "string" ? { text: i.payload.text } : {}),
    }));
  }

  async inboxCancel(sessionID: string, inboxID: string, _directory?: string): Promise<void> {
    await this.call("inbox.cancel", () => this.sdk.session.inbox.cancel({ sessionID, inboxID }));
    log.info("Inbox item cancelled", { sessionID, inboxID });
  }

  // ── Permissions ─────────────────────────────────────────────────────────

  private toPermissionRequest(p: Json): PermissionRequest {
    this.permissionSessions.set(p.id, p.sessionID);
    return {
      id: p.id,
      sessionID: p.sessionID,
      permission: p.action,
      patterns: p.resources ?? [],
      metadata: p.metadata ?? {},
      always: p.save ?? [],
    } as unknown as PermissionRequest;
  }

  async permissionList(directory?: string): Promise<PermissionRequest[]> {
    const r = (await this.call("permission.list", () => this.sdk.permission.request.list(this.loc(directory)))) as Json;
    const items: Json[] = Array.isArray(r) ? r : (r.data ?? []);
    return items.map((p) => this.toPermissionRequest(p));
  }

  async permissionReply(requestID: string, reply: PermissionReplyValue, directory?: string, message?: string): Promise<void> {
    let sessionID = this.permissionSessions.get(requestID);
    if (!sessionID) {
      await this.permissionList(directory);
      sessionID = this.permissionSessions.get(requestID);
    }
    if (!sessionID) throw new OpenCodeApiError(`permission.reply: unknown request ${requestID}`, 404);
    await this.call("permission.reply", () =>
      this.sdk.permission.reply({ sessionID: sessionID!, requestID, decision: reply, ...(message ? { message } : {}) }),
    );
    this.permissionSessions.delete(requestID);
    log.info("Permission replied", { requestID, reply });
  }

  // ── Questions (2.x forms) ───────────────────────────────────────────────

  private rememberForm(f: Json): FormLike {
    const form: FormLike = { id: f.id, sessionID: f.sessionID, title: f.title, fields: (f.fields ?? []) as FormFieldLike[] };
    this.forms.set(form.id, form);
    return form;
  }

  async questionList(directory?: string): Promise<QuestionRequest[]> {
    const r = (await this.call("form.list", () => this.sdk.form.list(this.loc(directory) as never))) as Json;
    const items: Json[] = Array.isArray(r) ? r : (r.data ?? []);
    return items.map((f) => toQuestionRequest(this.rememberForm(f)));
  }

  async questionReply(requestID: string, answers: string[][], _directory?: string): Promise<void> {
    const form = this.forms.get(requestID);
    if (!form) throw new OpenCodeApiError(`form.reply: unknown form ${requestID}`, 404);
    await this.call("form.reply", () =>
      this.sdk.session.form.reply({ sessionID: form.sessionID, formID: requestID, answer: buildFormAnswer(form.fields, answers) }),
    );
    this.forms.delete(requestID);
    log.info("Form replied", { requestID });
  }

  async questionReject(requestID: string, _directory?: string): Promise<void> {
    const form = this.forms.get(requestID);
    if (!form) throw new OpenCodeApiError(`form.cancel: unknown form ${requestID}`, 404);
    await this.call("form.cancel", () => this.sdk.session.form.cancel({ sessionID: form.sessionID, formID: requestID }));
    this.forms.delete(requestID);
    log.info("Form cancelled", { requestID });
  }

  // ── Events ──────────────────────────────────────────────────────────────

  async subscribeEvents(_directory?: string): Promise<EventStreamHandle> {
    const ac = new AbortController();
    const source = this.sdk.event.subscribe({ signal: ac.signal })[Symbol.asyncIterator]();
    // Wait for the server's greeting so callers know the subscription is live
    // before they send a prompt (otherwise early events could be missed).
    const first = await this.call("event.subscribe", () => source.next());
    log.info("SSE connected");
    const self = this;
    async function* translate(): AsyncGenerator<unknown> {
      const toolNames = new Map<string, string>();
      const toolStarts = new Map<string, number>();
      const steps = new Map<string, { modelID?: string; providerID?: string; started?: number }>();
      let pending: IteratorResult<unknown> | undefined = first;
      for (;;) {
        const r = pending ?? (await source.next());
        pending = undefined;
        if (r.done) return;
        for (const ev of self.translateEvent(r.value as Json, toolNames, toolStarts, steps)) yield ev;
      }
    }
    return { stream: translate(), abort: () => ac.abort() };
  }

  /** Translate one 2.x event into zero or more canonical (1.x-shaped) events. */
  translateEvent(
    ev: Json,
    toolNames: Map<string, string>,
    toolStarts: Map<string, number>,
    steps: Map<string, { modelID?: string; providerID?: string; started?: number }> = new Map(),
  ): unknown[] {
    const d: Json = ev?.data ?? {};
    const sessionID: string | undefined = d.sessionID;
    switch (ev?.type) {
      case "session.text.delta":
        return [{
          type: "message.part.updated",
          properties: {
            sessionID, delta: d.delta,
            part: { type: "text", messageID: d.assistantMessageID, sessionID, text: d.delta },
          },
        }];
      // One 2.x "step" is one LLM call. 1.x reports the same thing as a completed assistant
      // message (tokens, cost, model), so translate a finished step into that shape: the
      // executor then derives usage identically for both generations.
      case "session.step.started":
        steps.set(d.assistantMessageID, {
          modelID: d.model?.id,
          providerID: d.model?.providerID,
          started: typeof d.started === "number" ? d.started : ev.created,
        });
        return [];
      case "session.step.ended": {
        const step = steps.get(d.assistantMessageID) ?? {};
        steps.delete(d.assistantMessageID);
        return [{
          type: "message.updated",
          properties: {
            sessionID,
            info: {
              id: d.assistantMessageID,
              sessionID,
              role: "assistant",
              modelID: step.modelID,
              providerID: step.providerID,
              cost: d.cost,
              tokens: d.tokens,
              time: { created: step.started, completed: ev.created ?? Date.now() },
            },
          },
        }];
      }
      case "session.tool.input.started":
        toolNames.set(d.id, d.name);
        return [];
      case "session.tool.called": {
        toolStarts.set(d.id, ev.created ?? Date.now());
        return [{
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              type: "tool", tool: toolNames.get(d.id) ?? "unknown", callID: d.id, messageID: d.assistantMessageID, sessionID,
              state: { status: "running", input: d.input ?? {}, time: { start: toolStarts.get(d.id) } },
            },
          },
        }];
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const ok = ev.type === "session.tool.success";
        const start = toolStarts.get(d.id);
        toolStarts.delete(d.id);
        return [{
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              type: "tool", tool: toolNames.get(d.id) ?? "unknown", callID: d.id, messageID: d.assistantMessageID, sessionID,
              state: ok
                ? { status: "completed", output: toolContentText(d.content), time: { start, end: ev.created ?? Date.now() } }
                : { status: "error", error: d.error?.message ?? "Unknown error", time: { start, end: ev.created ?? Date.now() } },
            },
          },
        }];
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted":
      case "session.idle":
        // `execution` and `reason` say how it ended; a 1.x-shaped consumer only needs the idle.
        return [{
          type: "session.idle",
          properties: {
            sessionID,
            execution: ev.type === "session.idle" ? "idle" : ev.type.slice("session.execution.".length),
            ...(typeof d.reason === "string" ? { reason: d.reason } : {}),
          },
        }];
      case "session.execution.started":
        return [{ type: "session.execution.started", properties: { sessionID } }];
      // The durable inbox (2.x only): what became of a message that was sent while the session was busy.
      case "session.inbox.enqueued":
      case "session.inbox.delivered":
      case "session.inbox.cancelled":
        return [{ type: ev.type, properties: { sessionID, inboxID: d.inboxID } }];
      case "permission.replied":
        return [{ type: "permission.replied", properties: { sessionID, requestID: d.requestID, reply: d.reply } }];
      case "form.replied":
        return [{ type: "question.replied", properties: { sessionID, requestID: d.id } }];
      case "form.cancelled":
        return [{ type: "question.rejected", properties: { sessionID, requestID: d.id } }];
      case "session.execution.failed":
        return [{ type: "session.error", properties: { sessionID, error: d.error ?? { message: "Session execution failed" } } }];
      case "permission.asked":
        return [{ type: "permission.asked", properties: this.toPermissionRequest(d) }];
      case "form.created": {
        const form = this.rememberForm(d.form ?? d);
        return [{ type: "question.asked", properties: toQuestionRequest(form) }];
      }
      default:
        return [];
    }
  }

  // ── MCP ─────────────────────────────────────────────────────────────────

  async mcpStatus(directory?: string): Promise<McpStatusMap> {
    const r = (await this.call("mcp.list", () => this.sdk.mcp.list(this.loc(directory)))) as Json;
    const items: Json[] = Array.isArray(r) ? r : (r.data ?? []);
    const out: McpStatusMap = {};
    for (const it of items) out[it.name] = normalizeMcpStatus(it.status);
    return out;
  }

  async mcpAdd(name: string, config: Record<string, unknown>, directory?: string): Promise<unknown> {
    log.info("mcp.add request", { name, type: config.type });
    await this.call("mcp.add", () =>
      this.sdk.experimental.mcp.add({ server: name, config: toV2McpConfig(config), ...this.loc(directory) } as never),
    );
    return undefined; // 2.x returns no body; the MCP manager polls mcp.list for status.
  }

  async mcpConnect(name: string, directory?: string): Promise<unknown> {
    log.info("mcp.connect request", { name });
    await this.call("mcp.connect", () => this.sdk.experimental.mcp.connect({ server: name, ...this.loc(directory) } as never));
    return undefined;
  }

  async mcpDisconnect(name: string, directory?: string): Promise<unknown> {
    log.info("mcp.disconnect request", { name });
    await this.call("mcp.disconnect", () => this.sdk.experimental.mcp.disconnect({ server: name, ...this.loc(directory) } as never));
    return undefined;
  }
}
