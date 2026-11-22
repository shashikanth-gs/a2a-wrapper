/**
 * Claude Client Factory
 *
 * The single file that imports @anthropic-ai/claude-agent-sdk. The narrow
 * ClaudeClientLike/QueryLike interfaces let unit tests inject fakes and
 * insulate the rest of the wrapper from SDK surface changes.
 */

import { query, getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeOtelEnv } from "@a2a-wrapper/core";
import type { AgentConfig, ClaudeThinkingConfig } from "../config/types.js";
import { buildMcpServers } from "./mcp-adapter.js";

// ─── Narrow Interfaces (for testability) ────────────────────────────────────

export interface SDKMessageLike {
  type: string;
  [key: string]: unknown;
}

/**
 * The one input-message shape this wrapper sends. Narrower than the SDK's
 * `SDKUserMessage` on purpose: `uuid` and `session_id` are optional there, and
 * everything else on it is for replay/subagent traffic we never originate.
 */
export interface SDKUserMessageLike {
  type: "user";
  parent_tool_use_id: string | null;
  message: { role: "user"; content: string };
  /** Client id of the message: the CLI echoes it in `command_lifecycle` and `user_message_uuids`, which is how a steer learns what became of it. */
  uuid?: string;
  /**
   * When the CLI reads a message pushed while a turn runs: `now` interrupts the running turn and runs the message at once,
   * `next` (the default) folds it into the running turn at the next tool boundary, `later` queues it as its own turn.
   */
  priority?: "now" | "next" | "later";
}

export interface QueryLike extends AsyncIterable<SDKMessageLike> {
  interrupt(): Promise<unknown>;
}

/** What the SDK passes next to a tool call it wants permission for (the fields this wrapper reads). */
export interface CanUseToolOptionsLike {
  /** Aborts when the SDK no longer needs the answer (the turn was interrupted or aborted). */
  signal: AbortSignal;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  toolUseID?: string;
  agentID?: string;
  [extra: string]: unknown;
}

/** What `canUseTool` answers: allow (optionally with an edited input) or deny with a message the model sees. */
export type PermissionResultLike =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type CanUseToolLike = (
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptionsLike,
) => Promise<PermissionResultLike>;

export interface QueryOptionsLike {
  cwd?: string;
  model?: string;
  fallbackModel?: string;
  effort?: string;
  thinking?: { type: string; budgetTokens?: number; display?: string };
  outputFormat?: { type: string; schema: Record<string, unknown> };
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  settingSources?: Array<"user" | "project" | "local">;
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  additionalDirectories?: string[];
  sandbox?: Record<string, unknown>;
  pathToClaudeCodeExecutable?: string;
  allowDangerouslySkipPermissions?: boolean;
  strictMcpConfig?: boolean;
  persistSession?: boolean;
  includePartialMessages?: boolean;
  mcpServers?: Record<string, unknown>;
  mcpServersDelivery?: "argv" | "initialize";
  resume?: string;
  abortController?: AbortController;
  /** Set only when a person (or a rule) can answer: see `interactions` in the config. */
  canUseTool?: CanUseToolLike;
}

export interface ClaudeClientLike {
  runQuery(
    prompt: string | AsyncIterable<SDKUserMessageLike>,
    options: QueryOptionsLike,
  ): QueryLike;
  /** Does the CLI have a transcript for this session? Optional: a client that cannot tell leaves it out. */
  sessionExists?(sessionId: string, dir?: string): Promise<boolean>;
}

// ─── Option Mapping ──────────────────────────────────────────────────────────

/**
 * Marketplace plugins are installed lazily and, by default, *asynchronously* —
 * with this flag unset the SDK installs nothing at all, reports no error, and
 * loads zero plugins on every subsequent run too. Setting it makes the install
 * complete before the session's init message, which is what makes the startup
 * preflight able to see (and fail on) a plugin that did not load.
 */
function syncPluginInstallEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env["CLAUDE_CODE_SYNC_PLUGIN_INSTALL"] = "1";
  return env;
}

/**
 * Build SDK query options from the resolved agent config plus per-turn state.
 * Hardening flags (strictMcpConfig, persistSession) are always set here and
 * are not user-configurable.
 */
/**
 * Resolve the `thinking` option actually sent to the SDK.
 *
 * The SDK leaves `display` at "omitted", which makes the model emit thinking
 * blocks whose text is an empty string — so `features.emitThinkingEvents` has
 * nothing to publish and the sideband stays silent. Whenever those events are
 * enabled, ask for summaries: supply a full adaptive config when the caller set
 * no thinking at all, and fill in `display` when they set one without it.
 *
 * An explicit `display` is always honoured, including "omitted", and
 * `type: "disabled"` is left untouched — both are deliberate opt-outs.
 */
