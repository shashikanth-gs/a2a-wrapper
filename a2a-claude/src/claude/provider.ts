/**
 * Claude provider: the Claude Agent SDK behind `@a2a-wrapper/core`'s provider contract.
 *
 * Core owns everything A2A: the task lifecycle, cancel ordering, the queue, steering delivery, interactions (input-required)
 * and the persisted `contextId` to session binding. This file only knows Claude:
 *
 * - `run` drives one turn ({@link ClaudeTurn}): a streaming-input `query()` that resumes the context's Claude session
 *   (`request.session.ref`) and binds the session id with `run.bind` as soon as the CLI reports it, before any output.
 * - `steer` pushes the message into the running query with the SDK's `priority`, and reports honestly what became of it.
 * - `abort` ends the query: `cancel` at once, `interrupt` after asking the CLI to end the running turn.
 * - Permission requests and `AskUserQuestion` go through `run.ask` when `interactions` can answer them. On the default
 *   policy nobody is asked and `claude.permissionMode` decides, as it always did.
 * - `probeSession` serves the restart sweep. There is no in-process session handle to `release`: a query's process ends with
 *   its turn and the session lives on disk.
 */

import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import { materializeMemory, bootstrapSubAgents } from "@a2a-wrapper/core";
import type {
  AbortOutcome,
  AbortReason,
  CoreMessage,
  CoreRequest,
  CoreTaskRun,
  EventTransport,
  EventTransportFn,
  OrphanInfo,
  ProviderExecutor,
  ProviderInfo,
  SessionProbe,
  SessionRef,
  SteerOutcome,
  SynthesizedMcpDescriptor,
  TaskRunInfo,
} from "@a2a-wrapper/core";

import type { AgentConfig, McpStdioServerConfig } from "../config/types.js";
import { createClaudeClient, buildQueryOptions } from "./client-factory.js";
import type { ClaudeClientLike, SDKMessageLike } from "./client-factory.js";
import { validateMcpServers, toClaudeMcpEntry } from "./mcp-adapter.js";
import { CLAUDE_BACKEND_PATHS } from "./backend-paths.js";
import { ClaudeTurn } from "./turn.js";
import { logger } from "../utils/logger.js";

const log = logger.child("provider");
const { version: PACKAGE_VERSION } = createRequire(import.meta.url)("../../package.json") as { version: string };

/** What the session ref in a context binding means. Bump only if a stored ref or meta of the old shape cannot be resumed. */
export const SESSION_FORMAT = "1";

/** Modes a headless deployment can run in: nothing ever asks. */
const HEADLESS_PERMISSION_MODES = new Set(["acceptEdits", "dontAsk", "plan", "bypassPermissions"]);
const VALID_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const VALID_THINKING_TYPES = new Set(["adaptive", "enabled", "disabled"]);
const VALID_OUTPUT_FORMAT_TYPES = new Set(["json_schema"]);

/** Options for tests and embedding; production code passes none. */
export interface ClaudeProviderOptions {
  /** Replaces the real Claude client (tests). */
  clientFactory?: (config: Required<AgentConfig>) => ClaudeClientLike;
  /** Custom sideband event transport (Kafka, Redis, ...). */
  eventTransport?: EventTransport | EventTransportFn;
}

export class ClaudeProvider implements ProviderExecutor {
  private readonly config: Required<AgentConfig>;
  private readonly clientFactory: (config: Required<AgentConfig>) => ClaudeClientLike;
  private client: ClaudeClientLike | null = null;
  /** taskId to the turn running for it (cancel, steering). */
  private readonly turns = new Map<string, ClaudeTurn>();
  private initialized = false;
  private initializing: Promise<void> | null = null;

  /** Optional custom event transport supplied via programmatic API. */
  public customTransport?: EventTransport | EventTransportFn;

  constructor(config: Required<AgentConfig>, options: ClaudeProviderOptions = {}) {
    this.config = config;
    this.clientFactory = options.clientFactory ?? createClaudeClient;
    if (options.eventTransport) this.customTransport = options.eventTransport;
  }

  // ─── ProviderExecutor: identity and lifecycle ─────────────────────────────

  info(): ProviderInfo {
    return {
      id: "claude",
      displayName: "Claude",
      version: PACKAGE_VERSION,
      sessionFormat: SESSION_FORMAT,
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    };
  }

  /** `ask`: permission requests and questions reach the A2A client. */
  private get askMode(): boolean {
    return this.config.interactions?.mode === "ask";
  }

  /** Can a person or a rule answer a permission request? Only then `canUseTool` is installed (and `default` mode is valid). */
  private get interactive(): boolean {
    return this.askMode || (this.config.interactions?.autoAnswer?.length ?? 0) > 0;
  }

