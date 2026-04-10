/**
 * Agent Card Builder
 *
 * Delegates to the shared @a2a-wrapper/core implementation and adds logging.
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
  const port = server.port ?? 3000;

  const card = coreBuildAgentCard({ agentCard, server });

  log.info("Agent card built", { name: card.name, url: `${proto}://${host}:${port}`, proto, skills: card.skills.length });
  return card;
}
