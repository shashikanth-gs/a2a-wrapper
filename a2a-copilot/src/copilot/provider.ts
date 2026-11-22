/**
 * Copilot provider: the GitHub Copilot SDK behind `@a2a-wrapper/core`'s provider contract.
 *
 * Core owns everything A2A: the task lifecycle, cancel ordering, the queue, steering delivery, interactions (input-required)
 * and the persisted `contextId` to session binding. This file only knows Copilot:
 *
 * - `run` opens (or resumes) a Copilot session, binds its id with `run.bind` before any output, and drives one turn
 *   ({@link CopilotTurn}).
 * - `steer` sends the message with Copilot's native `mode: "immediate"` and reports honestly what happened.
 * - `abort` calls `session.abort()`; on `cancel` it also flushes Copilot's queue, on `interrupt` it keeps it.
 * - Permission requests and `ask_user` questions go through `run.ask`. On the default interaction policy nobody is
 *   asked and every permission is approved, as it always was; with `interactions.mode: "ask"` they reach the A2A client.
 * - `release`, `probeSession` and `abortOrphan` serve context bindings and the restart sweep.
 */

import { createRequire } from "node:module";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { CopilotClient, approveAll, RuntimeConnection } from "@github/copilot-sdk";
import {
  ABORT_FAILED_OUTCOME,
  RunObservability,
  SESSION_NOT_FOUND,
  SessionNotFoundError,
  WELL_KNOWN_PATHS,
  bootstrapSubAgents,
  buildCopilotTelemetryOptions,
  createCopilotTraceContextProvider,
  materializeMemory,
  shouldPropagateCopilotTraceContext,
  type AbortOutcome,
  type AbortReason,
  type CoreMessage,
  type CoreRequest,
  type CoreTaskRun,
  type EventTransport,
  type EventTransportFn,
  type OrphanInfo,
  type ProviderExecutor,
  type ProviderInfo,
  type SessionProbe,
  type SessionRef,
  type SteerOutcome,
  type SynthesizedMcpDescriptor,
  type TaskRunInfo,
} from "@a2a-wrapper/core";

import type { AgentConfig, McpStdioServerConfig } from "../config/types.js";
import { logger } from "../utils/logger.js";
import {
  permissionInteraction,
  permissionResult,
  questionAnswer,
  questionInteraction,
  type CopilotPermissionRequest,
  type CopilotUserInputRequest,
} from "./interactions.js";
import { McpEvidenceHooks } from "./mcp-hooks.js";
import { buildMcpServers, buildProviderOption, buildSessionOptions } from "./session-options.js";
import { CopilotTurn, describeFailure } from "./turn.js";
import type { CopilotClientLike, CopilotSession } from "./types.js";

const log = logger.child("provider");
const { version: PACKAGE_VERSION } = createRequire(import.meta.url)("../../package.json") as { version: string };

/** What the session ref in a context binding means. Bump only if a stored ref or meta of the old shape cannot be resumed. */
export const SESSION_FORMAT = "1";

/** Options for tests and embedding; production code passes none. */
export interface CopilotProviderOptions {
  /** Replaces the real `CopilotClient` (tests). */
  clientFactory?: (config: Required<AgentConfig>) => CopilotClientLike;
  /** Custom sideband event transport (Kafka, Redis, ...). */
  eventTransport?: EventTransport | EventTransportFn;
}

/** A live Copilot session and what is running on it. */
interface SessionEntry {
  session: CopilotSession;
  hooks: McpEvidenceHooks;
  /** The turn running on the session now: permission requests are asked through it. */
  current?: CopilotTurn;
  lastUsed: number;
}

/** Does this error say the runtime has no such session? */
export function isSessionNotFound(error: unknown): boolean {
  const msg = ((error as Error)?.message ?? String(error)).toLowerCase();
  return /session.*(not found|does not exist|unknown|no such)|(not found|no such|unknown).*session|enoent/.test(msg);
}

export class CopilotProvider implements ProviderExecutor {
  private readonly config: Required<AgentConfig>;
  private client: CopilotClientLike | null = null;
  /** Live sessions by Copilot session id. Resuming a session that is not here is `resumeSession`. */
  private readonly live = new Map<string, SessionEntry>();
  /** taskId to the turn running for it (cancel, steering). */
  private readonly turns = new Map<string, CopilotTurn>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private initializing: Promise<void> | null = null;
  private initialized = false;
  /** Optional custom event transport supplied via programmatic API. */
  public customTransport?: EventTransport | EventTransportFn;

