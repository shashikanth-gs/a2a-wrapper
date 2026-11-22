/**
 * Codex provider: the OpenAI Codex exec SDK (`@openai/codex-sdk`) behind `@a2a-wrapper/core`'s provider contract.
 *
 * Core owns everything A2A: the task lifecycle, cancel ordering, the queue, the per-context lane (turns of one context run
 * one after the other) and the persisted `contextId` to thread binding. This file only knows Codex:
 *
 * - `run` opens the context's thread (`resumeThread(request.session.ref)` when core hands one over, else `startThread`), binds the
 *   thread id with `run.bind` as soon as the CLI reports it (before any output) and drives one turn ({@link CodexTurn}).
 * - `abort` kills the CLI process of the turn through the abort signal; the thread is a file on disk and stays resumable.
 * - There is no `steer` and nothing is asked of a person: the exec SDK has no channel to a running turn and runs with the
 *   approval policy `never`. Core queues a message that arrives at a running task and says so.
 * - `abortOrphan`, `probeSession` and `release` serve context bindings and the restart sweep.
 */

import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import {
  RunObservability,
  SESSION_NOT_FOUND,
  SessionNotFoundError,
  bootstrapSubAgents,
  materializeMemory,
  type AbortOutcome,
  type AbortReason,
  type CoreRequest,
  type CoreTaskRun,
  type EventTransport,
  type EventTransportFn,
  type OrphanInfo,
  type ProviderExecutor,
  type ProviderInfo,
  type SessionProbe,
  type SessionRef,
  type SynthesizedMcpDescriptor,
  type TaskRunInfo,
} from "@a2a-wrapper/core";

import type { AgentConfig, McpStdioServerConfig } from "../config/types.js";
import { logger } from "../utils/logger.js";
import { CODEX_BACKEND_PATHS } from "./backend-paths.js";
import { createCodexClient } from "./client-factory.js";
import type { CodexClientLike, CodexThreadLike } from "./client-factory.js";
import { sanitizeMessage } from "./event-mapper.js";
import { toCodexMcpEntry, validateMcpServers } from "./mcp-adapter.js";
import { resolveCodexModel } from "./model-resolver.js";
import { buildThreadOptions, isThreadId, threadExistsOnDisk } from "./thread-store.js";
import { CodexTurn, failureCode } from "./turn.js";

const log = logger.child("provider");
const { version: PACKAGE_VERSION } = createRequire(import.meta.url)("../../package.json") as { version: string };

/** What the session ref in a context binding means (the Codex thread id). Bump only if a stored ref or meta of the old shape cannot be resumed. */
export const SESSION_FORMAT = "1";

/** Options for tests and embedding; production code passes none. */
export interface CodexProviderOptions {
  /** Replaces the real `Codex` client (tests). */
  clientFactory?: (config: Required<AgentConfig>) => CodexClientLike;
  /** Custom sideband event transport (Kafka, Redis, ...). */
  eventTransport?: EventTransport | EventTransportFn;
  /** Where Codex keeps its threads (`probeSession`). Default: `$CODEX_HOME` or `~/.codex`. */
  codexHome?: string;
}

export class CodexProvider implements ProviderExecutor {
  private readonly config: Required<AgentConfig>;
  private client: CodexClientLike | null = null;
  /** taskId to the turn running for it (abort). */
  private readonly turns = new Map<string, CodexTurn>();
  private initializing: Promise<void> | null = null;
  private initialized = false;
  /** Optional custom event transport supplied via programmatic API. */
  public customTransport?: EventTransport | EventTransportFn;

  constructor(config: Required<AgentConfig>, private readonly options: CodexProviderOptions = {}) {
    this.config = config;
    if (options.eventTransport) this.customTransport = options.eventTransport;
  }

  // ─── ProviderExecutor: identity and lifecycle ─────────────────────────────

  info(): ProviderInfo {
    return {
      id: "codex",
      displayName: "OpenAI Codex",
      version: PACKAGE_VERSION,
      sessionFormat: SESSION_FORMAT,
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    };
  }

