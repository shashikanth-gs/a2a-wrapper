/**
 * Default Configuration
 *
 * Secure defaults applied when no config file or env override is present.
 * All security-relevant fields default to the most restrictive safe option.
 */

import type { AgentConfig } from "./types.js";

export const DEFAULTS: Required<AgentConfig> = {
  agentCard: {
    name: "Codex A2A Agent",
    description: "A repository-scoped software engineering agent backed by OpenAI Codex.",
    protocolVersion: "0.3.0",
    version: "1.0.0",
    streaming: true,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [],
    pushNotifications: false,
  },
  server: {
    port: 3020,
    hostname: "0.0.0.0",
    advertiseHost: "localhost",
    advertiseProtocol: "http",
  },
  codex: {
    workingDirectory: "",            // required; validated on startup
    sandboxMode: "workspace-write",  // secure default: scoped writes only
    approvalPolicy: "never",         // headless A2A: no interactive approvals
    networkAccessEnabled: false,     // secure default: no outbound network
    webSearchMode: "disabled",       // secure default
    skipGitRepoCheck: false,         // keep git validation enabled
    additionalDirectories: [],
  },
  session: {
    reuseByContext: true,
    ttl: 3_600_000,
    cleanupInterval: 300_000,
  },
  features: {
    streamArtifactChunks: false,       // buffered by default (inspector-compatible)
    emitReasoningSummaries: true,
    emitCommandEvents: true,
    emitFileChangeEvents: true,
  },
  timeouts: {
    prompt: 600_000,
  },
  logging: {
    level: "info",
  },
  mcp: {},
  events: {
    enabled: true,
    transport: "a2a",
  },
  memory: undefined as unknown as Required<AgentConfig>["memory"],
  subAgents: undefined as unknown as Required<AgentConfig>["subAgents"],
  otel: undefined as unknown as Required<AgentConfig>["otel"],
  configDir: process.cwd(),
};
