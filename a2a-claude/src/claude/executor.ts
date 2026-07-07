/**
 * Claude Executor — A2A ↔ Claude Agent SDK Bridge
 *
 * Implements AgentExecutor to handle A2A task requests by running them through
 * @anthropic-ai/claude-agent-sdk queries. Supports multi-turn continuity by
 * resuming Claude sessions per contextId, serialized execution per context,
 * AbortController + interrupt() cancellation, memory materialization,
 * A2A sub-agent bootstrapping, and sideband events.
 */

import { existsSync, statSync } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { v4 as uuidv4 } from "uuid";

import type { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";

import type { AgentConfig, McpStdioServerConfig } from "../config/types.js";
import { createClaudeClient, buildQueryOptions } from "./client-factory.js";
import type { ClaudeClientLike, SDKMessageLike } from "./client-factory.js";
import { SessionManager } from "./session-manager.js";
import { EventMapper, sanitizeMessage } from "./event-mapper.js";
import { validateMcpServers, toClaudeMcpEntry } from "./mcp-adapter.js";
import { CLAUDE_BACKEND_PATHS } from "./backend-paths.js";
import { extractUserText } from "./prompt-builder.js";

import {
  resolveTransport,
  AgentEventEmitter,
  materializeMemory,
  bootstrapSubAgents,
  publishTask,
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
} from "@a2a-wrapper/core";
import type { EventTransport, EventTransportFn, SynthesizedMcpDescriptor } from "@a2a-wrapper/core";

import { logger } from "../utils/logger.js";

const log = logger.child("executor");

const VALID_PERMISSION_MODES = new Set(["acceptEdits", "dontAsk", "plan", "bypassPermissions"]);

export class ClaudeExecutor implements AgentExecutor {
  private readonly config: Required<AgentConfig>;
  private readonly clientFactory: (config: Required<AgentConfig>) => ClaudeClientLike;
  private client: ClaudeClientLike | null = null;
  private sessionManager: SessionManager | null = null;
  private initialized = false;

  /** Optional custom event transport supplied via programmatic API. */
  public customTransport?: EventTransport | EventTransportFn;

  constructor(
    config: Required<AgentConfig>,
    clientFactory: (config: Required<AgentConfig>) => ClaudeClientLike = createClaudeClient,
  ) {
    this.config = config;
    this.clientFactory = clientFactory;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;

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

    // Sub-agents bootstrap — merge the bridge entry into config.mcp before
    // any query options are built.
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

    // Validate user MCP entries (the reserved bridge key is exempt by
    // validating the user-supplied map minus the bridge entry).
    const userMcp = { ...(this.config.mcp ?? {}) };
    delete userMcp["a2a-subagents"];
    validateMcpServers(userMcp);

    this.client = this.clientFactory(this.config);
    log.info("Claude client constructed", {
      workingDirectory: this.config.claude.workingDirectory,
      permissionMode: this.config.claude.permissionMode,
      mcpServers: Object.keys(this.config.mcp || {}),
    });

    this.sessionManager = new SessionManager(this.config);
    this.sessionManager.startCleanup(
      this.config.session.cleanupInterval ?? 300_000,
      this.config.session.ttl ?? 3_600_000,
    );

    this.initialized = true;
    log.info("Executor initialized");
  }

  async shutdown(): Promise<void> {
    if (this.sessionManager) {
      this.sessionManager.stopCleanup();
      this.sessionManager = null;
    }
    this.client = null;
    this.initialized = false;
    log.info("Executor shut down");
  }

  // ── Task Execution ───────────────────────────────────────────────────────

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    await this.initialize();

    const agentId = this.config.agentCard.name.toLowerCase().replace(/\s+/g, "-");
    const transport = resolveTransport(this.config.events, bus, taskId, contextId, this.customTransport);
    const emitter = new AgentEventEmitter({
      agentId,
      agentName: this.config.agentCard.name,
      traceId: contextId || uuidv4(),
      transport,
    });
    const mapper = new EventMapper(emitter, this.config);

    try {
      if (!task) {
        publishTask(bus, taskId, contextId);
        publishStatus(bus, taskId, contextId, "submitted");
      }

      const session = this.sessionManager!.getOrCreate(contextId);
      const promptText = extractUserText(userMessage);
      log.info("Executing task", { taskId, contextId, promptLen: promptText.length });

      const abortController = new AbortController();
      this.sessionManager!.trackExecution(taskId, contextId, abortController);

      const turnFn = async (): Promise<void> => {
        let timedOut = false;
        const promptTimeout = this.config.timeouts.prompt ?? 600_000;
        const timer = setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, promptTimeout);

        try {
          publishStatus(bus, taskId, contextId, "working", "Processing request...");

          const options = buildQueryOptions(this.config, {
            resume: session.sessionId ?? undefined,
            abortController,
          });
          const q = this.client!.runQuery(promptText, options);
          this.sessionManager!.attachQuery(taskId, q);

          let finalText = "";
          let resultError: string | null = null;
          const streamArtifactId = `response-${taskId}`;
          let streamArtifactStarted = false;
          const streaming = this.config.features.streamArtifactChunks === true;

          for await (const msg of q as AsyncIterable<SDKMessageLike>) {
            if (msg.type === "system" && msg.subtype === "init" && session.sessionId === null) {
              if (typeof msg.session_id === "string") session.sessionId = msg.session_id;
            }

            // Safety-system refusal with no fallback model → fail the task
            // with a generic message (spec §4.4). Never echo refusal details.
            if (msg.type === "system" && msg.subtype === "model_refusal_no_fallback") {
              resultError = "Request declined by model safety system.";
            }

            if (streaming && msg.type === "stream_event" && msg.parent_tool_use_id == null) {
              const event = msg.event as Record<string, unknown> | undefined;
              const delta = event?.delta as Record<string, unknown> | undefined;
              if (event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
                streamArtifactStarted = true;
                publishStreamingChunk(bus, taskId, contextId, streamArtifactId, delta.text);
              }
            }

            if (msg.type === "result") {
              if (msg.subtype === "success" && typeof msg.result === "string") {
                finalText = msg.result;
              } else if (msg.subtype !== "success") {
                const reasons: Record<string, string> = {
                  error_max_turns: "Turn limit reached (max_turns).",
                  error_max_budget_usd: "Budget limit reached (max_budget_usd).",
                  error_during_execution: "Error during execution.",
                  error_max_structured_output_retries: "Structured output retries exhausted.",
                };
                resultError = reasons[String(msg.subtype)] ?? `Execution failed (${String(msg.subtype)}).`;
              }
            }

            mapper.handleMessage(msg);
          }

          if (resultError) {
            publishStatus(bus, taskId, contextId, "failed", sanitizeMessage(resultError), true);
            bus.finished();
            return;
          }

          if (streaming && streamArtifactStarted) {
            publishLastChunkMarker(bus, taskId, contextId, streamArtifactId, finalText);
          } else {
            publishFinalArtifact(bus, taskId, contextId, finalText);
          }

          publishStatus(bus, taskId, contextId, "completed", undefined, true);
          bus.finished();
        } catch (err) {
          const isAbort =
            err instanceof Error &&
            (err.name === "AbortError" || err.message.includes("abort") || err.message.includes("canceled"));

          if (isAbort && timedOut) {
            const msg = `Prompt timed out after ${this.config.timeouts.prompt ?? 600_000}ms.`;
            log.error("Task execution timed out", { taskId });
            publishStatus(bus, taskId, contextId, "failed", msg, true);
            bus.finished();
          } else if (isAbort) {
            log.info("Task execution aborted", { taskId });
            // cancelTask already published the canceled status
          } else {
            const msg = sanitizeMessage(err instanceof Error ? err.message : String(err));
            log.error("Task execution failed", { taskId, error: msg });
            publishStatus(bus, taskId, contextId, "failed", msg, true);
            bus.finished();
          }
        } finally {
          clearTimeout(timer);
          this.sessionManager?.untrackExecution(taskId);
        }
      };

      session.executionQueue = session.executionQueue.then(turnFn).catch(() => {});
      await session.executionQueue;
    } catch (outerErr) {
      const msg = sanitizeMessage(outerErr instanceof Error ? outerErr.message : String(outerErr));
      log.error("Executor outer error", { taskId, error: msg });
      publishStatus(bus, taskId, contextId, "failed", msg, true);
      bus.finished();
      this.sessionManager?.untrackExecution(taskId);
    }
  }

  // ── Cancellation ─────────────────────────────────────────────────────────

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    log.info("Cancel requested", { taskId });

    const execution = this.sessionManager?.getExecution(taskId);
    if (!execution) {
      log.debug("No active execution found for cancellation", { taskId });
      return;
    }

    execution.abortController.abort();
    if (execution.query) {
      execution.query.interrupt().catch(() => {});
    }
    publishStatus(bus, taskId, execution.contextId, "canceled", undefined, true);
    bus.finished();
    this.sessionManager?.untrackExecution(taskId);
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

  // ── Helpers ──────────────────────────────────────────────────────────────

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
    if (!VALID_PERMISSION_MODES.has(mode)) {
      throw new Error(
        `permissionMode "${mode}" is not supported for headless A2A operation — it requires an ` +
        `interactive approver. Use one of: acceptEdits, dontAsk, plan, bypassPermissions.`,
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