  /** Resume a Claude session across the turns of a context? `session.reuseByContext: false` has always meant "never". */
  private get reuseSessions(): boolean {
    return this.config.session.reuseByContext !== false;
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
    this.validateConfig();

    if (!process.env["ANTHROPIC_API_KEY"]) {
      log.warn(
        "ANTHROPIC_API_KEY is not set. Requests will fail unless another auth " +
        "path (Bedrock/Vertex/OAuth) is configured in the environment.",
      );
    }

    // Memory materialization (CLAUDE.md conventions)
    if (this.config.memory) {
      const workspaceDir = this.config.claude.workingDirectory;
      if (workspaceDir) {
        await materializeMemory({
          memoryConfig: this.config.memory,
          configDir: this.config.configDir ?? process.cwd(),
          workspaceDir,
          paths: CLAUDE_BACKEND_PATHS,
        });
      }
    }

    // Sub-agents bootstrap — merge the bridge entry into config.mcp before any query options are built.
    if (this.config.subAgents?.agents?.length) {
      const existingMcpKeys = new Set(Object.keys(this.config.mcp ?? {}));
      const result = await bootstrapSubAgents({
        subAgents: this.config.subAgents,
        workspaceDir: this.config.claude.workingDirectory || undefined,
        parentLogLevel: this.config.logging.level ?? "info",
        existingMcpKeys,
      });
      this.config.mcp = {
        ...(this.config.mcp ?? {}),
        [result.descriptor.key]: this.toClaudeMcpEntry(result.descriptor),
      };
    }

    // Validate user MCP entries (the reserved bridge key is exempt by validating the user-supplied map minus the bridge entry).
    const userMcp = { ...(this.config.mcp ?? {}) };
    delete userMcp["a2a-subagents"];
    validateMcpServers(userMcp);

    this.client = this.clientFactory(this.config);
    log.info("Claude client constructed", {
      workingDirectory: this.config.claude.workingDirectory,
      permissionMode: this.config.claude.permissionMode,
      mcpServers: Object.keys(this.config.mcp || {}),
      interactions: this.askMode ? "ask" : this.interactive ? "auto+rules" : "auto",
    });

    await this.preflightPlugins();

    log.info("Provider initialized");
  }


  /**
   * Verify every enabled marketplace plugin actually loaded, before the server
   * accepts traffic.
   *
   * This has to diff the init message's `plugins` array, because nothing else
   * reports the failure: `plugin_install` events describe the *marketplace*, so
   * a marketplace that clones fine but contains no plugin by the configured
   * name still emits "installed" then "completed" — and the session comes up
   * with an empty plugin list and no error anywhere.
   *
   * The probe is free: `init` is emitted before any model call (it arrives even
   * with an invalid API key), so this spends no tokens. It also warms the
   * plugin cache, so the first real task doesn't pay the marketplace clone.
   */
  private async preflightPlugins(): Promise<void> {
    const expected = Object.entries(this.config.claude.enabledPlugins ?? {})
      .filter(([, enabled]) => enabled === true)
      .map(([key]) => key);
    if (expected.length === 0) return;

    const abortController = new AbortController();
    const loadedSources = new Set<string>();
    const loadedNames = new Set<string>();
    let sawInit = false;

    log.info("Verifying marketplace plugins", { plugins: expected });

    try {
      const q = this.client!.runQuery("", buildQueryOptions(this.config, { abortController }));
      for await (const msg of q as AsyncIterable<SDKMessageLike>) {
        if (msg.type === "system" && msg.subtype === "plugin_install" && msg.status === "failed") {
          log.warn("Marketplace install reported a failure", {
            marketplace: msg.name,
            error: msg.error,
          });
        }
        if (msg.type === "system" && msg.subtype === "init") {
          sawInit = true;
          const loaded = (msg.plugins as Array<Record<string, unknown>> | undefined) ?? [];
          for (const plugin of loaded) {
            if (typeof plugin.source === "string") loadedSources.add(plugin.source);
            if (typeof plugin.name === "string") loadedNames.add(plugin.name);
          }
          break;
        }
      }
    } catch (err) {
      throw new Error(
        `Plugin preflight failed before the session started: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Tear down the probe subprocess; we never need its turn.
      abortController.abort();
    }

    if (!sawInit) {
      throw new Error(
        "Plugin preflight ended without a session init message; plugins could not be verified.",
      );
    }

    // `source` is the exact "<plugin>@<marketplace>" key; fall back to the bare
    // plugin name for SDK builds that omit it from the init message.
    const missing = expected.filter((key) => {
      const pluginName = key.slice(0, key.lastIndexOf("@"));
      return !loadedSources.has(key) && !loadedNames.has(pluginName);
    });

    if (missing.length > 0) {
      throw new Error(
        `Configured plugin(s) did not load: ${missing.join(", ")}. ` +
        `Check that each marketplace source and ref/sha is correct and that the plugin name ` +
        `exists in that marketplace's manifest.`,
      );
    }

    log.info("Marketplace plugins verified", { plugins: expected });
  }


