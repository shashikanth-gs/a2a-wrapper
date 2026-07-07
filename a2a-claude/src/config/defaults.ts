/**
 * Default Configuration
 *
 * Secure defaults applied when no config file or env override is present.
 */

import type { AgentConfig } from "./types.js";

export const DEFAULTS: Required<AgentConfig> = {
  agentCard: {
    name: "Claude A2A Agent",
    description: "A repository-scoped software engineering agent backed by Claude Code.",
    protocolVersion: "0.3.0",
    version: "1.0.0",
    streaming: true,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [],
    pushNotifications: false,
  },
  server: {
    port: 3030,
    hostname: "0.0.0.0",
    advertiseHost: "localhost",
    advertiseProtocol: "http",
  },
  claude: {
    workingDirectory: "",              // required; validated on startup
    permissionMode: "acceptEdits",     // headless default: edits allowed, no prompts
    allowedTools: [],
    disallowedTools: [],
    settingSources: [],                // isolation: no host ~/.claude leakage
    additionalDirectories: [],
    dangerouslyAllowBypassPermissions: false,
    contextFile: "context.md",
  },
  session: {
    reuseByContext: true,
    ttl: 3_600_000,
    cleanupInterval: 300_000,
  },
  features: {
    streamArtifactChunks: false,
    emitThinkingEvents: true,
    emitToolEvents: true,
    emitFileChangeEvents: true,
    emitTodoEvents: true,
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
  configDir: process.cwd(),
};