  constructor(config: Required<AgentConfig>, private readonly options: CopilotProviderOptions = {}) {
    this.config = config;
    if (options.eventTransport) this.customTransport = options.eventTransport;
  }

  // ─── ProviderExecutor: identity and lifecycle ─────────────────────────────

  info(): ProviderInfo {
    return {
      id: "copilot",
      displayName: "GitHub Copilot",
      version: PACKAGE_VERSION,
      sessionFormat: SESSION_FORMAT,
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    };
  }

  /** `ask`: permission requests and questions reach the A2A client. Otherwise the headless default. */
  private get askMode(): boolean {
    return this.config.interactions?.mode === "ask";
  }

  /** Reuse a Copilot session across the turns of a context? `session.ttl <= 0` has always meant "never reuse". */
  private get reuseSessions(): boolean {
    return this.config.session.reuseByContext !== false && (this.config.session.ttl ?? 3_600_000) > 0;
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    this.initializing ??= this.doInitialize().then(
      () => {
        this.initialized = true;
      },
      (e) => {
        this.initializing = null;
        throw e;
      },
    );
    return this.initializing;
  }

  private async doInitialize(): Promise<void> {
    // Memory materialization (before backend client setup)
    if (this.config.memory) {
      const workspaceDir = this.config.copilot.workspaceDirectory;
      if (workspaceDir) {
        await materializeMemory({
          memoryConfig: this.config.memory,
          configDir: this.config.configDir ?? process.cwd(),
          workspaceDir,
          paths: WELL_KNOWN_PATHS.copilot,
        });
      }
    }

    // Sub-agents bootstrap — synthesize the a2a-mcp-skillmap MCP entry from the operator's `subAgents` config and merge it
    // into `this.config.mcp` before any MCP-using code (the Copilot client / sessions) reads it.
    if (this.config.subAgents?.agents?.length) {
      const existingMcpKeys = new Set(Object.keys(this.config.mcp ?? {}));
      const result = await bootstrapSubAgents({
        subAgents: this.config.subAgents,
        workspaceDir: this.config.copilot.workspaceDirectory || undefined,
        parentLogLevel: this.config.logging.level ?? "info",
        existingMcpKeys,
      });
      this.config.mcp = {
        ...(this.config.mcp ?? {}),
        [result.descriptor.key]: this.toCopilotMcpEntry(result.descriptor),
      };
    }

    this.client = this.options.clientFactory ? this.options.clientFactory(this.config) : this.createClient();
    try {
      await this.client.start();
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const isNotFound = msg.includes("ENOENT") || msg.includes("not found") || msg.includes("spawn") || msg.includes("CLI not found");
      const isAuth = msg.toLowerCase().includes("auth") || msg.toLowerCase().includes("login") || msg.toLowerCase().includes("token") || msg.toLowerCase().includes("unauthorized");
      if (isNotFound) {
        throw new Error(
          "GitHub Copilot CLI not found. Ensure @github/copilot is installed.\n" +
          "Then authenticate with: gh auth login"
        );
      }
      if (isAuth) {
        throw new Error(
          "GitHub Copilot CLI is not authenticated. Run: gh auth login\n" +
          "Then verify with: gh copilot --version"
        );
      }
      throw new Error(`Failed to start GitHub Copilot CLI: ${msg}`);
    }
    log.info("Copilot client started", { cliUrl: this.config.copilot.cliUrl || "(auto-managed)" });

    this.startCleanup();
    log.info("Provider initialized", {
      model: this.config.copilot.model,
      mcpServers: Object.keys(this.config.mcp || {}),
      interactions: this.askMode ? "ask" : "auto",
    });
  }

