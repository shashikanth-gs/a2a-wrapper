/**
 * Copilot Executor — A2A ↔ GitHub Copilot SDK Bridge
 *
 * Orchestrates Copilot SDK sessions to handle A2A task requests.
 * Supports streaming responses, MCP server integration, multi-turn
 * conversations, system prompts, and context building.
 */

import type { Message as A2AMessage } from "@a2a-js/sdk";
import type { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import { CopilotClient } from "@github/copilot-sdk";
import { v4 as uuidv4 } from "uuid";
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentConfig } from "../config/types.js";
import { SessionManager } from "./session-manager.js";
import { McpEvidenceHooks } from "./mcp-hooks.js";
import {
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
  publishThoughtArtifact,
  publishTask,
} from "./event-publisher.js";
import { createDeferred } from "../utils/deferred.js";
import { logger } from "../utils/logger.js";

const log = logger.child("executor");

export class CopilotExecutor implements AgentExecutor {
  private readonly config: Required<AgentConfig>;
  private client: CopilotClient | null = null;
  private sessionManager: SessionManager | null = null;
  private mcpHooks: McpEvidenceHooks | null = null;
  private initialized = false;

  constructor(config: Required<AgentConfig>) {
    this.config = config;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create Copilot client
    const clientOpts: Record<string, unknown> = {};
    if (this.config.copilot.cliUrl) {
      clientOpts.cliUrl = this.config.copilot.cliUrl;
    }
    // GitHub PAT for auth (required in Docker where `gh` CLI is unavailable)
    if (this.config.copilot.githubToken) {
      clientOpts.githubToken = this.config.copilot.githubToken;
    }
    // Start the CLI process in the workspace directory so file tools resolve correctly
    if (this.config.copilot.workspaceDirectory) {
      clientOpts.cwd = this.config.copilot.workspaceDirectory;
    }

    this.client = new CopilotClient(clientOpts as any);
    try {
      await (this.client as any).start();
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const isNotFound = msg.includes("ENOENT") || msg.includes("not found") || msg.includes("spawn");
      const isAuth = msg.toLowerCase().includes("auth") || msg.toLowerCase().includes("login") || msg.toLowerCase().includes("token") || msg.toLowerCase().includes("unauthorized") || msg.includes("onPermissionRequest handler");
      if (isNotFound) {
        throw new Error(
          "GitHub Copilot CLI not found. Install it with: gh extension install github/gh-copilot\n" +
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
      await (this.client as any).stop();
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
          mcpServers[name] = { type: "http", url: serverCfg.url, tools: ["*"] };
        } else if (serverCfg.type === "sse") {
          mcpServers[name] = { type: "sse", url: serverCfg.url, tools: ["*"] };
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

    const session = await (this.client as any).createSession(opts);
    const sessionId = session.sessionId ?? "context-build";

    log.info("Building context", { sessionId, contextFile });

    const fullPrompt = contextPrompt;

    const response = await session.sendAndWait({ prompt: fullPrompt });
    const responseText = response?.data?.content ?? "";

    await session.destroy();

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

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    await this.initialize();

    // Extract trace context from A2A request metadata (injected by orchestrator)
    const traceCtx = this.extractTraceContext(ctx);
    const agentId = this.config.agentCard.name.toLowerCase().replace(/\s+/g, "-");
    const agentName = this.config.agentCard.name;

    // Set MCP hooks context → trace artifacts flow via A2A sideband
    if (this.mcpHooks) {
      this.mcpHooks.setContext({
        bus,
        taskId,
        contextId,
        agentId,
        agentName,
        traceId: traceCtx.traceId,
      });
    }

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

      // 3. Get or create Copilot session
      const { sessionId, session, isNew } = await this.sessionManager!.getOrCreate(contextId);
      this.sessionManager!.trackTask(taskId, sessionId, contextId);

      // 4. Build prompt
      let promptText = this.extractText(userMessage);

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

        // ── Reasoning complete → publish accumulated thought as trace artifact ──
        unsubs.push(copilotSession.on("assistant.reasoning", (event: any) => {
          const content = event?.data?.content ?? reasoningAccumulator;
          if (content) {
            log.debug("Reasoning complete", { taskId, len: content.length });
            publishThoughtArtifact(bus, taskId, contextId, "trace.thought", content);
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

          await done;
        } finally {
          clearTimeout(timer);
          for (const unsub of unsubs) {
            if (typeof unsub === "function") unsub();
          }
        }

        // If we timed out but have content, append a note
        if (timedOut && accumulatedText) {
          accumulatedText += "\n\n---\n*Response truncated: processing time limit reached.*";
        }
      } else {
        // Non-streaming: wait for complete response
        const timeoutMs = this.config.timeouts.prompt ?? 600_000;
        const timeout = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`Prompt timeout after ${timeoutMs}ms`)), timeoutMs),
        );

        try {
          const response = await Promise.race([
            copilotSession.sendAndWait({ prompt: promptText }, timeoutMs),
            timeout,
          ]);
          accumulatedText = (response as any)?.data?.content ?? "";
        } catch (e) {
          if (!(e as Error).message.includes("timeout")) throw e;
          log.warn("Prompt timed out", { taskId, timeoutMs });
        }
      }

      // Fallback
      if (!accumulatedText) {
        accumulatedText = timedOut
          ? "The request timed out before a response was produced."
          : "No text response was returned.";
      }

      // 6. Finalize
      if (this.config.features.streamArtifactChunks) {
        publishLastChunkMarker(bus, taskId, contextId, streamArtifactId, accumulatedText);
      } else {
        publishFinalArtifact(bus, taskId, contextId, accumulatedText);
      }
      publishStatus(bus, taskId, contextId, "completed", undefined, true);
      bus.finished();
      log.info("Task completed", { taskId, len: accumulatedText.length });

    } catch (error) {
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
      publishStatus(bus, taskId, contextId, "failed", userMsg, true);
      bus.finished();
    } finally {
      this.sessionManager!.untrackTask(taskId);
      this.mcpHooks?.clearContext();
    }
  }
  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    log.info("Cancel requested", { taskId });
    // Copilot SDK doesn't expose a direct abort — the session will be
    // cleaned up by TTL or on the next getOrCreate call.
    const sessionId = this.sessionManager?.getSessionForTask(taskId);
    if (sessionId) {
      log.info("Session will be cleaned up on next use", { taskId, sessionId });
    }
    const ctxId = this.sessionManager?.getContextForTask(taskId) ?? "";
    publishStatus(bus, taskId, ctxId, "canceled", undefined, true);
    bus.finished();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private extractText(message: A2AMessage): string {
    return message.parts
      .filter((p) => (p as unknown as Record<string, unknown>).kind === "text" || "text" in (p as unknown as Record<string, unknown>))
      .map((p) => (p as unknown as { kind?: string; text: string }).text)
      .join("\n");
  }

  /**
   * Extract trace context propagated by the orchestrator via A2A metadata.
   *
   * The orchestrator injects { trace_id, parent_agent_id, propagated_metadata }
   * into the A2A request configuration dict. The A2A JS SDK exposes these
   * through the RequestContext or the Task object.
   */
  private extractTraceContext(ctx: RequestContext): {
    traceId: string;
    parentAgentId: string | null;
    metadata: Record<string, unknown>;
  } {
    // Try multiple access paths — SDK version differences may place metadata differently
    const raw = ctx as unknown as Record<string, unknown>;
    const meta =
      (raw.metadata as Record<string, unknown>) ||
      ((raw.task as Record<string, unknown>)?.metadata as Record<string, unknown>) ||
      ((raw.task as Record<string, unknown>)?.configuration as Record<string, unknown>) ||
      {};

    return {
      traceId:
        (meta.trace_id as string) ||
        (meta.traceId as string) ||
        ctx.contextId ||
        uuidv4(),
      parentAgentId:
        (meta.parent_agent_id as string) ||
        (meta.parentAgentId as string) ||
        null,
      metadata:
        (meta.propagated_metadata as Record<string, unknown>) ||
        (meta.propagatedMetadata as Record<string, unknown>) ||
        {},
    };
  }
}
