/**
 * Opt-in platform compatibility attributes (design: docs/design/distributed-tracing.md, 8.5).
 *
 * Langfuse and Phoenix key their agent/graph views on their own attributes and
 * give `gen_ai.*` spans no special treatment. `otel.compat` adds a small, fixed
 * set of those attributes next to the standard ones; it never changes or
 * removes a standard attribute, and with no compat selected the attribute set
 * is exactly what it was before.
 *
 * Deliberately NOT added: `input.value` / `output.value` /
 * `langfuse.observation.input|output` (they carry content) and
 * `llm.token_count.*` (would mislabel an AGENT span as an LLM span).
 *
 * @module telemetry/compat
 */

import type { OtelCompat } from "./types.js";

export const COMPAT_MODES: readonly OtelCompat[] = ["langfuse", "openinference"];

export interface CompatSource {
  compat?: unknown;
}

/**
 * Resolve the selected compat modes. Precedence: `A2A_OTEL_COMPAT`
 * (comma-separated, `none` to clear) over `otel.compat`. Unknown names are
 * ignored with a warning; duplicates are removed.
 */
export function resolveCompat(
  otel?: CompatSource | null,
  env: Record<string, string | undefined> = process.env,
): OtelCompat[] {
  const fromEnv = env["A2A_OTEL_COMPAT"]?.trim();
  const raw: unknown[] =
    fromEnv !== undefined && fromEnv !== ""
      ? fromEnv.split(",").map((s) => s.trim())
      : Array.isArray(otel?.compat)
        ? (otel!.compat as unknown[])
        : [];

  const out: OtelCompat[] = [];
  for (const item of raw) {
    const name = typeof item === "string" ? item.trim().toLowerCase() : "";
    if (!name || name === "none") continue;
    if ((COMPAT_MODES as readonly string[]).includes(name)) {
      if (!out.includes(name as OtelCompat)) out.push(name as OtelCompat);
    } else {
      console.warn(
        `[a2a-wrapper/otel] ignoring unknown otel.compat "${String(item)}" (expected ${COMPAT_MODES.join(" | ")})`,
      );
    }
  }
  return out;
}

export interface CompatRequestInfo {
  agentId: string;
  agentName: string;
  /** Calling agent, when the orchestrator supplied `parent_agent_id`. */
  parentAgentId?: string | null;
}

/** Extra attributes for the request span (`a2a.task.execute`). */
export function compatRequestAttributes(
  compat: readonly OtelCompat[] | undefined,
  info: CompatRequestInfo,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!compat || compat.length === 0) return out;
  if (compat.includes("langfuse")) {
    out["langfuse.observation.type"] = "agent";
  }
  if (compat.includes("openinference")) {
    out["openinference.span.kind"] = "AGENT";
    out["agent.name"] = info.agentName;
    out["graph.node.id"] = info.agentId;
    out["graph.node.name"] = info.agentName;
    // Only when a parent agent is known; an invented edge would corrupt the graph.
    if (info.parentAgentId) out["graph.node.parent_id"] = info.parentAgentId;
  }
  return out;
}

/** Extra attributes for a mirrored tool span (`a2a.mcp.tool`). */
export function compatToolAttributes(
  compat: readonly OtelCompat[] | undefined,
  toolName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!compat || compat.length === 0) return out;
  if (compat.includes("langfuse")) out["langfuse.observation.type"] = "tool";
  if (compat.includes("openinference")) {
    out["openinference.span.kind"] = "TOOL";
    out["tool.name"] = toolName;
  }
  return out;
}
