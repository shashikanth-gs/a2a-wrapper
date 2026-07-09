/**
 * Default Configuration
 *
 * Wrapper-owned defaults are explicit. SDK-owned fields are intentionally left
 * unset so Antigravity SDK defaults apply by omission.
 */

import type { AgentConfig } from "./types.js";

export const DEFAULTS: Required<AgentConfig> = {
  agentCard: {
    name: "Antigravity A2A Agent",
    description: "An A2A agent backed by the Google Antigravity SDK.",
    protocolVersion: "0.3.0",
    version: "0.1.0",
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
  antigravity: {
    provider: {
      authMode: "sdkDefault",
    },
    pythonPath: "python3",
  },
  session: {
    reuseByContext: true,
    ttl: 3_600_000,
    cleanupInterval: 300_000,
  },
  features: {
    streamArtifactChunks: false,
    emitReasoning: true,
    emitToolEvents: true,
    trackUsage: true,
  },
  timeouts: {
    prompt: 600_000,
    bridgeStartup: 30_000,
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
