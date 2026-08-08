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
 * 3. `stateTransitionHistory` is never set (field removed in A2A v1.0).
 *
 * A2A v1.0 note: `buildAgentCard` produces the native v1.0 `AgentCard` shape
 * (`supportedInterfaces[]`), with a mirrored v0.3 interface entry per
 * transport binding (via `duplicateInterfacesForLegacy`) so that
 * `legacyCompat`-enabled JSON-RPC/REST handlers in `server/factory.ts` can
 * keep serving v0.3 clients on the same endpoint. `factory.ts` also serves a
 * fully v0.3-shaped card (via {@link buildLegacyAgentCard}) to callers that
 * haven't adopted the `A2A-Version` header at all.
 *
 * @module server/agent-card
 */

import type { AgentCard, AgentInterface } from "@a2a-js/sdk";
import { duplicateInterfacesForLegacy } from "@a2a-js/sdk/compat/v0_3";
import type { AgentCardConfig, ServerConfig, SkillConfig } from "../config/types.js";

/**
 * Extension URI for trace/observability sideband artifacts.
 *
 * Declared in agent card `capabilities.extensions` so orchestrators can
 * discover that this agent emits sideband data. Referenced on each trace
 * artifact via `artifact.extensions` so consumers can reliably filter
 * trace artifacts from real response artifacts at the protocol level.
 */
export const TRACE_EXTENSION_URI = "urn:x-a2a:trace:v1";

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
 * `examples`, `inputModes`, `outputModes`, and `securityRequirements` are
 * required (non-optional) arrays on the A2A v1.0 `AgentSkill` type — they
 * default to `[]` when not configured.
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
    examples: skill.examples ?? [],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  };
}

/**
 * Computes the JSON-RPC and REST endpoint URLs advertised on the agent card
 * from the resolved `server` configuration section.
 *
 * @internal
 */
function computeEndpointUrls(server: ServerConfig): { jsonRpcUrl: string; restUrl: string } {
  const host = server.advertiseHost ?? server.hostname ?? "localhost";
  const port = server.port ?? 3000;
  // Use configured protocol; defaults to "http" for local dev.
  // Set advertiseProtocol: "https" in config for production deployments.
  const proto = server.advertiseProtocol ?? "http";
  const baseUrl = `${proto}://${host}:${port}`;
  return { jsonRpcUrl: `${baseUrl}/a2a/jsonrpc`, restUrl: `${baseUrl}/a2a/rest` };
}

/**
 * Builds the `capabilities.extensions` entry declaring the trace/observability
 * sideband extension, shared by both the v1.0 and legacy v0.3 card shapes.
 *
 * @internal
 */
function buildTraceExtension() {
  return {
    uri: TRACE_EXTENSION_URI,
    description:
      "Emits trace.mcp and trace.thought sideband artifacts for observability. " +
      "These artifacts carry MCP tool call evidence and agent reasoning and " +
      "should be forwarded to telemetry sinks, not to the LLM.",
    required: false,
    params: undefined,
  };
}

/**
 * Constructs the native A2A v1.0 {@link AgentCard} for a given pair of
 * JSON-RPC / REST endpoint URLs.
 *
 * Split out from {@link buildAgentCard} so that `server/factory.ts` can
 * rebuild a per-request card (with URLs rewritten for the caller's
 * `Host`/`X-Forwarded-Proto`) without recomputing the rest of the card.
 *
 * @internal
 */
