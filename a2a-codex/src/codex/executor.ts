/**
 * Codex Executor — A2A ↔ OpenAI Codex SDK Bridge
 *
 * Implements A2AExecutor to handle A2A task requests by running them through
 * @openai/codex-sdk threads. Supports multi-turn context continuity,
 * serialized execution per context, AbortController-based cancellation,
 * memory materialization, A2A sub-agent bootstrapping, and sideband events.
 */

import { existsSync, statSync } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import type { Message as A2AMessage } from "@a2a-js/sdk";
import type { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";

import type { AgentConfig, McpStdioServerConfig } from "../config/types.js";
import { createCodexClient } from "./client-factory.js";
import type { CodexClientLike } from "./client-factory.js";
import { SessionManager } from "./session-manager.js";
import { EventMapper, sanitizeMessage } from "./event-mapper.js";
import { validateMcpServers, toCodexMcpEntry } from "./mcp-adapter.js";
import { CODEX_BACKEND_PATHS } from "./backend-paths.js";
import { extractUserText } from "./prompt-builder.js";

import {
  materializeMemory,
  bootstrapSubAgents,
  publishTask,
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
  createExecutionObservability,
  LlmUsageAccumulator,
  applyUsageSummaryToActiveSpan,
  applyUsageCallToActiveSpan,
} from "@a2a-wrapper/core";
import type {
  EventTransport,
  EventTransportFn,
  SynthesizedMcpDescriptor,
  UsageCallRecord,
} from "@a2a-wrapper/core";

import { logger } from "../utils/logger.js";

const log = logger.child("executor");

/** Map Codex turn.completed usage → core UsageCallRecord. */
function codexUsageToCallRecord(
  usage: Record<string, unknown>,
  modelFallback: string | undefined,
): UsageCallRecord {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    model: (typeof usage.model === "string" ? usage.model : undefined) || modelFallback || "",
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cached_input_tokens),
    cacheWriteTokens: 0,
    reasoningTokens: num(usage.reasoning_output_tokens),
    durationMs: 0,
    timeToFirstTokenMs: null,
    cost: null,
    apiEndpoint: null,
    initiator: "codex",
  };
}

export class CodexExecutor implements AgentExecutor {
  private readonly config: Required<AgentConfig>;
  private client: CodexClientLike | null = null;
  private sessionManager: SessionManager | null = null;
  private initialized = false;

  /** Optional custom event transport supplied via programmatic API. */
  public customTransport?: EventTransport | EventTransportFn;