  async shutdown(): Promise<void> {
    // Stop what is running: a Claude process this provider spawned must not outlive it.
    await Promise.all([...this.turns.values()].map((t) => t.abort("shutdown").catch(() => undefined)));
    this.turns.clear();
    this.client = null;
    this.initialized = false;
    this.initializing = null;
    log.info("Provider shut down");
  }

  // ─── ProviderExecutor: a turn ─────────────────────────────────────────────

  async run(req: CoreRequest, run: CoreTaskRun): Promise<void> {
    await this.initialize();
    run.progress("Processing request...");

    const turn = new ClaudeTurn({
      config: this.config,
      client: this.client!,
      request: req,
      run,
      ...(this.customTransport ? { customTransport: this.customTransport } : {}),
      reuse: this.reuseSessions,
      interactive: this.interactive,
      ...(this.config.timeouts.steerAck !== undefined ? { steerAckMs: this.config.timeouts.steerAck } : {}),
    });
    this.turns.set(req.taskId, turn);
    try {
      await turn.run();
    } finally {
      if (this.turns.get(req.taskId) === turn) this.turns.delete(req.taskId);
    }
  }

  // ─── ProviderExecutor: steering, stop, sessions ───────────────────────────

  async steer(run: CoreTaskRun, message: CoreMessage): Promise<SteerOutcome> {
    const turn = this.turns.get(run.taskId);
    if (!turn) return { state: "rejected", reason: "no-active-turn" };
    return turn.steer(message);
  }

  async abort(info: TaskRunInfo, reason: AbortReason): Promise<AbortOutcome> {
    const turn = this.turns.get(info.taskId);
    // Still opening: nothing was started, and `run` does not start once its signal is aborted.
    if (!turn) return { stopped: "confirmed", session: "reusable" };
    return turn.abort(reason);
  }

  /**
   * A task the store thinks is active but that has no live run (the process restarted). A Claude process this provider spawned
   * died with it, so there is nothing running; the session stays on disk and the context binding resumes it.
   */
  async abortOrphan(_info: OrphanInfo): Promise<AbortOutcome> {
    return { stopped: "confirmed", session: "reusable" };
  }

  /** Does Claude still have this session? Cheap: the transcript's metadata. Never says `gone` (a missing summary is not proof). */
  async probeSession(session: SessionRef): Promise<SessionProbe> {
    const exists = this.client?.sessionExists;
    if (!exists) return "unknown";
    try {
      return (await exists.call(this.client, session.ref, this.config.claude.workingDirectory || undefined)) ? "alive" : "unknown";
    } catch {
      return "unknown";
    }
  }


  // ── Context Build ────────────────────────────────────────────────────────

  private contextPath(): string | null {
    const claude = this.config.claude;
    if (!claude.workingDirectory) return null;
    return join(claude.workingDirectory, claude.contextFile ?? "context.md");
  }

  async getContextContent(): Promise<string | null> {
    const p = this.contextPath();
    if (!p) return null;
    try {
      return await fsReadFile(p, "utf-8");
    } catch {
      return null;
    }
  }

  async buildContext(prompt?: string): Promise<string> {
    await this.initialize();

    const claude = this.config.claude;
    const contextPrompt =
      prompt ||
      claude.contextPrompt ||
      "Explore this repository. Describe its purpose, major modules, entry points, " +
      "build commands, test commands, runtime dependencies, and key architectural constraints. Be concise.";

    // Read-only turn: plan mode plus explicit mutation-tool denial.
    const options = buildQueryOptions(this.config, {});
    options.permissionMode = "plan";
    options.disallowedTools = [
      ...new Set([...(claude.disallowedTools ?? []), "Write", "Edit", "NotebookEdit", "Bash"]),
    ];
    options.resume = undefined;

    const q = this.client!.runQuery(contextPrompt, options);
    let finalText = "";
    for await (const msg of q as AsyncIterable<SDKMessageLike>) {
      if (msg.type === "result" && msg.subtype === "success" && typeof msg.result === "string") {
        finalText = msg.result;
      }
    }

    const p = this.contextPath();
    if (p && finalText) {
      await fsWriteFile(p, finalText, "utf-8");
    }
    return finalText;
  }