  /** The real client: SDK 1.0 uses RuntimeConnection factories instead of the flat options of 0.2.x. */
  private createClient(): CopilotClientLike {
    const clientOpts: Record<string, unknown> = {};

    if (this.config.copilot.cliUrl) {
      // Connect to a pre-running CLI server (Docker, CI, remote)
      clientOpts.connection = RuntimeConnection.forUri(this.config.copilot.cliUrl);
    } else {
      // Spawn the CLI binary managed by this process (default path); workingDirectory sets its cwd.
      if (this.config.copilot.workspaceDirectory) clientOpts.workingDirectory = this.config.copilot.workspaceDirectory;
      // GitHub PAT for auth (required in Docker where `gh` CLI is unavailable)
      if (this.config.copilot.githubToken) clientOpts.gitHubToken = this.config.copilot.githubToken;
    }

    // Hook F — Copilot CLI OTel exporter + parent-link into a2a.task.execute.
    // `telemetry` only affects SDK-spawned CLI env (not external cliUrl servers).
    const telemetry = buildCopilotTelemetryOptions(this.config.otel);
    if (telemetry) {
      clientOpts.telemetry = telemetry;
      log.info("Copilot CLI OTel telemetry configured", {
        otlpEndpoint: telemetry.otlpEndpoint,
        exporterType: telemetry.exporterType,
        externalCli: Boolean(this.config.copilot.cliUrl),
      });
    }
    if (shouldPropagateCopilotTraceContext(this.config.otel)) {
      clientOpts.onGetTraceContext = createCopilotTraceContextProvider();
    }
    return new CopilotClient(clientOpts as any) as unknown as CopilotClientLike;
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [id, entry] of [...this.live.entries()]) {
      try {
        await entry.session.disconnect();
      } catch {
        /* best effort */
      }
      this.live.delete(id);
    }
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    this.initialized = false;
    this.initializing = null;
    log.info("Provider shut down");
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  /**
   * Get the session for a turn: the live one, a resumed one (`request.session`), or a new one. A session the runtime does
   * not know is `SessionNotFoundError`, which core answers by forgetting the binding and running the turn once more fresh.
   */
  private async openSession(req: CoreRequest): Promise<{ entry: SessionEntry; reused: boolean }> {
    const ref = this.reuseSessions ? req.session?.ref : undefined;
    if (ref) {
      const live = this.live.get(ref);
      if (live) {
        live.lastUsed = Date.now();
        log.debug("Reusing session", { contextId: req.contextId, sessionId: ref });
        return { entry: live, reused: true };
      }
      try {
        const entry = await this.openEntry("resume", ref);
        log.info("Session resumed", { contextId: req.contextId, sessionId: ref });
        return { entry, reused: true };
      } catch (e) {
        if (isSessionNotFound(e)) throw new SessionNotFoundError(`Copilot has no session ${ref}`);
        throw e;
      }
    }
    return { entry: await this.openEntry("create"), reused: false };
  }

  private async openEntry(how: "create", id?: undefined): Promise<SessionEntry>;
  private async openEntry(how: "resume", id: string): Promise<SessionEntry>;
  private async openEntry(how: "create" | "resume", id?: string): Promise<SessionEntry> {
    const client = this.client;
    if (!client) throw new Error("Copilot client is not started");
    // Hooks and handlers belong to the session; they reach the running turn through `entry.current`.
    const entry: SessionEntry = {
      session: undefined as unknown as CopilotSession,
      hooks: new McpEvidenceHooks(!this.askMode),
      lastUsed: Date.now(),
    };
    const opts = buildSessionOptions(this.config);
    opts.hooks = entry.hooks.getHooks();
    opts.onPermissionRequest = (request: CopilotPermissionRequest, invocation: unknown) => this.onPermission(entry, request, invocation);
    // `ask_user` is only offered to the model when somebody can answer it.
    if (this.askMode) opts.onUserInputRequest = (request: CopilotUserInputRequest) => this.onUserInput(entry, request);

    log.info(how === "create" ? "Creating Copilot session" : "Resuming Copilot session", {
      model: opts.model,
      mcpServers: Object.keys((opts.mcpServers ?? {}) as Record<string, unknown>),
    });
    entry.session = how === "create" ? await client.createSession(opts) : await client.resumeSession(id!, opts);
    const sessionId = entry.session.sessionId ?? `session-${Date.now()}`;
    this.live.set(sessionId, entry);
    log.info("Session ready", { sessionId });
    return entry;
  }

  /** A Copilot permission request: ask through the running turn, or fall back to the headless default. */
  private async onPermission(entry: SessionEntry, request: CopilotPermissionRequest, invocation: unknown): Promise<any> {
    const turn = entry.current;
    const approve = () => approveAll(request as never, invocation as never);
    if (!turn) return this.askMode ? { kind: "user-not-available" } : approve();
    try {
      const result = await turn.ask(permissionInteraction(request));
      // Default policy and no rule answered: nobody is asked, so every permission is approved, exactly as before.
      if (!this.askMode && result.outcome === "unavailable") return approve();
      return permissionResult(result, !this.askMode);
    } catch (e) {
      log.warn("Permission request failed", { error: (e as Error).message });
      return this.askMode ? { kind: "reject" } : approve();
    }
  }

