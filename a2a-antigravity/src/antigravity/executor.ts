/**
 * Antigravity Executor — A2A ↔ Google Antigravity SDK Bridge
 */

import { existsSync, statSync } from "node:fs";
import type { Message as A2AMessage } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";

import type { AgentConfig, McpStdioServerConfig } from "../config/types.js";
import { BridgeClient } from "./bridge-client.js";
import { SessionManager } from "./session-manager.js";
import { EventMapper, sanitizeMessage, usageToCallRecord } from "./event-mapper.js";
import { validateMcpServers, toAntigravityMcpEntry } from "./mcp-adapter.js";
import { ANTIGRAVITY_BACKEND_PATHS } from "./backend-paths.js";
import {
  AgentEventEmitter,
  bootstrapSubAgents,
  LlmUsageAccumulator,
  materializeMemory,
  publishFinalArtifact,
  publishLastChunkMarker,
  publishStatus,
  publishStreamingChunk,
  publishTask,
  publishTraceArtifact,
  resolveTransport,
} from "@a2a-wrapper/core";
import type {
  EventTransport,
  EventTransportFn,
  SynthesizedMcpDescriptor,
} from "@a2a-wrapper/core";
import type { BridgeRunEvent } from "./bridge-protocol.js";
import { logger } from "../utils/logger.js";

const log = logger.child("executor");

export class AntigravityExecutor implements AgentExecutor {
  private readonly config: Required<AgentConfig>;
  private bridge: BridgeClient | null = null;
  private sessionManager: SessionManager | null = null;
  private initialized = false;

  public customTransport?: EventTransport | EventTransportFn;

  constructor(config: Required<AgentConfig>) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.validateConfig();

    const workspaceDir = this.primaryWorkspace();
    if (this.config.memory) {
      if (!workspaceDir) {
        throw new Error(
          "memory is configured, but antigravity.workingDirectory/workspaces is not set. " +
          "Set a workspace so memory can be materialized.",
        );
      }
      await materializeMemory({
        memoryConfig: this.config.memory,
        configDir: this.config.configDir ?? process.cwd(),
        workspaceDir,
        paths: ANTIGRAVITY_BACKEND_PATHS,
      });
    }

    if (this.config.subAgents?.agents?.length) {
      const existingMcpKeys = new Set(Object.keys(this.config.mcp ?? {}));
      const result = await bootstrapSubAgents({
        subAgents: this.config.subAgents,
        workspaceDir,
        parentLogLevel: this.config.logging.level ?? "info",
        existingMcpKeys,
      });
      this.config.mcp = {
        ...(this.config.mcp ?? {}),
        [result.descriptor.key]: this.toAntigravityMcpEntry(result.descriptor),
      };
    }

    validateMcpServers(this.config.mcp ?? {});

    this.bridge = new BridgeClient(this.config);
    await this.bridge.start();
    this.sessionManager = new SessionManager(this.bridge, this.config);
    this.sessionManager.startCleanup(
      this.config.session.cleanupInterval ?? 300_000,
      this.config.session.ttl ?? 3_600_000,
    );

