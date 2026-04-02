/**
 * Agent Card Builder
 *
 * Constructs an A2A AgentCard from the resolved AgentConfig.
 */

import type { AgentCard } from "@a2a-js/sdk";
import type { AgentConfig, SkillConfig } from "../config/types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("agent-card");

function mapSkill(skill: SkillConfig) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags ?? [],
    ...(skill.examples?.length ? { examples: skill.examples } : {}),
  };
}

export function buildAgentCard(config: Required<AgentConfig>): AgentCard {
  const { agentCard, server } = config;
  const host = server.advertiseHost ?? server.hostname ?? "localhost";
  const port = server.port ?? 3000;
  // Use configured protocol; defaults to "http" for local dev.
  // Set advertiseProtocol: "https" in config for production deployments.
  const proto = server.advertiseProtocol ?? "http";
  const baseUrl = `${proto}://${host}:${port}`;
  const jsonRpcUrl = `${baseUrl}/a2a/jsonrpc`;
  const restUrl = `${baseUrl}/a2a/rest`;

  const card: AgentCard = {
    name: agentCard.name,
    description: agentCard.description,
    // Primary endpoint (v0.3.x required field; retained for backward compat with
    // v0.3.x clients and the current SDK, which still reads this field).
    url: jsonRpcUrl,
    ...(agentCard.provider
      ? { provider: { organization: agentCard.provider.organization, url: agentCard.provider.url ?? "" } }
      : {}),
    version: agentCard.version ?? "1.0.0",
    capabilities: {
      streaming: agentCard.streaming ?? true,
      pushNotifications: agentCard.pushNotifications ?? false,
      // stateTransitionHistory was removed in A2A v1.0 as unimplemented.
      // We advertise false so v0.3.x clients that check this flag don't expect history.
      stateTransitionHistory: false,
    },
    // Retain protocolVersion for v0.3.x client backward compatibility.
    // When the SDK ships v1.0 types this moves into additionalInterfaces[].protocolVersion.
    protocolVersion: agentCard.protocolVersion ?? "0.3.0",
    skills: (agentCard.skills ?? []).map(mapSkill),
    defaultInputModes: agentCard.defaultInputModes ?? ["text"],
    defaultOutputModes: agentCard.defaultOutputModes ?? ["text"],
    // additionalInterfaces: advertise all supported transports so that v1.0-aware
    // clients can discover the REST endpoint and future protocol versions.
    additionalInterfaces: [
      { transport: "JSONRPC", url: jsonRpcUrl },
      { transport: "REST",    url: restUrl },
    ],
    // Do not advertise an authenticated extended card unless explicitly configured.
    supportsAuthenticatedExtendedCard: false,
  };

  log.info("Agent card built", { name: card.name, url: baseUrl, proto, skills: card.skills.length });
  return card;
}