  /** An `ask_user` question (offered only in ask mode). */
  private async onUserInput(entry: SessionEntry, request: CopilotUserInputRequest): Promise<{ answer: string; wasFreeform: boolean }> {
    const turn = entry.current;
    if (!turn) throw new Error("no running task to ask");
    const result = await turn.ask(questionInteraction(request));
    const answer = questionAnswer(result, request);
    if (!answer) throw new Error("the question was not answered");
    return answer;
  }

  private startCleanup(): void {
    const interval = this.config.session.cleanupInterval ?? 300_000;
    if (interval <= 0) return;
    this.cleanupTimer = setInterval(() => {
      const ttl = this.config.session.ttl ?? 3_600_000;
      const now = Date.now();
      for (const [id, entry] of this.live.entries()) {
        if (entry.current || now - entry.lastUsed <= ttl) continue;
        // Only the in-process handle goes: the session stays on disk and the context binding resumes it on the next turn.
        log.info("Releasing idle session handle", { sessionId: id });
        entry.session.disconnect().catch(() => {});
        this.live.delete(id);
      }
    }, interval);
    this.cleanupTimer.unref?.();
  }

  // ─── ProviderExecutor: a turn ─────────────────────────────────────────────

  async run(req: CoreRequest, run: CoreTaskRun): Promise<void> {
    await this.initialize();
    run.progress("Processing request...");

    let opened: { entry: SessionEntry; reused: boolean };
    try {
      opened = await this.openSession(req);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        // Reported before anything was published: core forgets the binding and runs this turn again with a fresh session.
        run.fail({ message: error.message, code: SESSION_NOT_FOUND });
        return;
      }
      await this.failEarly(req, run, error);
      return;
    }
    const { entry, reused } = opened;
    const sessionId = entry.session.sessionId;

    // Persist contextId -> session before the first output, so a restart mid-turn can resume it.
    if (this.reuseSessions && req.session?.ref !== sessionId) {
      run.bind({ ref: sessionId, ...(this.config.copilot.model ? { meta: { model: this.config.copilot.model } } : {}) });
    }

