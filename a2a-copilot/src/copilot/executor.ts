/**
 * Copilot Executor — A2A ↔ GitHub Copilot SDK Bridge
 *
 * Orchestrates Copilot SDK sessions to handle A2A task requests.
 * Supports streaming responses, MCP server integration, multi-turn
 * conversations, system prompts, and context building.
 */

import type { Message as A2AMessage } from "@a2a-js/sdk";
import type { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import { CopilotClient, approveAll, RuntimeConnection } from "@github/copilot-sdk";
import { v4 as uuidv4 } from "uuid";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentConfig, McpStdioServerConfig } from "../config/types.js";
import { SessionManager, type CopilotSession } from "./session-manager.js";
import { McpEvidenceHooks } from "./mcp-hooks.js";
import {
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
  publishTask,
  publishTraceArtifact,
  extractUserText,
  materializeMemory,
  WELL_KNOWN_PATHS,
  bootstrapSubAgents,
  LlmUsageAccumulator,
  createExecutionObservability,
  applyUsageSummaryToActiveSpan,
  annotateSessionOnTaskSpan,
  buildCopilotTelemetryOptions,
  shouldPropagateCopilotTraceContext,
  createCopilotTraceContextProvider,
} from "@a2a-wrapper/core";
import type {
  EventTransport,
  EventTransportFn,
  SynthesizedMcpDescriptor,
  UsageCallRecord,
  ContextWindowSnapshot,
  UsageTelemetryData,
} from "@a2a-wrapper/core";
import { createDeferred, type Deferred } from "../utils/deferred.js";
import { logger } from "../utils/logger.js";

const log = logger.child("executor");

/**
 * Upper bound on how long a terminal lifecycle event (`agent_finished` /
 * `agent_error`) may delay task completion. The event is awaited so the usage
 * record reaches an HTTP collector *before* the caller sees the task finish
 * (a caller that reads its usage ledger right after the result would otherwise
 * race the POST), but a slow or unreachable collector must never stall tasks.
 */
const TERMINAL_EMIT_TIMEOUT_MS = 2_000;

/**
 * Upper bound on how long `cancelTask` waits for the SDK to acknowledge
 * `session.abort()`. A hung abort must not hang the A2A cancel request; on
 * timeout the session is discarded instead (see {@link CopilotExecutor.cancelTask}).
 */
const ABORT_TIMEOUT_MS = 5_000;

/** Per-task state shared between `execute` and `cancelTask`. */
interface RunState {
  contextId: string;
  /** Set once the session is resolved; undefined while still being created. */
  session?: CopilotSession;
  /** `cancelTask` has claimed this run: `execute` must publish nothing more. */
  canceled: boolean;
  /** `execute` has begun publishing its terminal result; a late cancel is a no-op. */
  finalizing: boolean;
  /** Resolved by `cancelTask` so a parked `execute` wakes up immediately. */
  cancelSignal: Deferred<void>;
}

/**
 * Heuristic: detect when an assistant "response" is actually a tool call
 * serialized as plain text. Models without proper native function-calling
 * support (common with small/local Ollama models) print tool calls into the
 * text channel as JSON like `{"name":"view","arguments":{...}}` instead of
 * using the structured tool-call protocol the CLI expects.
 *
 * Returns true only for a JSON object that has a string `name` plus an
 * `arguments`/`parameters` object — the canonical OpenAI tool-call shape —
 * so ordinary JSON answers from the model are not misclassified.
 */
function looksLikeRawToolCall(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  const hasName = typeof obj.name === "string";
  const hasArgs =
    (typeof obj.arguments === "object" && obj.arguments !== null) ||
    (typeof obj.parameters === "object" && obj.parameters !== null);
  return hasName && hasArgs;
}

export class CopilotExecutor implements AgentExecutor {
  private readonly config: Required<AgentConfig>;
  private client: CopilotClient | null = null;
  private sessionManager: SessionManager | null = null;
  /** taskId → in-flight run state, shared by execute() and cancelTask(). */
  private readonly runs = new Map<string, RunState>();
  private mcpHooks: McpEvidenceHooks | null = null;
  private initialized = false;
  /** Optional custom event transport supplied via programmatic API. */
  public customTransport?: EventTransport | EventTransportFn;