export function buildAgentCardForUrls(
  agentCard: AgentCardConfig,
  jsonRpcUrl: string,
  restUrl: string,
): AgentCard {
  // supportedInterfaces: advertise v1.0 JSON-RPC + REST bindings, plus a
  // mirrored v0.3-protocolVersion entry per binding so that `legacyCompat`
  // JSON-RPC/REST handlers (see server/factory.ts) have a legacy interface
  // to point v0.3 clients at.
  const interfacesWithV03: AgentInterface[] = duplicateInterfacesForLegacy(
    [
      { url: jsonRpcUrl, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" },
      { url: restUrl, protocolBinding: "HTTP+JSON", tenant: "", protocolVersion: "1.0" },
    ],
    ["JSONRPC", "HTTP+JSON"],
  );

  // The v0.3 ecosystem used both "0.3" (the SDK's canonical value) and
  // "0.3.0" (the value historically advertised by this project). SDK
  // request validation is an exact string match, so advertise both aliases
  // to keep clients using either form compatible.
  const supportedInterfaces: AgentInterface[] = [
    ...interfacesWithV03,
    ...interfacesWithV03
      .filter((intf) => intf.protocolVersion === "0.3")
      .map((intf) => ({ ...intf, protocolVersion: "0.3.0" })),
  ];

  return {
    name: agentCard.name,
    description: agentCard.description,
    supportedInterfaces,
    provider: agentCard.provider
      ? { organization: agentCard.provider.organization, url: agentCard.provider.url ?? "" }
      : undefined,
    version: agentCard.version ?? "1.0.0",
    capabilities: {
      streaming: agentCard.streaming ?? true,
      pushNotifications: agentCard.pushNotifications ?? false,
      // stateTransitionHistory is intentionally omitted: the field was
      // removed from AgentCapabilities entirely in A2A v1.0, not merely
      // defaulted to false.
      extensions: [buildTraceExtension()],
      // Replaces the old top-level `supportsAuthenticatedExtendedCard`.
      extendedAgentCard: false,
    },
    // Required (not optional) on the v1.0 AgentCard type — empty when unused.
    securitySchemes: {},
    securityRequirements: [],
    skills: (agentCard.skills ?? []).map(mapSkill),
    defaultInputModes: agentCard.defaultInputModes ?? ["text"],
    defaultOutputModes: agentCard.defaultOutputModes ?? ["text"],
    // Populated by server/factory.ts when Signed Agent Card support is
    // enabled (ServerOptions.agentCardSigning); empty for unsigned cards.
    signatures: [],
  };
}

/**
 * Constructs an A2A {@link AgentCard} from resolved configuration.
 *
 * Produces the native A2A v1.0 card shape (`supportedInterfaces[]`), with a
 * mirrored v0.3 interface entry per transport binding so that
 * `legacyCompat`-enabled JSON-RPC/REST handlers can keep serving v0.3
 * clients transparently. See the module-level doc comment for how full
 * backward compatibility (including the `/.well-known/agent-card.json`
 * route itself) is achieved.
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
  const { jsonRpcUrl, restUrl } = computeEndpointUrls(server);
  return buildAgentCardForUrls(agentCard, jsonRpcUrl, restUrl);
}

/**
 * Shape of the legacy (pre-v1.0) A2A `AgentCard`, as served to callers whose
 * `A2A-Version` request header falls in the `[0.3, 1.0)` range or is absent
 * entirely (old clients that predate the header). Kept only for this
 * backward-compat purpose — the SDK's own `toCompatAgentCard` translator is
 * not publicly exported, so `server/factory.ts` builds this shape directly
 * rather than relying on the SDK's `agentCardHandler` (whose zero-argument
 * `AgentCardProvider` can't support this repo's per-request dynamic URL
 * rewriting — see `server/factory.ts` for details).
 */
export interface LegacyAgentCard {
  name: string;
  description: string;
  url: string;
  provider?: { organization: string; url: string };
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
    extensions: { uri: string; description: string }[];
  };
  protocolVersion: string;
  skills: ReturnType<typeof mapSkill>[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  additionalInterfaces: { transport: string; url: string }[];
  supportsAuthenticatedExtendedCard: boolean;
}

/**
 * Constructs the legacy v0.3-shaped {@link LegacyAgentCard} for a given pair
 * of JSON-RPC / REST endpoint URLs. See {@link LegacyAgentCard}.
 */
export function buildLegacyAgentCard(
  agentCard: AgentCardConfig,
  jsonRpcUrl: string,
  restUrl: string,
): LegacyAgentCard {
  return {
    name: agentCard.name,
    description: agentCard.description,
    url: jsonRpcUrl,
    ...(agentCard.provider
      ? { provider: { organization: agentCard.provider.organization, url: agentCard.provider.url ?? "" } }
      : {}),
    version: agentCard.version ?? "1.0.0",
    capabilities: {
      streaming: agentCard.streaming ?? true,
      pushNotifications: agentCard.pushNotifications ?? false,
      stateTransitionHistory: false,
      extensions: [buildTraceExtension()],
    },
    protocolVersion: "0.3.0",
    skills: (agentCard.skills ?? []).map(mapSkill),
    defaultInputModes: agentCard.defaultInputModes ?? ["text"],
    defaultOutputModes: agentCard.defaultOutputModes ?? ["text"],
    additionalInterfaces: [
      { transport: "JSONRPC", url: jsonRpcUrl },
      { transport: "REST", url: restUrl },
    ],
    supportsAuthenticatedExtendedCard: false,
  };
}
