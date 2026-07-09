/**
 * Claude Client Factory
 *
 * The single file that imports @anthropic-ai/claude-agent-sdk. The narrow
 * ClaudeClientLike/QueryLike interfaces let unit tests inject fakes and
 * insulate the rest of the wrapper from SDK surface changes.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/types.js";
import { buildMcpServers } from "./mcp-adapter.js";

// ─── Narrow Interfaces (for testability) ────────────────────────────────────

export interface SDKMessageLike {
  type: string;
  [key: string]: unknown;
}

export interface QueryLike extends AsyncIterable<SDKMessageLike> {
  interrupt(): Promise<void>;
}

export interface QueryOptionsLike {
  cwd?: string;
  model?: string;
  fallbackModel?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  settingSources?: Array<"user" | "project" | "local">;
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
  resume?: string;
  abortController?: AbortController;
}

export interface ClaudeClientLike {
  runQuery(prompt: string, options: QueryOptionsLike): QueryLike;
}

// ─── Option Mapping ──────────────────────────────────────────────────────────

/**
 * Build SDK query options from the resolved agent config plus per-turn state.
 * Hardening flags (strictMcpConfig, persistSession) are always set here and
 * are not user-configurable.
 */
export function buildQueryOptions(
  config: Required<AgentConfig>,
  turn: { resume?: string; abortController?: AbortController },
): QueryOptionsLike {
  const claude = config.claude;

  let systemPrompt: QueryOptionsLike["systemPrompt"];
  if (claude.customSystemPrompt) {
    systemPrompt = claude.customSystemPrompt;
  } else if (claude.systemPromptAppend) {
    systemPrompt = { type: "preset", preset: "claude_code", append: claude.systemPromptAppend };
  }

  const mcpServers = buildMcpServers(config.mcp ?? {});

  const opts: QueryOptionsLike = {
    cwd: claude.workingDirectory || undefined,
    model: claude.model || undefined,
    fallbackModel: claude.fallbackModel || undefined,
    permissionMode: claude.permissionMode ?? "acceptEdits",
    allowedTools: claude.allowedTools && claude.allowedTools.length > 0 ? claude.allowedTools : undefined,
    disallowedTools: claude.disallowedTools && claude.disallowedTools.length > 0 ? claude.disallowedTools : undefined,
    systemPrompt,
    settingSources: claude.settingSources ?? [],
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
    resume: turn.resume,
    abortController: turn.abortController,
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
    runQuery(prompt: string, options: QueryOptionsLike): QueryLike {
      return query({ prompt, options: options as unknown as Options }) as unknown as QueryLike;
    },
  };
}
