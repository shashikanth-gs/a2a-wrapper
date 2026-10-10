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

import type { AgentExecutor, RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";

import type { AgentConfig, McpStdioServerConfig } from "../config/types.js";
import { createClaudeClient, buildQueryOptions } from "./client-factory.js";
import type { ClaudeClientLike, SDKMessageLike } from "./client-factory.js";
import { SessionManager } from "./session-manager.js";
import { EventMapper, sanitizeMessage } from "./event-mapper.js";
import {
  RateLimitTracker,
  renderRateLimitMessage,
  rateLimitMetadata,
} from "./rate-limit-tracker.js";
import type { RateLimitSnapshot } from "./rate-limit-tracker.js";
import { validateMcpServers, toClaudeMcpEntry } from "./mcp-adapter.js";
import { CLAUDE_BACKEND_PATHS } from "./backend-paths.js";
import { extractUserText, promptStream } from "./prompt-builder.js";
import { BackgroundTaskTracker } from "./background-tasks.js";

import {
  createDeferred,
  materializeMemory,
  bootstrapSubAgents,
  publishTask,
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
  createExecutionObservability,
} from "@a2a-wrapper/core";
import type { EventTransport, EventTransportFn, SynthesizedMcpDescriptor } from "@a2a-wrapper/core";

import { logger } from "../utils/logger.js";

const log = logger.child("executor");

const VALID_PERMISSION_MODES = new Set(["acceptEdits", "dontAsk", "plan", "bypassPermissions"]);
const VALID_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const VALID_THINKING_TYPES = new Set(["adaptive", "enabled", "disabled"]);
const VALID_OUTPUT_FORMAT_TYPES = new Set(["json_schema"]);

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

    await this.preflightPlugins();

    this.sessionManager = new SessionManager(this.config);
    this.sessionManager.startCleanup(
      this.config.session.cleanupInterval ?? 0,
      this.config.session.ttl ?? 0,
    );

    this.initialized = true;
    log.info("Executor initialized");
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
        // A prompt timeout of 0 (or any value <= 0) disables the bound entirely:
        // the turn runs until the SDK iterator completes. Without this guard
        // setTimeout would coerce such a delay to the next tick and abort at once.
        //
        // Note this timer is armed once, at turn start, and never re-armed — so
        // for a held-open task it bounds the whole A2A Task including the idle
        // gaps between SDK turns. See the README caveat.
        const promptTimeout = this.config.timeouts.prompt ?? 600_000;
        const timer =
          promptTimeout > 0
            ? setTimeout(() => {
                timedOut = true;
                abortController.abort();
              }, promptTimeout)
            : null;

        // Hoisted above the try: `break` inside `for await` awaits
        // iterator.return(), and a rejection there lands in the catch block,
        // which must still be able to see a rate limit we already detected.
        let rateLimited: RateLimitSnapshot | null = null;
        let finalText = "";
        // Structured output captured from the success result, published as a
        // data part alongside finalText. Reset per round in lockstep with it.
        let structuredOutput: unknown;
        let streamArtifactStarted = false;
        const streaming = this.config.features.streamArtifactChunks === true;

        // One artifact per round, so a held-open task's later rounds cannot
        // append onto an earlier round's artifact and make its lastChunk
        // marker's fullText a lie.
        let round = 1;
        const streamArtifactId = (): string => `response-${taskId}-${round}`;

        // Terminality is decided inside the loop now, so both the catch and the
        // post-loop block need to know whether it already happened.
        let terminalPublished = false;

        // One tracker per query. A query is one CLI process, and the SDK's
        // background-task level signal is per-process, so this scoping is what
        // makes "reset to empty when the process restarts" structural.
        const backgroundTasks = new BackgroundTaskTracker();
        const holdEnabled = this.config.features.holdTaskForBackgroundWork !== false;

        // Resolving this ends the SDK input stream, which lets the CLI exit.
        // It MUST be resolved on every exit path — see the finally block.
        const inputClosed = createDeferred<void>();

        /** Single definition of the rate-limit ending, used by both paths. */
        const endTurnRateLimited = (snapshot: RateLimitSnapshot): void => {
          // Tear down the subprocess — same break-then-abort teardown the
          // plugin preflight uses. Waiting out a reset is never our call.
          // `query.interrupt()` (which cancelTask also calls) is not needed
          // here: the `break` already closed the iterator, so there is no
          // in-flight consumer left to interrupt, and abort() is what actually
          // stops the subprocess.
          abortController.abort();

          // Already-sent chunks would otherwise leave the client's artifact
          // open forever. This closes the current round's stream; finalText is
          // intentionally "" here, since no success result arrives on this path.
          if (streaming && streamArtifactStarted) {
            publishLastChunkMarker(bus, taskId, contextId, streamArtifactId(), finalText);
          }

          // Always terminal. The SDK cannot resume an interrupted turn — a
          // follow-up is a new prompt regardless — so holding the task open
          // would promise a continuation we never deliver. Continuity comes
          // from the contextId → Claude session mapping, which survives a
          // failed task, so the client just starts a new task on the same
          // contextId once the limit resets.
          publishStatus(
            bus, taskId, contextId, "failed",
            renderRateLimitMessage(snapshot),
            true,
            rateLimitMetadata(snapshot),
          );
          terminalPublished = true;
          bus.finished();
        };

        /**
         * Emit this round's output artifact.
         *
         * Reads `streamArtifactStarted`/`finalText`/`round` at call time, so the
         * in-loop caller and the post-loop fallback stay in lockstep by
         * construction rather than by two copies agreeing.
         *
         * Deliberately NOT reused by `endTurnRateLimited`: that path must close
         * an already-open stream without ever publishing a buffered artifact,
         * so it keeps its streaming-only variant.
         */
        const publishRoundArtifact = (): void => {
          if (streaming && streamArtifactStarted) {
            publishLastChunkMarker(bus, taskId, contextId, streamArtifactId(), finalText, structuredOutput);
          } else if (finalText) {
            publishFinalArtifact(bus, taskId, contextId, finalText, structuredOutput);
          }
        };

        /** Single definition of the successful ending, mirroring endTurnRateLimited. */
        const endTurnCompleted = (): void => {
          publishStatus(bus, taskId, contextId, "completed", undefined, true);
          terminalPublished = true;
          bus.finished();
        };

        try {
          publishStatus(bus, taskId, contextId, "working", "Processing request...");

          const options = buildQueryOptions(this.config, {
            resume: session.sessionId ?? undefined,
            abortController,
          });
          // Streaming input, not a string: a string prompt makes the SDK close
          // the CLI's stdin on the first result, ending the process before any
          // background-task wake could fire.
          const q = this.client!.runQuery(promptStream(promptText, inputClosed.promise), options);
          this.sessionManager!.attachQuery(taskId, q);

          let resultError: string | null = null;
          // The last result the loop saw, kept only so the post-loop fallback
          // can close the `agent_finished` bookend with real usage figures.
          let lastResult: SDKMessageLike | null = null;
          const rateLimits = new RateLimitTracker();

          for await (const msg of q as AsyncIterable<SDKMessageLike>) {
            const verdict = rateLimits.observe(msg);
            if (verdict.kind !== "none") mapper.handleRateLimit(verdict);
            if (verdict.kind === "rejected") {
              rateLimited = verdict.snapshot;
              // Unlike the error-result and completed breaks below, this one
              // does not pre-resolve `inputClosed`, and does not need to: the
              // SDK launches its input pump fire-and-forget and `Query.return()`
              // closes the transport without awaiting the parked input
              // generator, so `break` cannot block on it. The `finally` still
              // resolves it, which is what actually releases the generator.
              // `endTurnRateLimited` then aborts, tearing down the subprocess.
              break;
            }

            if (backgroundTasks.observe(msg)) {
              mapper.handleBackgroundTasks(backgroundTasks.snapshot());
            }

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
                publishStreamingChunk(bus, taskId, contextId, streamArtifactId(), delta.text);
              }
            }

            if (msg.type !== "result") {
              mapper.handleMessage(msg);
              continue;
            }

            // ── A result message: decide whether this ends the A2A Task ──
            if (msg.subtype === "success" && typeof msg.result === "string") {
              finalText = msg.result;
              structuredOutput = msg.structured_output;
            } else if (msg.subtype !== "success") {
              const reasons: Record<string, string> = {
                error_max_turns: "Turn limit reached (max_turns).",
                error_max_budget_usd: "Budget limit reached (max_budget_usd).",
                error_during_execution: "Error during execution.",
                error_max_structured_output_retries: "Structured output retries exhausted.",
              };
              resultError = reasons[String(msg.subtype)] ?? `Execution failed (${String(msg.subtype)}).`;
            }

            lastResult = msg;
            const holding = holdEnabled && resultError === null && backgroundTasks.size > 0;
            mapper.handleResult(msg, { held: holding });

            if (resultError !== null) {
              // The CLI stays alive on streaming input, so an error result would
              // hang the loop unless we close the stream ourselves.
              inputClosed.resolve();
              break;
            }

            // This round's output, closed either way so the next round starts a
            // fresh artifact.
            publishRoundArtifact();
            streamArtifactStarted = false;

            if (holding) {
              publishStatus(
                bus, taskId, contextId, "working",
                finalText || undefined,
                false,
                { backgroundTasks: backgroundTasks.snapshot() },
              );
              finalText = "";
              structuredOutput = undefined;
              round += 1;
              continue;
            }

            endTurnCompleted();
            inputClosed.resolve();
            break;
          }

          if (rateLimited) {
            endTurnRateLimited(rateLimited);
            return;
          }

          if (resultError) {
            publishStatus(bus, taskId, contextId, "failed", sanitizeMessage(resultError), true);
            terminalPublished = true;
            bus.finished();
            return;
          }

          // An abort can end the iterator *cleanly* rather than throwing, in
          // which case none of the catch's abort handling runs and we have to
          // reproduce it here. Everything that aborts is a reason the turn did
          // not finish on its own, so none of them may report `completed`.
          // (A rate-limit abort also lands here in principle, but that path
          // returned above.)
          const aborted = abortController.signal.aborted;

          if (!terminalPublished && !aborted) {
            // The iterator ended while we were still holding — the CLI died, or
            // it closed input on us. Complete with whatever the last round left
            // rather than hanging until the prompt timeout.
            log.info("SDK iterator ended while the task was still held open", {
              taskId,
              liveBackgroundTasks: backgroundTasks.size,
            });
            publishRoundArtifact();
            // This is the round that completes the Task, so it owes the
            // `agent_finished` bookend — the last result was consumed with
            // `{ held: true }`, which suppressed it. The mapper's latch keeps
            // it to one per Task, so a path that already emitted is a no-op.
            mapper.emitFinishedBookend(lastResult);
            endTurnCompleted();
          }

          if (!terminalPublished && aborted && timedOut) {
            // The timer's abort ended the iterator cleanly, so the catch's
            // timeout branch never ran. Reporting `completed` would claim a turn
            // that was cut short actually finished, and reporting nothing would
            // end the Task with no terminal event at all — so publish the same
            // failure the catch's timeout branch would have.
            const msg = `Prompt timed out after ${promptTimeout}ms.`;
            log.error("Task execution timed out", { taskId });
            publishStatus(bus, taskId, contextId, "failed", msg, true);
            terminalPublished = true;
            bus.finished();
          }

          // The remaining case — aborted, not timed out — is cancellation, and
          // it deliberately publishes nothing: `cancelTask` already published
          // `canceled` and called `bus.finished()`. Emitting `completed` here
          // would hand the client two terminal events that contradict.
        } catch (err) {
          // A detected rate limit outranks whatever the teardown threw: the
          // `break` above awaits iterator.return(), so a failing teardown would
          // otherwise discard the real reason this turn ended — and a teardown
          // error whose text merely contains "abort" would fall into the
          // silent branch below, leaving the task open with no terminal event.
          if (rateLimited) {
            log.info("Rate limit ended the turn; ignoring teardown error", {
              taskId,
              error: err instanceof Error ? err.message : String(err),
            });
            endTurnRateLimited(rateLimited);
            return;
          }

          // We break out of the loop after publishing a terminal event, which
          // awaits iterator.return(); a throw from that teardown must not
          // produce a second, contradictory terminal event.
          if (terminalPublished) {
            log.debug("Ignoring teardown error after the task was already terminal", {
              taskId,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }

          const isAbort =
            err instanceof Error &&
            (err.name === "AbortError" || err.message.includes("abort") || err.message.includes("canceled"));

          if (isAbort && timedOut) {
            const msg = `Prompt timed out after ${promptTimeout}ms.`;
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
          // The input generator parks forever if this never resolves, keeping
          // the CLI subprocess alive. Every exit path lands here; resolving an
          // already-resolved deferred is a no-op.
          inputClosed.resolve();
          if (timer) clearTimeout(timer);
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
