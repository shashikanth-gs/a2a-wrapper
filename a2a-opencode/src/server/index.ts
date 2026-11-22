/**
 * A2A Server Bootstrap — a2a-opencode
 *
 * Thin wrapper around `@a2a-wrapper/core`'s `createProviderServer`. All A2A protocol wiring (agent card, JSON-RPC/REST
 * transports, version negotiation, the run runtime) lives in core — this file only supplies the OpenCode provider, the
 * `/context` and `/mcp/status` routes, the mapping of the session and interaction config onto the run runtime, and the startup
 * banner.
 */

import { createRequire } from "node:module";
import express from "express";
import { createProviderServer, buildAgentCard } from "@a2a-wrapper/core";
import type { ProviderServerHandle, RunStore, EventTransport, EventTransportFn, InteractionPolicy } from "@a2a-wrapper/core";

import type { AgentConfig } from "../config/types.js";
import { getMcpStatus } from "../opencode/mcp-manager.js";
import { OpenCodeProvider } from "../opencode/provider.js";
import { logger } from "../utils/logger.js";

const log = logger.child("server");
const { name: WRAPPER_SDK, version: WRAPPER_SDK_VERSION } = createRequire(import.meta.url)(
  "../../package.json",
) as { name: string; version: string };

export interface ServerHandle extends ProviderServerHandle {
  provider: OpenCodeProvider;
}

/** Programmatic options (not configuration): things a file cannot express. */
export interface OpenCodeServerOptions {
  /**
   * Where context bindings (contextId to OpenCode session) and run records live. The default is in memory: a restart then
   * forgets which OpenCode session belongs to a context (the sessions stay on the OpenCode server). Pass a persistent `RunStore`
   * to resume conversations across restarts.
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

type RunRegistryOptionsOf = NonNullable<NonNullable<Parameters<typeof createProviderServer>[2]>["registry"]>;

/**
 * The run runtime's options for a config: interaction policy, session lifetime, store.
 *
 * `session.ttl` has always been an IDLE expiry here (each message renews a context), so it is `bindingTtlMs`; `ttl <= 0` means no
 * expiry. The optional `session.maxAge` is a hard maximum age of the session (`bindingMaxAgeMs`), measured from its creation and
 * never extended by use. `reuseByContext: false` binds nothing (the provider never calls `run.bind`).
 */
export function registryOptionsOf(config: Required<AgentConfig>, runStore?: RunStore): RunRegistryOptionsOf {
  const ttl = config.session.ttl ?? 0;
  const maxAge = config.session.maxAge;
  return {
    interactionPolicy: interactionPolicyOf(config),
    ...(ttl > 0 ? { bindingTtlMs: ttl } : {}),
    ...(maxAge !== undefined && maxAge > 0 ? { bindingMaxAgeMs: maxAge } : {}),
    ...(runStore ? { store: runStore } : {}),
  };
}

/**
 * Create, wire, and start the A2A server.
 * Returns a handle that can be used to shut down.
 */
export async function createA2AServer(config: Required<AgentConfig>, options: OpenCodeServerOptions = {}): Promise<ServerHandle> {
  const provider = new OpenCodeProvider(config, { ...(options.eventTransport ? { eventTransport: options.eventTransport } : {}) });
  const handle = await createProviderServer<Required<AgentConfig>>(config, provider, {
    protocolVersion: "1.0",
    wrapperName: WRAPPER_SDK,
    wrapperVersion: WRAPPER_SDK_VERSION,
    ...(options.eventTransport ? { eventTransport: options.eventTransport } : {}),
    registry: registryOptionsOf(config, options.runStore),
    registerRoutes: (app) => {
      // GET /mcp/status — return the current MCP server status from OpenCode
      app.get("/mcp/status", async (_req, res) => {
        try {
          const client = provider.backend;
          const dir = config.opencode?.projectDirectory || undefined;
          if (!client) {
            res.status(503).json({ error: "Executor not initialized" });
            return;
          }
          const status = await getMcpStatus(client, dir);
          log.info("MCP status queried via API", { status: JSON.stringify(status) });
          res.json({ mcp: status, configuredServers: Object.keys(config.mcp || {}) });
        } catch (e) {
          log.error("MCP status query failed", { error: (e as Error).message });
          res.status(500).json({ error: (e as Error).message });
        }
      });

      // GET /context — return the context.md file as markdown
      app.get("/context", async (_req, res) => {
        try {
          const content = await provider.getContextContent();
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
          const response = await provider.buildContext(customPrompt);
          const content = await provider.getContextContent();
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
║                   OpenCode A2A Server                        ║
╠══════════════════════════════════════════════════════════════╣
║  Agent:         ${config.agentCard.name}
║  Bind Address:  ${hostname}:${port}
║  Agent Card:    ${advertiseProtocol}://${advertiseHost}:${port}/.well-known/agent-card.json
║  JSON-RPC:      ${advertiseProtocol}://${advertiseHost}:${port}/a2a/jsonrpc
║  REST API:      ${advertiseProtocol}://${advertiseHost}:${port}/a2a/rest
║  Context:       ${advertiseProtocol}://${advertiseHost}:${port}/context
║  Build Context: ${advertiseProtocol}://${advertiseHost}:${port}/context/build  [POST]
║  MCP Status:    ${advertiseProtocol}://${advertiseHost}:${port}/mcp/status
║  Health Check:  ${advertiseProtocol}://${advertiseHost}:${port}/health
╠══════════════════════════════════════════════════════════════╣
║  Ready to receive A2A requests from any compatible client!   ║
╚══════════════════════════════════════════════════════════════╝
    `);
    },
  });

  // The old background sweep forgot contexts idle for longer than `ttl`; core never schedules the binding GC, so the wrapper does.
  const ttl = config.session.ttl ?? 0;
  const interval = config.session.cleanupInterval ?? 0;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (ttl > 0 && interval > 0) {
    sweepTimer = setInterval(() => {
      handle.registry.sweepBindings({ olderThanMs: ttl }).catch((e: unknown) => {
        log.warn("Binding sweep failed", { error: e instanceof Error ? e.message : String(e) });
      });
    }, interval);
    sweepTimer.unref?.();
  } else if (ttl > 0) {
    log.info("Session cleanup sweep disabled — expired sessions are only reclaimed when their context is next used", {
      ttl,
      cleanupInterval: interval,
    });
  } else {
    log.info("Session expiry disabled — a context resumes its OpenCode session indefinitely", { ttl });
  }

  return {
    ...handle,
    provider,
    async shutdown() {
      if (sweepTimer) clearInterval(sweepTimer);
      await handle.shutdown();
      log.info("Server shut down");
    },
  };
}

export { buildAgentCard };