  constructor(config: Required<AgentConfig>) {
    this.config = config;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;

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

    // Sub-agents bootstrap — synthesize the a2a-mcp-skillmap MCP entry from
    // the operator's `subAgents` config and merge it into `this.config.mcp`
    // before any MCP-using code (the Copilot client / sessions) reads it.
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

    // Create Copilot client — SDK 1.0.0 uses RuntimeConnection factories
    // instead of the flat options object from 0.2.x.
    const clientOpts: Record<string, unknown> = {};

    if (this.config.copilot.cliUrl) {
      // Connect to a pre-running CLI server (Docker, CI, remote)
      clientOpts.connection = RuntimeConnection.forUri(this.config.copilot.cliUrl);
    } else {
      // Spawn the CLI binary managed by this process (default path)
      // workingDirectory sets the cwd for the spawned binary.
      if (this.config.copilot.workspaceDirectory) {
        clientOpts.workingDirectory = this.config.copilot.workspaceDirectory;
      }
      // GitHub PAT for auth (required in Docker where `gh` CLI is unavailable)
      if (this.config.copilot.githubToken) {
        clientOpts.gitHubToken = this.config.copilot.githubToken;
      }
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

    this.client = new CopilotClient(clientOpts as any);
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

    this.mcpHooks = new McpEvidenceHooks();

    // Session manager — pass hooks so all sessions capture MCP evidence
    this.sessionManager = new SessionManager(this.client, this.config, this.mcpHooks);
    this.sessionManager.startCleanup();

    this.initialized = true;
    log.info("Executor initialized", {
      model: this.config.copilot.model,
      mcpServers: Object.keys(this.config.mcp || {}),
    });
  }

  async shutdown(): Promise<void> {
    if (this.sessionManager) {
      await this.sessionManager.shutdown();
      this.sessionManager = null;
    }
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    this.initialized = false;
    log.info("Executor shut down");
  }

  // ── Context Build ───────────────────────────────────────────────────────

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
    const mcpCfg = this.config.mcp;
    if (mcpCfg && Object.keys(mcpCfg).length > 0) {
      const mcpServers: Record<string, unknown> = {};
      for (const [name, serverCfg] of Object.entries(mcpCfg)) {
        if ("enabled" in serverCfg && serverCfg.enabled === false) continue;
        if (serverCfg.type === "http") {
          mcpServers[name] = {
            type: "http",
            url: serverCfg.url,
            tools: ["*"],
            ...(serverCfg.headers ? { headers: serverCfg.headers } : {}),
          };
        } else if (serverCfg.type === "sse") {
          mcpServers[name] = {
            type: "sse",
            url: serverCfg.url,
            tools: ["*"],
            ...(serverCfg.headers ? { headers: serverCfg.headers } : {}),
          };
        } else if (serverCfg.type === "stdio") {
          mcpServers[name] = {
            type: "stdio",
            command: serverCfg.command,
            args: serverCfg.args ?? [],
            tools: ["*"],
            ...(serverCfg.env ? { env: serverCfg.env } : {}),
          };
        }
      }
      if (Object.keys(mcpServers).length > 0) {
        opts.mcpServers = mcpServers;
      }
    }

    // Auto-approve MCP tool permissions for headless context building
    opts.onPermissionRequest = approveAll;

    // Custom LLM provider (BYOK) — must be forwarded here too since buildContext
    // creates its own session directly rather than going through SessionManager.
    if (this.config.copilot.provider) {
      const p = this.config.copilot.provider;
      const providerOpt: Record<string, unknown> = { baseUrl: p.baseUrl };
      if (p.type) providerOpt.type = p.type;
      if (p.apiKey) providerOpt.apiKey = p.apiKey;
      if (p.bearerToken) providerOpt.bearerToken = p.bearerToken;
      if (p.wireApi) providerOpt.wireApi = p.wireApi;
      if (p.azure) providerOpt.azure = p.azure;
      opts.provider = providerOpt;
    }

    const session = await (this.client as any).createSession(opts);
    const sessionId = session.sessionId ?? "context-build";

    log.info("Building context", { sessionId, contextFile });

    const fullPrompt = contextPrompt;

    const response = await session.sendAndWait({ prompt: fullPrompt });
    // SDK 1.0.0: sendAndWait returns AssistantMessageEvent | undefined
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

  // ── Execute ─────────────────────────────────────────────────────────────

  async execute(ctx: RequestContext, rawBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    await this.initialize();

    // Per-task cancel state. Every event this turn publishes goes through a
    // guarded bus that drops everything once `cancelTask` has claimed the task,
    // so late events from the aborted turn can never reach a finished task.
    const run: RunState = {
      contextId,
      canceled: false,
      finalizing: false,
      cancelSignal: createDeferred<void>(),
    };
    const bus: ExecutionEventBus = {
      publish: (event) => { if (!run.canceled) rawBus.publish(event); },
      finished: () => { if (!run.canceled) rawBus.finished(); },
      on: (...a: any[]) => { (rawBus as any).on(...a); return bus; },
      off: (...a: any[]) => { (rawBus as any).off(...a); return bus; },
      once: (...a: any[]) => { (rawBus as any).once(...a); return bus; },
      removeAllListeners: (...a: any[]) => { (rawBus as any).removeAllListeners(...a); return bus; },
    } as ExecutionEventBus;

    const { emitter } = createExecutionObservability({
      agentName: this.config.agentCard.name,
      ctx,
      bus,
      events: this.config.events,
      customTransport: this.customTransport,
    });

    // Set MCP hooks context → trace artifacts flow via transport
    if (this.mcpHooks) {
      this.mcpHooks.setEmitter(emitter);
    }

    // ── Usage accumulator — one per execute() call, local scope only ──────
    const accumulator = new LlmUsageAccumulator();

    // Exactly one terminal lifecycle event (agent_finished | agent_error) per task.
    let lifecycleClosed = false;

    this.runs.set(taskId, run);
    try {
      // 1. Register task with the SDK's ResultManager, then emit submitted status.
      // The ResultManager requires a task event (kind: "task") before it will
      // accept status-update or artifact-update events for new tasks.
      if (!task) {
        publishTask(bus, taskId, contextId);
        publishStatus(bus, taskId, contextId, "submitted");
      }

      // 2. Working
      publishStatus(bus, taskId, contextId, "working", "Processing request...");

      // Lifecycle bookend, delivered through the configured transport (A2A sideband
      // artifact by default, or the HTTP/custom transport) — see issue #56.
      emitter.emit("agent_started", { backend: "copilot" });

      // 3. Get or create Copilot session
      const { sessionId, session, isNew } = await this.sessionManager!.getOrCreate(contextId);
      this.sessionManager!.trackTask(taskId, sessionId, contextId);
      run.session = session;
      // Canceled while the session was being created: nothing was sent yet,
      // so there is nothing to abort — just don't start the turn.
      if (run.canceled) {
        lifecycleClosed = true;
        await this.finishCanceled(emitter, accumulator, taskId);
        return;
      }
      annotateSessionOnTaskSpan({ reused: !isNew, sessionId });

      // 4. Build prompt
      let promptText = extractUserText(userMessage);

      log.info("Sending prompt", { taskId, sessionId, len: promptText.length });

      // 5. Execute — streaming or non-streaming
      // session is typed as CopilotSession from SessionManager.getOrCreate()
      const copilotSession = session;
      let accumulatedText = "";
      let timedOut = false;
      const streamArtifactId = `response-${uuidv4()}`;

      if (this.config.copilot.streaming) {
        // Streaming mode: listen for all relevant events
        const { promise: done, resolve: resolveDone, reject: rejectDone } = createDeferred<void>();
        const unsubs: (() => void)[] = [];

        // ── Assistant message deltas (main response text) ──
        unsubs.push(copilotSession.on("assistant.message_delta", (event: any) => {
          const delta = event?.data?.deltaContent ?? "";
          if (delta) {
            accumulatedText += delta;
            if (this.config.features.streamArtifactChunks) {
              publishStreamingChunk(bus, taskId, contextId, streamArtifactId, delta);
            }
          }
        }));

        // ── Thinking / Reasoning deltas → emit as trace.thought sideband artifacts ──
        let reasoningAccumulator = "";
        unsubs.push(copilotSession.on("assistant.reasoning_delta", (event: any) => {
          const delta = event?.data?.deltaContent ?? "";
          if (delta) {
            reasoningAccumulator += delta;
            log.debug("Reasoning delta", { taskId, len: delta.length });
          }
        }));

        // ── Final assistant message (safety net if deltas were empty) ──
        unsubs.push(copilotSession.on("assistant.message", (event: any) => {
          const content = event?.data?.content ?? "";
          if (content && !accumulatedText) {
            // Only use if we didn't get anything from deltas
            accumulatedText = content;
          }
        }));

        // ── Reasoning complete → publish accumulated thought via transport ──
        unsubs.push(copilotSession.on("assistant.reasoning", (event: any) => {
          const content = event?.data?.content ?? reasoningAccumulator;
          if (content) {
            log.debug("Reasoning complete", { taskId, len: content.length });
            emitter.emit("thinking", { content });
            reasoningAccumulator = "";
          }
        }));

        // ── Intent classification ──
        unsubs.push(copilotSession.on("assistant.intent", (event: any) => {
          const intent = event?.data?.intent ?? "";
          if (intent) {
            log.debug("Intent", { taskId, intent });
            publishStatus(bus, taskId, contextId, "working", `Intent: ${intent}`);
          }
        }));

        // ── Tool execution start ──
        unsubs.push(copilotSession.on("tool.execution_start", (event: any) => {
          const toolName = event?.data?.toolName ?? event?.data?.mcpToolName ?? "unknown";
          log.info("Tool execution start", { taskId, toolName });
          publishStatus(bus, taskId, contextId, "working", `Executing ${toolName}...`);
        }));

        // ── Tool execution progress ──
        unsubs.push(copilotSession.on("tool.execution_progress", (event: any) => {
          const msg = event?.data?.progressMessage ?? "";
          if (msg) {
            publishStatus(bus, taskId, contextId, "working", msg);
          }
        }));

        // ── Tool execution complete ──
        unsubs.push(copilotSession.on("tool.execution_complete", (event: any) => {
          const toolCallId = event?.data?.toolCallId ?? "";
          const success = event?.data?.success ?? true;
          if (success) {
            log.info("Tool execution complete", { taskId, toolCallId });
            publishStatus(bus, taskId, contextId, "working", `Tool completed`);
          } else {
            const errMsg = event?.data?.error?.message ?? "Unknown error";
            log.warn("Tool execution failed", { taskId, toolCallId, error: errMsg });
            publishStatus(bus, taskId, contextId, "working", `Tool error: ${errMsg}`);
          }
        }));

        // ── Subagent lifecycle ──
        unsubs.push(copilotSession.on("subagent.started", (event: any) => {
          const name = event?.data?.agentDisplayName ?? event?.data?.agentName ?? "subagent";
          publishStatus(bus, taskId, contextId, "working", `Delegating to ${name}...`);
        }));

        unsubs.push(copilotSession.on("subagent.completed", (event: any) => {
          const name = event?.data?.agentName ?? "subagent";
          publishStatus(bus, taskId, contextId, "working", `${name} completed`);
        }));

        unsubs.push(copilotSession.on("subagent.failed", (event: any) => {
          const name = event?.data?.agentName ?? "subagent";
          const err = event?.data?.error ?? "Unknown error";
          publishStatus(bus, taskId, contextId, "working", `${name} failed: ${err}`);
        }));

        // ── Session error ──
        unsubs.push(copilotSession.on("session.error", (event: any) => {
          const msg = event?.data?.message ?? "Session error";
          // SDK may emit a timeout error from its internal sendAndWait —
          // treat as graceful completion if we have any accumulated content
          if (msg.toLowerCase().includes("timeout")) {
            log.warn("SDK session timeout (treating as completion)", { taskId, error: msg, hasContent: !!accumulatedText });
            timedOut = true;
            resolveDone();
          } else {
            log.error("Session error", { taskId, error: msg });
            rejectDone(new Error(msg));
          }
        }));

        // ── Session idle (completion signal) ──
        unsubs.push(copilotSession.on("session.idle", () => {
          resolveDone();
        }));

        // ── LLM usage tracking — assistant.usage ────────────────────────────
        unsubs.push(copilotSession.on("assistant.usage", (event: any) => {
          const d = event?.data ?? {};
          const callRecord: UsageCallRecord = {
            model:              d.model             ?? "",
            inputTokens:        d.inputTokens        ?? 0,
            outputTokens:       d.outputTokens       ?? 0,
            cacheReadTokens:    d.cacheReadTokens     ?? 0,
            cacheWriteTokens:   d.cacheWriteTokens    ?? 0,
            reasoningTokens:    d.reasoningTokens     ?? 0,
            durationMs:         d.duration            ?? 0,
            timeToFirstTokenMs: d.timeToFirstTokenMs  ?? null,
            cost:               d.cost               ?? null,
            apiEndpoint:        d.apiEndpoint         ?? null,
            initiator:          d.initiator           ?? null,
          };
          accumulator.record(callRecord);

          if (this.config.features.trackUsage) {
            try {
              publishTraceArtifact(bus, taskId, contextId, "trace.usage",
                callRecord as unknown as Record<string, unknown>);
            } catch (e) {
              log.warn("Failed to publish trace.usage artifact", { taskId, error: (e as Error).message });
            }
          }
        }));

        // ── LLM usage tracking — session.usage_info ────────────────────────
        unsubs.push(copilotSession.on("session.usage_info", (event: any) => {
          const d = event?.data ?? {};
          const snapshot: ContextWindowSnapshot = {
            currentTokens:          d.currentTokens,
            tokenLimit:             d.tokenLimit              ?? null,
            conversationTokens:     d.conversationTokens       ?? null,
            systemTokens:           d.systemTokens             ?? null,
            toolDefinitionsTokens:  d.toolDefinitionsTokens    ?? null,
            messagesLength:         d.messagesLength            ?? null,
          };
          accumulator.setContextWindow(snapshot);

          if (this.config.features.trackUsage) {
            try {
              emitter.emit("context_window", snapshot as unknown as Record<string, unknown>);
            } catch (e) {
              log.warn("Failed to emit context_window event", { taskId, error: (e as Error).message });
            }
          }
        }));

        // Set up timeout
        const timeoutMs = this.config.timeouts.prompt ?? 600_000;
        const timer = setTimeout(() => {
          log.warn("Prompt timeout — resolving with partial content", { taskId, timeoutMs, hasContent: !!accumulatedText });
          timedOut = true;
          resolveDone(); // Resolve gracefully — return partial content
        }, timeoutMs);

        try {
          // Use send() (fire-and-forget) in streaming mode — we manage completion
          // via session.idle event listener. sendAndWait has a 60s default timeout
          // that's too short for tool-heavy interactions.
          copilotSession.send({ prompt: promptText }).catch((e: Error) => {
            // send() itself can fail (connection error etc) — don't reject on timeout
            if (e.message?.toLowerCase().includes("timeout")) {
              log.warn("send() timeout — resolving with partial content", { taskId });
              timedOut = true;
              resolveDone();
            } else {
              rejectDone(e);
            }
          });

          await Promise.race([done, run.cancelSignal.promise]);
        } finally {
          clearTimeout(timer);
          for (const unsub of unsubs) {
            if (typeof unsub === "function") unsub();
          }
        }

        if (run.canceled) {
          lifecycleClosed = true;
          await this.finishCanceled(emitter, accumulator, taskId);
          return;
        }

        // If we timed out but have content, append a note
        if (timedOut && accumulatedText) {
          accumulatedText += "\n\n---\n*Response truncated: processing time limit reached.*";
        }
      } else {
        // Non-streaming: subscribe to usage events before sendAndWait
        const unsubUsage = copilotSession.on("assistant.usage", (event: any) => {
          const d = event?.data ?? {};
          const callRecord: UsageCallRecord = {
            model:              d.model             ?? "",
            inputTokens:        d.inputTokens        ?? 0,
            outputTokens:       d.outputTokens       ?? 0,
            cacheReadTokens:    d.cacheReadTokens     ?? 0,
            cacheWriteTokens:   d.cacheWriteTokens    ?? 0,
            reasoningTokens:    d.reasoningTokens     ?? 0,
            durationMs:         d.duration            ?? 0,
            timeToFirstTokenMs: d.timeToFirstTokenMs  ?? null,
            cost:               d.cost               ?? null,
            apiEndpoint:        d.apiEndpoint         ?? null,
            initiator:          d.initiator           ?? null,
          };
          accumulator.record(callRecord);

          if (this.config.features.trackUsage) {
            try {
              publishTraceArtifact(bus, taskId, contextId, "trace.usage",
                callRecord as unknown as Record<string, unknown>);
            } catch (e) {
              log.warn("Failed to publish trace.usage artifact", { taskId, error: (e as Error).message });
            }
          }
        });

        const unsubCtxWin = copilotSession.on("session.usage_info", (event: any) => {
          const d = event?.data ?? {};
          const snapshot: ContextWindowSnapshot = {
            currentTokens:          d.currentTokens,
            tokenLimit:             d.tokenLimit              ?? null,
            conversationTokens:     d.conversationTokens       ?? null,
            systemTokens:           d.systemTokens             ?? null,
            toolDefinitionsTokens:  d.toolDefinitionsTokens    ?? null,
            messagesLength:         d.messagesLength            ?? null,
          };
          accumulator.setContextWindow(snapshot);

          if (this.config.features.trackUsage) {
            try {
              emitter.emit("context_window", snapshot as unknown as Record<string, unknown>);
            } catch (e) {
              log.warn("Failed to emit context_window event", { taskId, error: (e as Error).message });
            }
          }
        });

        const timeoutMs = this.config.timeouts.prompt ?? 600_000;
        let promptTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, rej) => {
          promptTimer = setTimeout(() => rej(new Error(`Prompt timeout after ${timeoutMs}ms`)), timeoutMs);
        });

        try {
          const response = await Promise.race([
            copilotSession.sendAndWait({ prompt: promptText }, timeoutMs),
            timeout,
            run.cancelSignal.promise.then(() => undefined),
          ]);
          // SDK 1.0.0: sendAndWait returns AssistantMessageEvent | undefined
          accumulatedText = (response as any)?.data?.content ?? "";
        } catch (e) {
          // An abort() makes sendAndWait reject; that is the cancel, not a failure.
          if (!run.canceled) {
            if (!(e as Error).message.includes("timeout")) throw e;
            log.warn("Prompt timed out", { taskId, timeoutMs });
          }
        } finally {
          clearTimeout(promptTimer);
          unsubUsage();
          unsubCtxWin();
        }

        if (run.canceled) {
          lifecycleClosed = true;
          await this.finishCanceled(emitter, accumulator, taskId);
          return;
        }
      }

      // Fallback
      if (!accumulatedText) {
        accumulatedText = timedOut
          ? "The request timed out before a response was produced."
          : "No text response was returned.";
      }

      // BYOK guard: some local models (via Ollama / vLLM, etc.) do not properly
      // support the native function-calling protocol the Copilot CLI relies on.
      // Instead of emitting a structured tool call, they print the tool call as
      // plain text (e.g. `{"name":"view","arguments":{...}}`) and stop. Detect
      // that shape and replace it with an actionable message rather than leaking
      // raw tool-call JSON to the caller.
      if (this.config.copilot.provider && looksLikeRawToolCall(accumulatedText)) {
        log.warn("Model emitted a tool call as plain text — likely a model that lacks native tool-calling support", {
          taskId,
          model: this.config.copilot.model,
          preview: accumulatedText.slice(0, 120),
        });
        accumulatedText =
          "The configured model returned a tool call as plain text instead of a usable " +
          "response. This usually means the model does not fully support the native " +
          "function-calling (tool) protocol required by the agent runtime. Try a model " +
          "with robust tool-calling support (e.g. qwen3.6, llama3.3, mistral-nemo).";
      }

      // 6. Finalize — from here the task completes; a late cancel is a no-op.
      run.finalizing = true;
      if (this.config.features.streamArtifactChunks) {
        publishLastChunkMarker(bus, taskId, contextId, streamArtifactId, accumulatedText);
      } else {
        publishFinalArtifact(bus, taskId, contextId, accumulatedText);
      }

      // Tier 1 — inject usage summary into final completed event metadata
      let usageSummary: UsageTelemetryData | undefined;
      try {
        usageSummary = accumulator.summary();
        // OTel: task-span rollup only — never a second LLM span / token metric.
        // When backend OTel is on, gen_ai.usage.* is omitted (policy) so Tempo
        // SUMs of vendor LLM spans do not double-count with the parent.
        applyUsageSummaryToActiveSpan(usageSummary);
      } catch (e) {
        log.warn("accumulator.summary() failed, omitting x-usage from final event", {
          taskId,
          error: (e as Error).message,
        });
      }

      // Report the same summary that goes out as `x-usage` through the event
      // transport as well, so HTTP/custom collectors can account for worker usage
      // without intercepting the A2A exchange. `cost` is the provider-reported sum
      // and stays null when the provider reported none — it is never estimated.
      lifecycleClosed = true;
      await this.emitTerminal(emitter, "agent_finished", {
        backend: "copilot",
        usage: usageSummary ?? null,
      });

      publishStatus(
        bus,
        taskId,
        contextId,
        "completed",
        undefined,
        true,
        usageSummary ? { "x-usage": usageSummary } : undefined,
      );
      bus.finished();
      log.info("Task completed", { taskId, len: accumulatedText.length });

    } catch (error) {
      if (run.canceled) {
        // The failure is a side effect of the abort (cancelTask already
        // published `canceled`); don't report it as a task failure.
        log.info("Execution ended by cancellation", { taskId, error: (error as Error).message });
        if (!lifecycleClosed) {
          lifecycleClosed = true;
          await this.finishCanceled(emitter, accumulator, taskId);
        }
        return;
      }
      run.finalizing = true;
      const msg = (error as Error).message ?? String(error);
      const isConnErr = msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("connect") || msg.includes("socket");
      const isAuthErr = msg.includes("onPermissionRequest") || msg.toLowerCase().includes("permission") || msg.includes("handler is required");
      const cliUrl = this.config.copilot.cliUrl;
      const userMsg = isAuthErr
        ? "GITHUB_TOKEN not set. Run `gh auth login` or set GITHUB_TOKEN env var."
        : isConnErr && cliUrl
          ? `Cannot reach GitHub Copilot CLI server at ${cliUrl}. Is it running?`
          : `Error: ${msg}`;
      log.error("Execution failed", { taskId, error: msg });
      if (!lifecycleClosed) {
        lifecycleClosed = true;
        // Tokens spent before the failure still count toward accounting.
        await this.emitTerminal(emitter, "agent_error", {
          backend: "copilot",
          message: userMsg,
          usage: this.usageIfAny(accumulator),
        });
      }
      publishStatus(bus, taskId, contextId, "failed", userMsg, true);
      bus.finished();
    } finally {
      if (this.runs.get(taskId) === run) this.runs.delete(taskId);
      this.sessionManager!.untrackTask(taskId);
      this.mcpHooks?.clearEmitter();
    }
  }
  /**
   * Emit a terminal lifecycle event and wait for the transport to accept it,
   * but for no longer than {@link TERMINAL_EMIT_TIMEOUT_MS}.
   */
  private async emitTerminal(
    emitter: { emit(type: "agent_finished" | "agent_error", data: Record<string, unknown>): Promise<void> },
    type: "agent_finished" | "agent_error",
    data: Record<string, unknown>,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn("Event transport slow; not waiting further for terminal event", { type, timeoutMs: TERMINAL_EMIT_TIMEOUT_MS });
        resolve();
      }, TERMINAL_EMIT_TIMEOUT_MS);
    });
    try {
      await Promise.race([emitter.emit(type, data), cap]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Usage summary if any LLM call was recorded, otherwise null. Never throws. */
  private usageIfAny(accumulator: LlmUsageAccumulator): UsageTelemetryData | null {
    try {
      const summary = accumulator.summary();
      return summary.llmCalls > 0 ? summary : null;
    } catch {
      return null;
    }
  }

  /**
   * Cancel a running task: publish `canceled`, then abort the backend Copilot
   * turn (and wait for the abort, so the response means the turn has stopped).
   *
   * - Unknown / already finished task (or one that is already completing):
   *   a silent no-op, so repeated or late cancels are idempotent and never
   *   publish to a finished task.
   * - The run is claimed synchronously (`run.canceled`) before anything is
   *   awaited, so a completion racing this call cannot also publish a terminal
   *   state, and late SDK events are dropped by `execute`'s guarded bus.
   * - `session.abort()` stops the in-flight turn and keeps the session usable
   *   for the next message in the same context. If the abort fails or does not
   *   answer within {@link ABORT_TIMEOUT_MS}, the session is destroyed so the
   *   next message starts on a clean one instead of interleaving with the
   *   still-running turn.
   */
  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    log.info("Cancel requested", { taskId });
    const run = this.runs.get(taskId);
    if (!run || run.canceled || run.finalizing) {
      log.debug("No cancelable run for task", { taskId, known: !!run });
      return;
    }
    run.canceled = true;

    // Publish the terminal event BEFORE waking `execute` and before awaiting the
    // abort: once `execute` returns, the SDK closes the task's event bus, so a
    // `canceled` published after a slow abort() would be lost and the stored task
    // would stay "working" (tasks/cancel then fails with TaskNotCancelable).
    publishStatus(bus, taskId, run.contextId, "canceled", undefined, true);
    bus.finished();
    run.cancelSignal.resolve();

    if (run.session) {
      await this.abortSession(taskId, run.session, run.contextId);
    }
  }

  /** Abort the backend turn; fall back to discarding the session. Never throws. */
  private async abortSession(taskId: string, session: CopilotSession, contextId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.abort(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`abort timed out after ${ABORT_TIMEOUT_MS}ms`)), ABORT_TIMEOUT_MS);
        }),
      ]);
      log.info("Session turn aborted", { taskId, sessionId: session.sessionId });
    } catch (e) {
      log.warn("Abort failed; discarding session", { taskId, sessionId: session.sessionId, error: (e as Error).message });
      try {
        await this.sessionManager?.destroySession(contextId);
      } catch { /* best effort */ }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Close the lifecycle of a canceled run. `cancelTask` owns the A2A terminal
   * event; this only reports `agent_error` through the event transport so a
   * collector sees exactly one terminal event, with the usage spent so far.
   */
  private async finishCanceled(
    emitter: { emit(type: "agent_finished" | "agent_error", data: Record<string, unknown>): Promise<void> },
    accumulator: LlmUsageAccumulator,
    taskId: string,
  ): Promise<void> {
    log.info("Execution canceled", { taskId });
    await this.emitTerminal(emitter, "agent_error", {
      backend: "copilot",
      message: "Task canceled",
      usage: this.usageIfAny(accumulator),
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Translate a wrapper-agnostic {@link SynthesizedMcpDescriptor} into the
   * stdio MCP entry shape consumed by the Copilot SDK / this wrapper's
   * resolved `mcp` map. Used after {@link bootstrapSubAgents} returns the
   * canonical descriptor so the entry can be merged under
   * `descriptor.key` (the reserved `a2a-subagents` key).
   */
  private toCopilotMcpEntry(
    descriptor: SynthesizedMcpDescriptor,
  ): McpStdioServerConfig {
    return {
      type: "stdio",
      command: descriptor.command,
      args: descriptor.args,
      env: descriptor.env,
      enabled: true,
    };
  }

}
