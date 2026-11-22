import { configFor } from "./scenarios.js";

export interface ConfigOptions {
  streaming?: boolean;
  chunks?: boolean;
  trackUsage?: boolean;
  /** Section overrides, merged one level deep. */
  copilot?: Record<string, unknown>;
  session?: Record<string, unknown>;
  timeouts?: Record<string, unknown>;
  features?: Record<string, unknown>;
  events?: Record<string, unknown>;
  interactions?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
}

/** The minimal `Required<AgentConfig>` the provider needs. */
export function makeConfig(o: ConfigOptions = {}): any {
  const base = configFor({
    name: "test",
    ...(o.streaming !== undefined ? { streaming: o.streaming } : {}),
    streamArtifactChunks: o.chunks === true,
    trackUsage: o.trackUsage === true,
    steps: [],
  });
  base.agentCard = { name: "Test Agent", description: "test" };
  base.copilot = { ...base.copilot, model: "gpt-4", ...(o.copilot ?? {}) };
  base.session = { ...base.session, cleanupInterval: 0, ...(o.session ?? {}) };
  base.timeouts = { ...base.timeouts, ...(o.timeouts ?? {}) };
  base.features = { ...base.features, ...(o.features ?? {}) };
  if (o.events) base.events = o.events;
  if (o.interactions) base.interactions = o.interactions;
  if (o.mcp) base.mcp = o.mcp;
  return base;
}
