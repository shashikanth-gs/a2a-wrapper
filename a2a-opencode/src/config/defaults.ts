/**
 * Default Configuration Values
 *
 * Sensible defaults for every configurable aspect. If a config file
 * omits a field, the value here is used.
 */

import type { AgentConfig } from "./types.js";

/** Deep-frozen default config. Never mutate — always merge over. */
export const DEFAULTS: Readonly<Required<AgentConfig>> = Object.freeze({
  agentCard: {
    name: "OpenCode A2A Agent",
    description: "A generic A2A agent powered by OpenCode.",
    protocolVersion: "0.3.0",
    version: "1.0.0",
    skills: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  server: {
    port: 3000,
    hostname: "0.0.0.0",
    advertiseHost: "localhost",
    advertiseProtocol: "http",
  },
  opencode: {
    baseUrl: "http://localhost:4096",
    projectDirectory: "",
    model: "",
    agent: "",
    systemPrompt: "",
    systemPromptMode: "append",
    contextFile: "context.md",
    contextPrompt: "",
  },
  session: {
    titlePrefix: "A2A Session",
    reuseByContext: true,
    ttl: 3_600_000,         // 1 hour
    cleanupInterval: 300_000,  // 5 min
  },
  features: {
    autoApprovePermissions: true,
    autoAnswerQuestions: true,
    streamArtifactChunks: false,
    enablePollingFallback: true,
  },
  timeouts: {
    prompt: 600_000,          // 10 min
    pollingInterval: 2_000,
    healthCheck: 30_000,
  },
  logging: {
    level: "info",
  },
  mcp: {},
});