    this.initialized = true;
    log.info("Executor initialized", {
      workspaceDir: workspaceDir ?? "(sdk default)",
      authMode: this.config.antigravity.provider?.authMode ?? "sdkDefault",
    });
  }

  async shutdown(): Promise<void> {
    this.sessionManager?.stopCleanup();
    await this.sessionManager?.closeAll();
    this.sessionManager = null;
    await this.bridge?.shutdown();
    this.bridge = null;
    this.initialized = false;
    log.info("Executor shut down");
  }

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    await this.initialize();

    const agentId = this.config.agentCard.name.toLowerCase().replace(/\s+/g, "-");
    const transport = resolveTransport(
      this.config.events,
      bus,
      taskId,
      contextId,
      this.customTransport,
    );
    const emitter = new AgentEventEmitter({
      agentId,
      agentName: this.config.agentCard.name,
      traceId: contextId || uuidv4(),
      transport,
    });
    const mapper = new EventMapper(emitter, this.config);
    const accumulator = new LlmUsageAccumulator();

    try {
      if (!task) {
        publishTask(bus, taskId, contextId);
        publishStatus(bus, taskId, contextId, "submitted");
      }
      publishStatus(bus, taskId, contextId, "working", "Processing request...");
      await emitter.emit("agent_started", { backend: "antigravity" });

      const session = await this.sessionManager!.getOrCreate(contextId);
      const prompt = extractUserText(userMessage);
      const streamArtifactId = `response-${taskId}`;
      let finalText = "";
      let streamStarted = false;
      let usageRecorded = false;

      this.sessionManager!.trackExecution(taskId, contextId, session.sessionId);

      const turnFn = async (): Promise<void> => {
        const started = Date.now();
        const timeoutMs = this.config.timeouts.prompt ?? 600_000;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.bridge?.cancel(taskId);
            reject(new Error(`Prompt timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        const run = this.bridge!.run(
          session.sessionId,
          taskId,
          prompt,
          async (event: BridgeRunEvent) => {
            await mapper.handleEvent(event);

            if (event.kind === "text_delta") {
              finalText += event.text;
              if (this.config.features.streamArtifactChunks) {
                streamStarted = true;
                publishStreamingChunk(bus, taskId, contextId, streamArtifactId, event.text);
              }
            } else if (event.kind === "usage") {
              accumulator.record(
                usageToCallRecord(
                  event.usage,
                  this.config.antigravity.model,
                  Date.now() - started,
                ),
              );
              usageRecorded = true;
              if (this.config.features.trackUsage) {
                publishTraceArtifact(
                  bus,
                  taskId,
                  contextId,
                  "trace.usage",
                  usageToCallRecord(event.usage, this.config.antigravity.model) as unknown as Record<string, unknown>,
                );
              }
            } else if (event.kind === "structured_output") {
              publishTraceArtifact(bus, taskId, contextId, "trace.structured_output", {
                output: event.output as unknown,
              });
            }
          },
        );

        const terminal = await Promise.race([run, timeout]);
        if (timer) clearTimeout(timer);

        if (terminal.kind === "completed") {
          if (!finalText && terminal.text) finalText = terminal.text;
          if (terminal.usage && !usageRecorded) {
            accumulator.record(
              usageToCallRecord(
                terminal.usage,
                this.config.antigravity.model,
                Date.now() - started,
              ),
            );
          }
          if (!finalText && terminal.structuredOutput !== undefined) {
            finalText = JSON.stringify(terminal.structuredOutput, null, 2);
          }
          finalText ||= "No text response was returned.";
          if (this.config.features.streamArtifactChunks && streamStarted) {
            publishLastChunkMarker(bus, taskId, contextId, streamArtifactId, finalText);
          } else {
            publishFinalArtifact(bus, taskId, contextId, finalText);
          }
          publishStatus(
            bus,
            taskId,
            contextId,
            "completed",
            undefined,
            true,
            { "x-usage": accumulator.summary() },
          );
          bus.finished();
          return;
        }

        if (terminal.kind === "canceled") {
          publishStatus(bus, taskId, contextId, "canceled", terminal.message, true);
          bus.finished();
          return;
        }

        if (terminal.kind === "failed") {
          const msg = sanitizeMessage(terminal.message);
          publishStatus(bus, taskId, contextId, "failed", msg, true);
          bus.finished();
          return;
        }

        publishStatus(bus, taskId, contextId, "failed", "Unexpected bridge response.", true);
        bus.finished();
      };

      session.executionQueue = session.executionQueue
        .then(turnFn)
        .catch((err) => {
          const msg = sanitizeMessage((err as Error).message);
          log.error("Execution failed", { taskId, error: msg });
          publishStatus(bus, taskId, contextId, "failed", msg, true);
          bus.finished();
        })
        .finally(() => {
          this.sessionManager?.untrackExecution(taskId);
        });

      await session.executionQueue;
    } catch (err) {
      const msg = sanitizeMessage((err as Error).message ?? String(err));
      log.error("Executor outer error", { taskId, error: msg });
      publishStatus(bus, taskId, contextId, "failed", msg, true);
      bus.finished();
      this.sessionManager?.untrackExecution(taskId);
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    log.info("Cancel requested", { taskId });
    const execution = this.sessionManager?.getExecution(taskId);
    if (!execution) return;
    await this.bridge?.cancel(taskId);
    publishStatus(bus, taskId, execution.contextId, "canceled", undefined, true);
    bus.finished();
    this.sessionManager?.untrackExecution(taskId);
  }

  private validateConfig(): void {
    const ag = this.config.antigravity;
    const workspaces = [...(ag.workspaces ?? [])];
    if (ag.workingDirectory) workspaces.push(ag.workingDirectory);
    for (const workspace of workspaces) {
      if (!existsSync(workspace)) {
        throw new Error(`Antigravity workspace does not exist: "${workspace}"`);
      }
      if (!statSync(workspace).isDirectory()) {
        throw new Error(`Antigravity workspace is not a directory: "${workspace}"`);
      }
    }

    const provider = ag.provider;
    if (provider?.authMode === "adc" && (!provider.project || !provider.location)) {
      throw new Error(
        'antigravity.provider.authMode "adc" requires provider.project and provider.location.',
      );
    }

    const capabilities = ag.capabilities;
    if (capabilities?.enabledTools && capabilities.disabledTools) {
      throw new Error(
        "antigravity.capabilities cannot set both enabledTools and disabledTools.",
      );
    }

    if (ag.policies?.mode === "custom" && !ag.policies.rules?.length) {
      throw new Error(
        'antigravity.policies.mode "custom" requires at least one rule.',
      );
    }
  }

  private primaryWorkspace(): string | undefined {
    return this.config.antigravity.workingDirectory
      ?? this.config.antigravity.workspaces?.[0];
  }

  private toAntigravityMcpEntry(descriptor: SynthesizedMcpDescriptor): McpStdioServerConfig {
    return toAntigravityMcpEntry(descriptor);
  }
}

function extractUserText(message: A2AMessage): string {
  return message.parts
    .filter((part) => {
      const p = part as unknown as Record<string, unknown>;
      return p.kind === "text" || "text" in p;
    })
    .map((part) => (part as unknown as { text: string }).text)
    .join("\n");
}