  /**
   * Resume a context's thread on its next message? `session.reuseByContext: false` and `session.ttl <= 0` have always meant
   * "every task starts a new thread".
   */
  private get reuseThreads(): boolean {
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
    // 1. Validate configuration
    this.validateConfig();

    // 1b. Resolve `codex.model`: an explicit name is kept; "auto" (the default) picks the account's first listed model so a
    //     stale desktop-app default in ~/.codex/config.toml is never inherited.
    this.config.codex.model = await resolveCodexModel(this.config.codex.model, {
      codexPath: this.config.codex.codexPathOverride,
    });

    // 2. Memory materialization (before backend client setup)
    if (this.config.memory) {
      const workspaceDir = this.config.codex.workingDirectory;
      if (workspaceDir) {
        await materializeMemory({
          memoryConfig: this.config.memory,
          configDir: this.config.configDir ?? process.cwd(),
          workspaceDir,
          paths: CODEX_BACKEND_PATHS,
        });
      }
    }

    // 3. Validate user-supplied MCP servers BEFORE the bridge entry is merged, so the internally generated reserved
    //    "a2a-subagents" key is not rejected while user-supplied conflicts still are.
    validateMcpServers(this.config.mcp ?? {});

    // 4. Sub-agents bootstrap: synthesize the a2a-mcp-skillmap MCP entry and merge it into config.mcp before the client is
    //    constructed (MCP is baked in at SDK construction time and cannot be registered at runtime).
    if (this.config.subAgents?.agents?.length) {
      const existingMcpKeys = new Set(Object.keys(this.config.mcp ?? {}));
      const result = await bootstrapSubAgents({
        subAgents: this.config.subAgents,
        workspaceDir: this.config.codex.workingDirectory || undefined,
        parentLogLevel: this.config.logging.level ?? "info",
        existingMcpKeys,
      });
      this.config.mcp = {
        ...(this.config.mcp ?? {}),
        [result.descriptor.key]: this.toCodexMcpEntry(result.descriptor),
      };
    }

    // 5. Construct the Codex client (MCP config baked in here)
    this.client = this.options.clientFactory ? this.options.clientFactory(this.config) : createCodexClient(this.config);
    log.info("Codex client constructed", {
      workingDirectory: this.config.codex.workingDirectory,
      sandboxMode: this.config.codex.sandboxMode,
      model: this.config.codex.model,
      mcpServers: Object.keys(this.config.mcp || {}),
    });
    log.info("Provider initialized");
  }

  async shutdown(): Promise<void> {
    // A turn still running was told to stop by core (reason `shutdown`); make sure no CLI process outlives the provider.
    await Promise.all([...this.turns.values()].map((t) => t.abort().catch(() => {})));
    this.turns.clear();
    this.client = null;
    this.initialized = false;
    this.initializing = null;
    log.info("Provider shut down");
  }

  // ─── ProviderExecutor: a turn ─────────────────────────────────────────────

  async run(req: CoreRequest, run: CoreTaskRun): Promise<void> {
    try {
      await this.initialize();
    } catch (err) {
      await this.failEarly(req, run, err);
      return;
    }
    run.progress("Processing request...");

    const opened = this.openThread(req);
    if (opened === "not-found") {
      // Reported before anything was published: core forgets the binding and runs this turn again on a fresh thread.
      run.fail({ message: `Codex has no thread ${req.session?.ref ?? ""}`.trim(), code: SESSION_NOT_FOUND });
      return;
    }
    const turn = new CodexTurn({
      config: this.config,
      thread: opened.thread,
      request: req,
      run,
      ...(this.customTransport ? { customTransport: this.customTransport } : {}),
      ...(opened.resumeRef ? { resumeRef: opened.resumeRef } : {}),
      bindThread: this.reuseThreads,
    });
    this.turns.set(req.taskId, turn);
    try {
      await turn.run();
    } finally {
      if (this.turns.get(req.taskId) === turn) this.turns.delete(req.taskId);
    }
  }

  /**
   * The thread of a turn: the context's own, resumed (`request.session`), or a new one. The thread options (model, sandbox, approval
   * policy, network, directories, web search) are per run and are passed on resume too.
   */
  private openThread(req: CoreRequest): { thread: CodexThreadLike; resumeRef?: string } | "not-found" {
    const client = this.client;
    if (!client) throw new Error("Codex client is not started");
    const options = buildThreadOptions(this.config);
    const ref = this.reuseThreads ? req.session?.ref : undefined;
    if (ref) {
      // `codex exec resume <x>` takes anything that is not a thread id for a thread NAME or the prompt and starts another thread.
      if (!isThreadId(ref)) return "not-found";
      log.info("Resuming Codex thread", { contextId: req.contextId, threadId: ref });
      return { thread: client.resumeThread(ref, options), resumeRef: ref };
    }
    log.info("Starting Codex thread", { contextId: req.contextId });
    return { thread: client.startThread(options) };
  }

  /** The provider could not start (configuration, model resolution, client): the failure the caller has always seen. */
  private async failEarly(req: CoreRequest, run: CoreTaskRun, error: unknown): Promise<void> {
    if (run.signal.aborted) return;
    const message = sanitizeMessage(error instanceof Error ? error.message : String(error));
    log.error("Provider outer error", { taskId: req.taskId, error: message });
    const obs = new RunObservability({
      agentName: this.config.agentCard.name,
      backend: "codex",
      request: req,
      run,
      events: this.config.events,
      ...(this.customTransport ? { customTransport: this.customTransport } : {}),
      warn: (m, d) => log.warn(m, d as Record<string, unknown> | undefined),
    });
    await obs.error(message).catch(() => {});
    run.fail({ message, code: failureCode(message) });
  }