function resolveThinking(
  thinking: ClaudeThinkingConfig | undefined,
  emitThinkingEvents: boolean | undefined,
): ClaudeThinkingConfig | undefined {
  if (!emitThinkingEvents) return thinking;
  if (!thinking) return { type: "adaptive", display: "summarized" };
  if (thinking.type === "disabled" || thinking.display !== undefined) return thinking;
  return { ...thinking, display: "summarized" };
}

export function buildQueryOptions(
  config: Required<AgentConfig>,
  turn: { resume?: string; abortController?: AbortController; canUseTool?: CanUseToolLike },
): QueryOptionsLike {
  const claude = config.claude;

  let systemPrompt: QueryOptionsLike["systemPrompt"];
  if (claude.customSystemPrompt) {
    systemPrompt = claude.customSystemPrompt;
  } else if (claude.systemPromptAppend) {
    systemPrompt = { type: "preset", preset: "claude_code", append: claude.systemPromptAppend };
  }

  const mcpServers = buildMcpServers(config.mcp ?? {});

  // `settings` is the SDK's flag-tier settings object, so marketplace plugins
  // compose with settingSources rather than competing with it — callers keeping
  // full isolation (settingSources: []) still get their plugins.
  const marketplaces = claude.marketplaces ?? {};
  const usesMarketplaces = Object.keys(marketplaces).length > 0;

  const baseEnv = usesMarketplaces ? syncPluginInstallEnv() : undefined;
  // Hook F — Claude Code subprocess OTel + TRACEPARENT from active task span.
  const env = buildClaudeOtelEnv(config.otel, baseEnv);

  const opts: QueryOptionsLike = {
    cwd: claude.workingDirectory || undefined,
    model: claude.model || undefined,
    fallbackModel: claude.fallbackModel || undefined,
    effort: claude.effort,
    thinking: resolveThinking(claude.thinking, config.features.emitThinkingEvents),
    outputFormat: claude.outputFormat,
    permissionMode: claude.permissionMode ?? "acceptEdits",
    allowedTools: claude.allowedTools && claude.allowedTools.length > 0 ? claude.allowedTools : undefined,
    disallowedTools: claude.disallowedTools && claude.disallowedTools.length > 0 ? claude.disallowedTools : undefined,
    systemPrompt,
    settingSources: claude.settingSources ?? [],
    settings: usesMarketplaces
      ? {
          extraKnownMarketplaces: marketplaces as unknown as Record<string, unknown>,
          enabledPlugins: claude.enabledPlugins ?? {},
        }
      : undefined,
    env,
    maxTurns: claude.maxTurns,
    maxBudgetUsd: claude.maxBudgetUsd,
    additionalDirectories:
      claude.additionalDirectories && claude.additionalDirectories.length > 0
        ? claude.additionalDirectories
        : undefined,
    sandbox: claude.sandbox,
    pathToClaudeCodeExecutable: claude.executablePathOverride || undefined,
    allowDangerouslySkipPermissions: claude.dangerouslyAllowBypassPermissions === true ? true : undefined,
    strictMcpConfig: true,
    persistSession: true,
    includePartialMessages: config.features.streamArtifactChunks === true,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    // Bundled CLI: send servers in the initialize request (argv delivery is deprecated).
    // A custom executable may predate 'initialize', so it explicitly stays on argv.
    mcpServersDelivery:
      Object.keys(mcpServers).length > 0
        ? (claude.executablePathOverride ? "argv" : "initialize")
        : undefined,
    resume: turn.resume,
    abortController: turn.abortController,
    ...(turn.canUseTool ? { canUseTool: turn.canUseTool } : {}),
  };

  return opts;
}

// ─── Real Factory ────────────────────────────────────────────────────────────

/**
 * Create a real Claude client. ANTHROPIC_API_KEY (or Bedrock/Vertex/OAuth env
 * vars) are read from the environment by the SDK — never passed via config.
 */
export function createClaudeClient(_config: Required<AgentConfig>): ClaudeClientLike {
  return {
    runQuery(
      prompt: string | AsyncIterable<SDKUserMessageLike>,
      options: QueryOptionsLike,
    ): QueryLike {
      // A string prompt makes the SDK close the CLI's stdin on the first result
      // (`isSingleUserTurn`), which ends the process before any background-task
      // wake could fire. Streaming input is what keeps that window open.
      return query({
        prompt: prompt as Parameters<typeof query>[0]["prompt"],
        options: options as unknown as Options,
      }) as unknown as QueryLike;
    },
    async sessionExists(sessionId: string, dir?: string): Promise<boolean> {
      return (await getSessionInfo(sessionId, dir ? { dir } : undefined)) !== undefined;
    },
  };
}