    const turn = new CopilotTurn({
      config: this.config,
      session: entry.session,
      hooks: entry.hooks,
      request: req,
      run,
      ...(this.customTransport ? { customTransport: this.customTransport } : {}),
      interactions: this.askMode ? "ask" : "auto",
      ...(this.config.timeouts.steerAck !== undefined ? { steerAckMs: this.config.timeouts.steerAck } : {}),
      reused,
    });
    entry.current = turn;
    this.turns.set(req.taskId, turn);
    try {
      await turn.run();
    } finally {
      if (entry.current === turn) entry.current = undefined;
      if (this.turns.get(req.taskId) === turn) this.turns.delete(req.taskId);
      entry.lastUsed = Date.now();
      if (!this.reuseSessions) {
        // Nothing will resume it: release the SDK handle (the data stays on disk).
        this.live.delete(sessionId);
        entry.session.disconnect().catch(() => {});
      }
    }
  }

  /** The session could not be opened: the same failure the caller has always seen, with the lifecycle pair a collector expects. */
  private async failEarly(req: CoreRequest, run: CoreTaskRun, error: unknown): Promise<void> {
    if (run.signal.aborted) return;
    const obs = new RunObservability({
      agentName: this.config.agentCard.name,
      backend: "copilot",
      request: req,
      run,
      events: this.config.events,
      ...(this.customTransport ? { customTransport: this.customTransport } : {}),
      trackUsage: this.config.features.trackUsage === true,
      warn: (m, d) => log.warn(m, d as Record<string, unknown> | undefined),
    });
    const { message, code } = describeFailure(error, this.config.copilot.cliUrl);
    log.error("Execution failed", { taskId: req.taskId, error: (error as Error)?.message ?? String(error) });
    void obs.start();
    await obs.error(message);
    run.fail({ message, code });
  }

  // ─── ProviderExecutor: steering, stop, sessions ───────────────────────────

  async steer(run: CoreTaskRun, message: CoreMessage): Promise<SteerOutcome> {
    const turn = this.turns.get(run.taskId);
    if (!turn) return { state: "rejected", reason: "no-active-turn" };
    return turn.steer(message);
  }

  async abort(info: TaskRunInfo, reason: AbortReason): Promise<AbortOutcome> {
    const turn = this.turns.get(info.taskId);
    // Still opening the session: nothing was sent, and `run` does not send once its signal is aborted.
    if (!turn) return { stopped: "confirmed", session: "reusable" };
    return turn.abort(reason);
  }

  /**
   * A task the store thinks is active but that has no live run (the process restarted). A runtime this process spawned died
   * with it, so there is nothing running. With an external runtime (`cliUrl`) the session may still be working: resume it
   * and abort.
   */
  async abortOrphan(info: OrphanInfo): Promise<AbortOutcome> {
    const ref = info.session?.ref;
    if (!this.config.copilot.cliUrl || !ref || !this.client) return { stopped: "confirmed", session: "reusable" };
    try {
      await this.initialize();
      const entry = this.live.get(ref) ?? (await this.openEntry("resume", ref));
      await entry.session.abort();
      return { stopped: "confirmed", session: "reusable" };
    } catch (e) {
      log.warn("Aborting an orphaned session failed", { sessionId: ref, error: (e as Error).message });
      return { ...ABORT_FAILED_OUTCOME };
    }
  }

  /** Core discarded the session (a failed abort, a TTL): drop the in-process handle. The data stays on disk. */
  async release(session: Pick<SessionRef, "ref">): Promise<void> {
    const entry = this.live.get(session.ref);
    this.live.delete(session.ref);
    if (!entry) return;
    try {
      await entry.session.disconnect();
    } catch (e) {
      log.warn("Session disconnect failed", { sessionId: session.ref, error: (e as Error).message });
    }
  }

  /** Does the runtime still have this session? Cheap: the live handle, else the runtime's own session list. */
  async probeSession(session: SessionRef): Promise<SessionProbe> {
    if (this.live.has(session.ref)) return "alive";
    const get = this.client?.getSessionMetadata;
    if (!get) return "unknown";
    try {
      return (await get.call(this.client, session.ref)) ? "alive" : "gone";
    } catch {
      return "unknown";
    }
  }

  // ─── Context build (HTTP routes) ──────────────────────────────────────────

  /**
   * Build (or refresh) the domain context file by sending a prompt via Copilot SDK.
   * Returns the assistant's response text.
   */
  async buildContext(prompt?: string): Promise<string> {
    await this.initialize();

    const copilotCfg = this.config.copilot;
    const contextFile = copilotCfg.contextFile || "context.md";
    const contextPrompt = prompt || copilotCfg.contextPrompt;
    if (!contextPrompt) {
      throw new Error("No context prompt provided and no default contextPrompt configured");
    }

    // Create a dedicated session for context building
    const opts: Record<string, unknown> = {};
    if (copilotCfg.model) opts.model = copilotCfg.model;

    // Include MCP servers for tool access during context building
    const mcpServers = buildMcpServers(this.config.mcp);
    if (mcpServers) opts.mcpServers = mcpServers;

    // Auto-approve MCP tool permissions for headless context building
    opts.onPermissionRequest = approveAll;

    // Custom LLM provider (BYOK) — must be forwarded here too since buildContext creates its own session directly.
    const provider = buildProviderOption(copilotCfg);
    if (provider) opts.provider = provider;

    const session = await this.client!.createSession(opts);
    const sessionId = session.sessionId ?? "context-build";

    log.info("Building context", { sessionId, contextFile });

    const response = await session.sendAndWait({ prompt: contextPrompt });
    const responseText = (response as any)?.data?.content ?? "";

    await session.disconnect();

    log.info("Context build complete", { sessionId, responseLen: responseText.length });
    return responseText;
  }

  /**
   * Read the context file from the workspace directory.
   * Returns the file content or null if it doesn't exist.
   */
  async getContextContent(): Promise<string | null> {
    const copilotCfg = this.config.copilot;
    const contextFile = copilotCfg.contextFile || "context.md";
    const workspaceDir = copilotCfg.workspaceDirectory || undefined;

    if (!workspaceDir) {
      log.warn("No workspace directory configured, cannot read context file");
      return null;
    }

    const filePath = join(workspaceDir, contextFile);
    try {
      return await fsReadFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Translate a wrapper-agnostic {@link SynthesizedMcpDescriptor} into the stdio MCP entry shape consumed by the Copilot
   * SDK / this wrapper's resolved `mcp` map, merged under `descriptor.key` (the reserved `a2a-subagents` key).
   */
  private toCopilotMcpEntry(descriptor: SynthesizedMcpDescriptor): McpStdioServerConfig {
    return {
      type: "stdio",
      command: descriptor.command,
      args: descriptor.args,
      env: descriptor.env,
      enabled: true,
    };
  }
}