  // ─── ProviderExecutor: stop, sessions ─────────────────────────────────────

  /**
   * Stop the turn: abort its signal, which kills the CLI process. Confirmed when the turn's stream has ended. Whatever the
   * reason, the thread (a rollout file) stays and takes the next message.
   */
  async abort(info: TaskRunInfo, _reason: AbortReason): Promise<AbortOutcome> {
    const turn = this.turns.get(info.taskId);
    // Still opening the thread: nothing was sent, and the turn does not start once its signal is aborted.
    if (!turn) return { stopped: "confirmed", session: "reusable" };
    return turn.abort();
  }

  /**
   * A task the store thinks is active but that has no live run (the process restarted). Each turn is a CLI child process of this
   * wrapper and dies with it, and the thread is a file on disk: there is nothing to stop. (A child that survived a hard kill of
   * the wrapper cannot be found again; Codex gives no handle to it.)
   */
  async abortOrphan(_info: OrphanInfo): Promise<AbortOutcome> {
    return { stopped: "confirmed", session: "reusable" };
  }

  /** The thread is a file on disk: there is no in-process state to drop. */
  async release(_session: Pick<SessionRef, "ref">): Promise<void> {}

  /** Does the thread still exist? Cheap: its rollout file under `$CODEX_HOME/sessions`. `unknown` when the directory cannot be read. */
  async probeSession(session: SessionRef): Promise<SessionProbe> {
    try {
      const found = await threadExistsOnDisk(session.ref, this.options.codexHome);
      return found === undefined ? "unknown" : found ? "alive" : "gone";
    } catch {
      return "unknown";
    }
  }

  // ─── Context build (HTTP routes) ──────────────────────────────────────────

  async getContextContent(): Promise<string | null> {
    const codex = this.config.codex;
    if (!codex.workingDirectory) return null;
    const contextFile = codex.contextFile ?? "context.md";
    const contextPath = join(codex.workingDirectory, contextFile);
    try {
      return await fsReadFile(contextPath, "utf-8");
    } catch {
      return null;
    }
  }

  async buildContext(prompt?: string): Promise<string> {
    await this.initialize();

    const codex = this.config.codex;
    const contextPrompt =
      prompt ||
      codex.contextPrompt ||
      "Explore this repository. Describe its purpose, major modules, entry points, " +
        "build commands, test commands, runtime dependencies, and key architectural constraints. Be concise.";

    // Use a read-only thread so context building never modifies the workspace
    const thread = this.client!.startThread({
      workingDirectory: codex.workingDirectory || undefined,
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      skipGitRepoCheck: codex.skipGitRepoCheck ?? false,
    });

    const result = await thread.run(contextPrompt);
    return result.finalResponse ?? "";
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private validateConfig(): void {
    const codex = this.config.codex;

    if (!codex.workingDirectory) {
      throw new Error("codex.workingDirectory is required. Set it in config.json or export WORKSPACE_DIR.");
    }

    const resolved = resolvePath(codex.workingDirectory);
    if (!existsSync(resolved)) {
      throw new Error(
        `codex.workingDirectory does not exist: "${resolved}". ` + "Ensure the path exists before starting the agent.",
      );
    }
    if (!statSync(resolved).isDirectory()) {
      throw new Error(`codex.workingDirectory is not a directory: "${resolved}".`);
    }

    if (codex.approvalPolicy === "on-request") {
      throw new Error(
        'approvalPolicy "on-request" requires interactive human input, which is incompatible ' +
          'with headless A2A execution. Use "never" (default) for automated operation.',
      );
    }

    const validSandboxModes = ["read-only", "workspace-write", "danger-full-access"];
    if (codex.sandboxMode && !validSandboxModes.includes(codex.sandboxMode)) {
      throw new Error(`Invalid sandboxMode "${codex.sandboxMode}". ` + `Supported values: ${validSandboxModes.join(", ")}.`);
    }

    if (codex.sandboxMode === "danger-full-access") {
      log.warn(
        "⚠️  sandboxMode is set to danger-full-access. " +
          "Codex has unrestricted filesystem and command access. " +
          "Only use this inside an isolated container or VM.",
      );
    }

    if (codex.networkAccessEnabled) {
      log.warn(
        "⚠️  networkAccessEnabled is true. " +
          "Codex has outbound network access. " +
          "Ensure this is intentional for your deployment.",
      );
    }
  }

  private toCodexMcpEntry(descriptor: SynthesizedMcpDescriptor): McpStdioServerConfig {
    return toCodexMcpEntry(descriptor);
  }
}
