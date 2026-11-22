/**
 * A2A Server Bootstrap — a2a-copilot
 *
 * Thin wrapper around `@a2a-wrapper/core`'s `createA2AServer`. All A2A
 * protocol wiring (agent card, JSON-RPC/REST transports, version
 * negotiation) lives in core — this file only supplies the
 * copilot-specific executor, the `/context` routes, and the startup banner.
 */

import { createRequire } from "node:module";
import express from "express";
import { createProviderServer, buildAgentCard } from "@a2a-wrapper/core";
import type { ProviderServerHandle, RunStore, EventTransport, EventTransportFn, InteractionPolicy } from "@a2a-wrapper/core";

import type { AgentConfig } from "../config/types.js";
import { CopilotProvider } from "../copilot/provider.js";
import { logger } from "../utils/logger.js";

const log = logger.child("server");
const { name: WRAPPER_SDK, version: WRAPPER_SDK_VERSION } = createRequire(import.meta.url)(
  "../../package.json",
) as { name: string; version: string };

export interface ServerHandle extends ProviderServerHandle {
  provider: CopilotProvider;
}

/** Programmatic options (not configuration): things a file cannot express. */
export interface CopilotServerOptions {
  /**
   * Where context bindings (contextId to Copilot session) and run records live. The default is in memory: a restart then
   * forgets which Copilot session belongs to a context. Pass a persistent `RunStore` to resume conversations across restarts.
   */
  runStore?: RunStore;
  /** Custom sideband event transport (Kafka, Redis, ...). */
  eventTransport?: EventTransport | EventTransportFn;
}

/** The interaction policy of a config: only what the operator set; core fills the defaults. */
export function interactionPolicyOf(config: Required<AgentConfig>): Partial<InteractionPolicy> {
  const i = config.interactions;
  if (!i) return {};
  return {
    ...(i.mode !== undefined ? { mode: i.mode } : {}),
    ...(i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : {}),
    ...(i.authTimeoutMs !== undefined ? { authTimeoutMs: i.authTimeoutMs } : {}),
    ...(i.onTimeout !== undefined ? { onTimeout: i.onTimeout } : {}),
    ...(i.autoAnswer !== undefined ? { autoAnswer: i.autoAnswer as InteractionPolicy["autoAnswer"] } : {}),
  };
}

/** The run runtime's options for a config: interaction policy, session lifetime (hard maximum age, optional idle expiry), store. */
export function registryOptionsOf(config: Required<AgentConfig>, runStore?: RunStore): RunRegistryOptionsOf {
  const ttl = config.session.ttl ?? 3_600_000;
  const idle = config.session.idleTtl;
  return {
    interactionPolicy: interactionPolicyOf(config),
    // `session.ttl` is a hard maximum age, as it always was: a context's session is reused only while it is younger than
    // the TTL, however recently it was used. Idle expiry is a separate, optional setting (`session.idleTtl`).
    ...(config.session.reuseByContext !== false && ttl > 0 ? { bindingMaxAgeMs: ttl } : {}),
    ...(idle !== undefined && idle > 0 ? { bindingTtlMs: idle } : {}),
    ...(runStore ? { store: runStore } : {}),
  };
}

type RunRegistryOptionsOf = NonNullable<NonNullable<Parameters<typeof createProviderServer>[2]>["registry"]>;

/**
 * Create, wire, and start the A2A server.
 * Returns a handle that can be used to shut down.
 */
export async function createA2AServer(config: Required<AgentConfig>, options: CopilotServerOptions = {}): Promise<ServerHandle> {
  const provider = new CopilotProvider(config, { ...(options.eventTransport ? { eventTransport: options.eventTransport } : {}) });
  const handle = await createProviderServer<Required<AgentConfig>>(config, provider, {
    protocolVersion: "1.0",
    wrapperName: WRAPPER_SDK,
    wrapperVersion: WRAPPER_SDK_VERSION,
    ...(options.eventTransport ? { eventTransport: options.eventTransport } : {}),
    registry: registryOptionsOf(config, options.runStore),
    registerRoutes: (app) => {
      const copilotExecutor = provider;

      // GET /context — return the context.md file as markdown
      app.get("/context", async (_req, res) => {
        try {
          const content = await copilotExecutor.getContextContent();
          if (content === null) {
            res.status(404).json({ error: "Context file not found. Use POST /context/build to create it." });
            return;
          }
          res.type("text/markdown").send(content);
        } catch (e) {
          log.error("Failed to read context", { error: (e as Error).message });
          res.status(500).json({ error: (e as Error).message });
        }
      });

      // POST /context/build — build or refresh the context file
      app.use("/context/build", express.json());
      app.post("/context/build", async (req, res) => {
        try {
          const customPrompt = req.body?.prompt as string | undefined;
          log.info("Context build requested", { customPrompt: !!customPrompt });
          const response = await copilotExecutor.buildContext(customPrompt);
          const content = await copilotExecutor.getContextContent();
          res.json({
            status: "completed",
            message: "Context file built successfully",
            response,
            context: content,
          });
        } catch (e) {
          log.error("Context build failed", { error: (e as Error).message });
          res.status(500).json({ error: (e as Error).message });
        }
      });
    },
    onListening: ({ port, hostname, advertiseHost, advertiseProtocol }) => {
      log.info("A2A server started", { bind: hostname, advertise: advertiseHost, port, proto: advertiseProtocol });
      console.log(`
╔══════════════════════════════════════════════════════════════╗
║              GitHub Copilot A2A Server                       ║
╠══════════════════════════════════════════════════════════════╣
║  Agent:         ${config.agentCard.name}
║  Bind Address:  ${hostname}:${port}
║  Agent Card:    ${advertiseProtocol}://${advertiseHost}:${port}/.well-known/agent-card.json
║  JSON-RPC:      ${advertiseProtocol}://${advertiseHost}:${port}/a2a/jsonrpc
║  REST API:      ${advertiseProtocol}://${advertiseHost}:${port}/a2a/rest
║  Context:       ${advertiseProtocol}://${advertiseHost}:${port}/context
║  Build Context: ${advertiseProtocol}://${advertiseHost}:${port}/context/build  [POST]
║  Health Check:  ${advertiseProtocol}://${advertiseHost}:${port}/health
╠══════════════════════════════════════════════════════════════╣
║  Ready to receive A2A requests from any compatible client!   ║
╚══════════════════════════════════════════════════════════════╝
    `);
    },
  });

  return {
    ...handle,
    provider,
    async shutdown() {
      await handle.shutdown();
      log.info("Server shut down");
    },
  };
}

export { buildAgentCard };
