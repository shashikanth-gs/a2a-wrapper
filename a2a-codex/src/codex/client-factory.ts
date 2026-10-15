/**
 * Codex Client Factory
 *
 * Creates a @openai/codex-sdk Codex client configured with the resolved
 * agent config. The narrow CodexClientLike/CodexThreadLike interfaces allow
 * unit tests to inject fakes without invoking the real Codex CLI subprocess.
 *
 * MCP servers must be configured at construction time — there is no runtime
 * MCP registration API in the SDK. See buildMcpConfig() in mcp-adapter.ts.
 */

import { Codex } from "@openai/codex-sdk";
import { mergeCodexOtelOverrides } from "@a2a-wrapper/core";
import type { AgentConfig } from "../config/types.js";
import { buildMcpConfig } from "./mcp-adapter.js";

// ─── Narrow Interfaces (for testability) ────────────────────────────────────

export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<ThreadEventLike> }>;
  run(
    input: string,
    options?: { signal?: AbortSignal },
  ): Promise<RunResultLike>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptionsLike): CodexThreadLike;
  resumeThread(threadId: string, options?: ThreadOptionsLike): CodexThreadLike;
}

export interface ThreadOptionsLike {
  model?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  networkAccessEnabled?: boolean;
  webSearchMode?: string;
  additionalDirectories?: string[];
}

export interface RunResultLike {
  finalResponse: string;
  items: ThreadItemLike[];
  usage: UsageLike | null;
}

export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface ThreadEventLike {
  type: string;
  [key: string]: unknown;
}

export interface ThreadItemLike {
  type: string;
  id: string;
  [key: string]: unknown;
}

// ─── Real Factory ────────────────────────────────────────────────────────────

/**
 * Create a real Codex client from the resolved agent configuration.
 * Constructs exactly one client per executor instance.
 *
 * OPENAI_API_KEY is read from the environment by the SDK automatically.
 * Do not pass it through config.json.
 */
export function createCodexClient(config: Required<AgentConfig>): CodexClientLike {
  const codexCfg = config.codex;
  const mcpServers = buildMcpConfig(config.mcp ?? {});

  // Hook F — fold otel.backend.codex into CLI `[otel]` overrides.
  const sdkConfig: Record<string, unknown> = {
    ...(mergeCodexOtelOverrides(config.otel, codexCfg.configOverrides) ?? {}),
  };

  if (Object.keys(mcpServers).length > 0) {
    sdkConfig.mcp_servers = mcpServers;
  }

  return new Codex({
    ...(codexCfg.baseUrl ? { baseUrl: codexCfg.baseUrl } : {}),
    ...(codexCfg.codexPathOverride ? { codexPathOverride: codexCfg.codexPathOverride } : {}),
    config: Object.keys(sdkConfig).length > 0 ? sdkConfig as any : undefined,
  }) as unknown as CodexClientLike;
}