  private validateConfig(): void {
    const claude = this.config.claude;

    if (!claude.workingDirectory) {
      throw new Error(
        "claude.workingDirectory is required. Set it in config.json or export WORKSPACE_DIR.",
      );
    }

    const resolved = resolvePath(claude.workingDirectory);
    if (!existsSync(resolved)) {
      throw new Error(
        `claude.workingDirectory does not exist: "${resolved}". Ensure the path exists before starting the agent.`,
      );
    }
    if (!statSync(resolved).isDirectory()) {
      throw new Error(`claude.workingDirectory is not a directory: "${resolved}".`);
    }

    const mode = claude.permissionMode ?? "acceptEdits";
    // `default` prompts for edits and shell commands, so it needs somebody to answer: `interactions.mode: "ask"` (or auto-answer rules).
    if (!HEADLESS_PERMISSION_MODES.has(mode) && !(mode === "default" && this.interactive)) {
      throw new Error(
        `permissionMode "${mode}" is not supported for headless A2A operation — it requires an ` +
        `interactive approver. Use one of: acceptEdits, dontAsk, plan, bypassPermissions` +
        ` (or "default" with interactions.mode "ask" or autoAnswer rules).`,
      );
    }

    if (mode === "bypassPermissions" && claude.dangerouslyAllowBypassPermissions !== true) {
      throw new Error(
        'permissionMode "bypassPermissions" requires "dangerouslyAllowBypassPermissions": true. ' +
        "Only enable this inside an isolated container or VM.",
      );
    }
    if (mode === "bypassPermissions") {
      log.warn(
        "⚠️  permissionMode is bypassPermissions. Claude has unrestricted tool access. " +
        "Only use this inside an isolated container or VM.",
      );
    }

    if (claude.customSystemPrompt && claude.systemPromptAppend) {
      throw new Error(
        "customSystemPrompt and systemPromptAppend are mutually exclusive. Set only one.",
      );
    }

    if (claude.effort !== undefined && !VALID_EFFORT_LEVELS.has(claude.effort)) {
      throw new Error(
        `claude.effort "${String(claude.effort)}" is invalid. ` +
        "Use one of: low, medium, high, xhigh, max.",
      );
    }

    // Config can arrive from an untyped JSON file or CLAUDE_EFFORT, so the shape
    // is checked structurally rather than trusted from the type declaration.
    const thinking = claude.thinking as { type?: unknown; budgetTokens?: unknown } | undefined;
    if (thinking !== undefined) {
      if (
        typeof thinking !== "object" ||
        thinking === null ||
        Array.isArray(thinking) ||
        typeof thinking.type !== "string" ||
        !VALID_THINKING_TYPES.has(thinking.type)
      ) {
        throw new Error(
          'claude.thinking must be an object whose "type" is one of: adaptive, enabled, disabled.',
        );
      }
      if (
        thinking.budgetTokens !== undefined &&
        (typeof thinking.budgetTokens !== "number" ||
          !Number.isInteger(thinking.budgetTokens) ||
          thinking.budgetTokens <= 0)
      ) {
        throw new Error(
          `claude.thinking.budgetTokens must be a positive integer (got ${JSON.stringify(thinking.budgetTokens)}).`,
        );
      }
    }

    // Config can arrive from an untyped JSON file, so outputFormat's shape is
    // checked structurally rather than trusted from the type declaration.
    const outputFormat = claude.outputFormat as
      | { type?: unknown; schema?: unknown }
      | undefined;
    if (outputFormat !== undefined) {
      if (
        typeof outputFormat !== "object" ||
        outputFormat === null ||
        Array.isArray(outputFormat) ||
        typeof outputFormat.type !== "string" ||
        !VALID_OUTPUT_FORMAT_TYPES.has(outputFormat.type)
      ) {
        throw new Error(
          'claude.outputFormat must be an object whose "type" is "json_schema".',
        );
      }
      if (
        typeof outputFormat.schema !== "object" ||
        outputFormat.schema === null ||
        Array.isArray(outputFormat.schema)
      ) {
        throw new Error(
          "claude.outputFormat.schema must be a JSON Schema object.",
        );
      }
    }

    if (claude.settingSources && claude.settingSources.length > 0) {
      log.warn("settingSources is non-empty — host/project settings files will be loaded.", {
        settingSources: claude.settingSources,
      });
    }
  }

  private toClaudeMcpEntry(descriptor: SynthesizedMcpDescriptor): McpStdioServerConfig {
    return toClaudeMcpEntry(descriptor);
  }
}
