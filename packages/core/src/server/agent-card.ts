/**
 * Agent Card Builder
 *
 * Constructs an A2A-spec-compliant {@link AgentCard} from resolved
 * {@link AgentCardConfig} and {@link ServerConfig} sections. This module
 * is the single source of truth for agent card construction across all
 * wrapper projects, ensuring consistent endpoint URL computation,
 * capability flag mapping, and skill serialization.
 *
 * Ported from `a2a-copilot/src/server/agent-card.ts` with the following
 * changes for core-package reuse:
 *
 * 1. Accepts `{ agentCard, server }` instead of a full `AgentConfig`.
 * 2. No logger dependency — the core package does not own a singleton logger.
 * 3. `stateTransitionHistory` is always `false` (removed in A2A v1.0).
 *
 * @module server/agent-card
 */

import type { AgentCard } from "@a2a-js/sdk";
import type { AgentCardConfig, ServerConfig, SkillConfig } from "../config/types.js";

/**
 * Input shape accepted by {@link buildAgentCard}.
 *
 * Only the `agentCard` and `server` configuration sections are required to
 * construct a complete agent card. This keeps the builder decoupled from
 * backend-specific configuration and session/timeout settings.
 */
export interface BuildAgentCardInput {
  /** Agent identity and capability configuration. */
  agentCard: AgentCardConfig;
  /** Server networking configuration used to compute endpoint URLs. */
  server: ServerConfig;
}

/**
 * Maps a {@link SkillConfig} to the A2A `AgentSkill` shape expected by the SDK.
 *
 * The `examples` field is included only when the source array is non-empty,
 * keeping the serialized agent card minimal.
 *
 * @param skill - The skill configuration to transform.
 * @returns An object conforming to the A2A `AgentSkill` interface.
 *
 * @internal
 */
function mapSkill(skill: SkillConfig) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags ?? [],
    ...(skill.examples?.length ? { examples: skill.examples } : {}),
  };
}

/**
 * Constructs an A2A {@link AgentCard} from resolved configuration.
 *
 * Computes endpoint URLs from the `server` section, maps capability flags
 * and skills from the `agentCard` section, and advertises both JSON-RPC and
 * REST transports via `additionalInterfaces`.
 *
 * Key behaviors:
 * - `stateTransitionHistory` is always set to `false` regardless of input,
 *   because this capability was removed in the A2A v1.0 specification.
 * - The primary `url` field points to the JSON-RPC endpoint for backward
 *   compatibility with v0.3.x clients.
 * - `protocolVersion` defaults to `"0.3.0"` when not explicitly configured.
 * - `supportsAuthenticatedExtendedCard` is always `false` unless explicitly
 *   configured otherwise in a future extension.
 *
 * @param config - Object containing `agentCard` and `server` configuration
 *   sections. See {@link BuildAgentCardInput} for the expected shape.
 * @returns A fully populated {@link AgentCard} ready to be served at
 *   `/.well-known/agent-card.json`.
 *
 * @example
 * ```typescript
 * import { buildAgentCard } from "@a2a-wrapper/core";
 *
 * const card = buildAgentCard({
 *   agentCard: { name: "My Agent", description: "Does things" },
 *   server: { port: 3000, advertiseHost: "localhost" },
 * });
 * ```
 */
export function buildAgentCard(config: BuildAgentCardInput): AgentCard {
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

  return card;
}