  constructor(config: Required<AgentConfig>) {
    this.config = config;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // 1. Validate configuration
    this.validateConfig();

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

    // 3. Sub-agents bootstrap — synthesize the a2a-mcp-skillmap MCP entry and
    //    merge it into config.mcp before client construction (MCP is baked at
    //    SDK construction time and cannot be registered at runtime).
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

    // 4. Validate MCP after sub-agent merge (so the bridge entry is visible)
    validateMcpServers(this.config.mcp ?? {});

    // 5. Construct Codex client (MCP config baked in here)
    this.client = createCodexClient(this.config);
    log.info("Codex client constructed", {
      workingDirectory: this.config.codex.workingDirectory,
      sandboxMode: this.config.codex.sandboxMode,
      mcpServers: Object.keys(this.config.mcp || {}),
    });

    // 6. Session manager
    this.sessionManager = new SessionManager(this.client, this.config);
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

    const { emitter } = createExecutionObservability({
      agentName: this.config.agentCard.name,
      ctx,
      bus,
      events: this.config.events,
      customTransport: this.customTransport,
    });
    const mapper = new EventMapper(emitter, this.config);

    try {
      // Register task with SDK ResultManager before any status events
      if (!task) {
        publishTask(bus, taskId, contextId);
        publishStatus(bus, taskId, contextId, "submitted");
      }

      // Get or create the Codex session for this context
      const threadOpts = this.sessionManager!.buildThreadOptions();
      const session = this.sessionManager!.getOrCreate(contextId, () =>
        this.client!.startThread(threadOpts),
      );

      // Extract user prompt
      const promptText = extractUserText(userMessage);
      log.info("Executing task", { taskId, contextId, promptLen: promptText.length });

      // Serialize execution — queue behind any in-progress turn for this context
      const abortController = new AbortController();
      this.sessionManager!.trackExecution(taskId, contextId, abortController);

      const turnFn = async (): Promise<void> => {
        const accumulator = new LlmUsageAccumulator();
        try {
          publishStatus(bus, taskId, contextId, "working", "Processing request...");

          let finalText = "";
          // Track agent_message snapshots by item ID to detect completion
          const agentMessageText = new Map<string, string>();
          const streamArtifactId = `response-${taskId}`;
          let streamArtifactStarted = false;

          const { events } = await session.thread.runStreamed(promptText, {
            signal: abortController.signal,
          });

          for await (const event of events) {
            // Capture thread_id from first event
            if (event.type === "thread.started" && session.threadId === null) {
              const tid = mapper.handleEvent(event);
              if (tid) session.threadId = tid;
              continue;
            }

            // Accumulate agent_message text across item.updated snapshots
            if (
              (event.type === "item.updated" || event.type === "item.completed") &&
              (event.item as Record<string, unknown>)?.type === "agent_message"
            ) {
              const item = event.item as Record<string, unknown>;
              const itemId = item.id as string;
              const newText = (item.text as string) ?? "";
              const prevText = agentMessageText.get(itemId) ?? "";

              if (this.config.features.streamArtifactChunks && newText.length > prevText.length) {
                const delta = newText.substring(prevText.length);
                if (!streamArtifactStarted) {
                  streamArtifactStarted = true;
                }
                publishStreamingChunk(bus, taskId, contextId, streamArtifactId, delta);
              }

              agentMessageText.set(itemId, newText);

              if (event.type === "item.completed") {
                finalText = newText;
              }
            }

            if (event.type === "turn.completed" && event.usage) {
              const call = codexUsageToCallRecord(
                event.usage as Record<string, unknown>,
                this.config.codex.model,
              );
              accumulator.record(call);
              // Optional: otel.annotateUsageCalls — per-call span events (noisy; off by default).
              applyUsageCallToActiveSpan(call);
            }

            mapper.handleEvent(event);
          }

          // Publish artifact
          if (this.config.features.streamArtifactChunks && streamArtifactStarted) {
            publishLastChunkMarker(bus, taskId, contextId, streamArtifactId, finalText);
          } else {
            publishFinalArtifact(bus, taskId, contextId, finalText);
          }

          const usageSummary = accumulator.summary();
          applyUsageSummaryToActiveSpan(usageSummary);
          publishStatus(
            bus,
            taskId,
            contextId,
            "completed",
            undefined,
            true,
            { "x-usage": usageSummary },
          );
          bus.finished();

        } catch (err) {
          const isAbort =
            err instanceof Error &&
            (err.name === "AbortError" || err.message.includes("abort") || err.message.includes("canceled"));

          if (isAbort) {
            log.info("Task execution aborted", { taskId });
            // cancelTask already published the canceled status
          } else {
            const msg = sanitizeMessage(err instanceof Error ? err.message : String(err));
            log.error("Task execution failed", { taskId, error: msg });
            publishStatus(bus, taskId, contextId, "failed", msg, true);
            bus.finished();
          }
        } finally {
          this.sessionManager?.untrackExecution(taskId);
        }
      };

      // Chain onto the context's serialization queue
      session.executionQueue = session.executionQueue
        .then(turnFn)
        .catch(() => {});

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
    publishStatus(bus, execution.contextId, execution.contextId, "canceled", undefined, true);
    bus.finished();
    this.sessionManager?.untrackExecution(taskId);
  }

  // ── Context Build ────────────────────────────────────────────────────────

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

  // ── Helpers ──────────────────────────────────────────────────────────────

  private validateConfig(): void {
    const codex = this.config.codex;

    if (!codex.workingDirectory) {
      throw new Error(
        "codex.workingDirectory is required. Set it in config.json or export WORKSPACE_DIR.",
      );
    }

    const resolved = resolvePath(codex.workingDirectory);
    if (!existsSync(resolved)) {
      throw new Error(
        `codex.workingDirectory does not exist: "${resolved}". ` +
        "Ensure the path exists before starting the agent.",
      );
    }
    if (!statSync(resolved).isDirectory()) {
      throw new Error(
        `codex.workingDirectory is not a directory: "${resolved}".`,
      );
    }

    if (codex.approvalPolicy === "on-request") {
      throw new Error(
        'approvalPolicy "on-request" requires interactive human input, which is incompatible ' +
        'with headless A2A execution. Use "never" (default) for automated operation.',
      );
    }

    const validSandboxModes = ["read-only", "workspace-write", "danger-full-access"];
    if (codex.sandboxMode && !validSandboxModes.includes(codex.sandboxMode)) {
      throw new Error(
        `Invalid sandboxMode "${codex.sandboxMode}". ` +
        `Supported values: ${validSandboxModes.join(", ")}.`,
      );
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
