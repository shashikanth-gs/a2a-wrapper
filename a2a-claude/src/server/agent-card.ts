/**
 * Agent Card Builder
 */

import type { AgentCard } from "@a2a-js/sdk";
import { buildAgentCard as coreBuildAgentCard } from "@a2a-wrapper/core";
import type { AgentConfig } from "../config/types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("agent-card");

export function buildAgentCard(config: Required<AgentConfig>): AgentCard {
  const { agentCard, server } = config;
  const proto = server.advertiseProtocol ?? "http";
  const host = server.advertiseHost ?? server.hostname ?? "localhost";
  const port = server.port ?? 3030;

  const card = coreBuildAgentCard({ agentCard, server });

  log.info("Agent card built", {
    name: card.name,
    url: `${proto}://${host}:${port}`,
    skills: card.skills.length,
  });
  return card;
}
