/**
 * Backend Capability Declaration — Claude
 *
 * Declares the capabilities of the Claude backend to callers and
 * orchestrators. Use this to make runtime decisions about what
 * the backend can and cannot do.
 */

export interface BackendCapabilities {
  /** Artifact delivery model. "buffered" = single final artifact. */
  artifactStreaming: "buffered" | "incremental";
  /** Whether tasks can be aborted mid-execution. */
  cancellation: "state-only" | "abortable";
  /** MCP transports the backend can accept. */
  mcpTransports: Array<"stdio" | "http" | "sse">;
  /** Whether the backend runs in a sandboxed environment. */
  sandboxing: boolean;
  /** Approval model. "none" = auto-approve; "interactive" = blocks waiting for human. */
  approvals: "none" | "headless" | "interactive";
}

export const CLAUDE_CAPABILITIES: BackendCapabilities = {
  artifactStreaming: "buffered",
  cancellation: "abortable",
  mcpTransports: ["stdio", "http"],
  sandboxing: true,
  approvals: "headless",
};
