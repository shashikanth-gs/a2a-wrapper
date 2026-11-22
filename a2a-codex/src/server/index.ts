/**
 * A2A Server Bootstrap — a2a-codex
 *
 * Thin wrapper around `@a2a-wrapper/core`'s `createProviderServer`. All A2A protocol wiring (agent card, JSON-RPC/REST
 * transports, version negotiation, the run runtime) lives in core — this file only supplies the Codex provider, the
 * `/context` routes, the mapping of the session config onto the run runtime, and the startup banner.
 */

import { createRequire } from "node:module";
import express from "express";
import { createProviderServer, buildAgentCard } from "@a2a-wrapper/core";
import type { ProviderServerHandle, RunStore, EventTransport, EventTransportFn } from "@a2a-wrapper/core";

import type { AgentConfig } from "../config/types.js";
import { CodexProvider } from "../codex/provider.js";
import { logger } from "../utils/logger.js";

const log = logger.child("server");
const { name: WRAPPER_SDK, version: WRAPPER_SDK_VERSION } = createRequire(import.meta.url)(
  "../../package.json",
) as { name: string; version: string };

export interface ServerHandle extends ProviderServerHandle {
  provider: CodexProvider;
}

/** Programmatic options (not configuration): things a file cannot express. */
export interface CodexServerOptions {
  /**
   * Where context bindings (contextId to Codex thread) and run records live. The default is in memory: a restart then
   * forgets which Codex thread belongs to a context (the threads stay on disk, under `$CODEX_HOME/sessions`). Pass a
   * persistent `RunStore` to resume conversations across restarts.
   */
  runStore?: RunStore;
  /** Custom sideband event transport (Kafka, Redis, ...). */
  eventTransport?: EventTransport | EventTransportFn;
}

type RunRegistryOptionsOf = NonNullable<NonNullable<Parameters<typeof createProviderServer>[2]>["registry"]>;

/**
 * The run runtime's options for a config: session lifetime (hard maximum age, optional idle expiry), store.
 *
 * `session.ttl` is the maximum age of a context's thread, measured from its creation and never extended by use, exactly as
 * before: it is `bindingMaxAgeMs`; `ttl <= 0` means a context never reuses a thread (the provider binds nothing). The optional
 * `session.idleTtl` is a separate idle expiry (`bindingTtlMs`). `reuseByContext: false` binds nothing either.
 */
export function registryOptionsOf(config: Required<AgentConfig>, runStore?: RunStore): RunRegistryOptionsOf {
  const ttl = config.session.ttl ?? 3_600_000;
  const idle = config.session.idleTtl;
  return {
    ...(config.session.reuseByContext !== false && ttl > 0 ? { bindingMaxAgeMs: ttl } : {}),
    ...(idle !== undefined && idle > 0 ? { bindingTtlMs: idle } : {}),
    ...(runStore ? { store: runStore } : {}),
  };
}

/**
 * Create, wire, and start the A2A server.
 * Returns a handle that can be used to shut down.
 */
export async function createA2AServer(config: Required<AgentConfig>, options: CodexServerOptions = {}): Promise<ServerHandle> {
  const provider = new CodexProvider(config, { ...(options.eventTransport ? { eventTransport: options.eventTransport } : {}) });
  const handle = await createProviderServer<Required<AgentConfig>>(config, provider, {
    protocolVersion: "1.0",
    wrapperName: WRAPPER_SDK,
    wrapperVersion: WRAPPER_SDK_VERSION,
    ...(options.eventTransport ? { eventTransport: options.eventTransport } : {}),
    registry: registryOptionsOf(config, options.runStore),
    registerRoutes: (app) => {
      // Context API
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

      app.use("/context/build", express.json());
      app.post("/context/build", async (req, res) => {
        try {
          const customPrompt = req.body?.prompt as string | undefined;
          const response = await provider.buildContext(customPrompt);
          const content = await provider.getContextContent();
          res.json({ status: "completed", message: "Context file built successfully", response, context: content });
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
║                  Codex A2A Server                            ║
╠══════════════════════════════════════════════════════════════╣
║  Agent:         ${config.agentCard.name}
║  Workspace:     ${config.codex.workingDirectory}
║  Sandbox:       ${config.codex.sandboxMode ?? "workspace-write"}
║  Bind:          ${hostname}:${port}
║  Agent Card:    ${advertiseProtocol}://${advertiseHost}:${port}/.well-known/agent-card.json
║  JSON-RPC:      ${advertiseProtocol}://${advertiseHost}:${port}/a2a/jsonrpc
║  REST API:      ${advertiseProtocol}://${advertiseHost}:${port}/a2a/rest
║  Health:        ${advertiseProtocol}://${advertiseHost}:${port}/health
╚══════════════════════════════════════════════════════════════╝
    `);
    },
  });

  // The old background sweep forgot contexts idle for longer than `ttl`; core never schedules the binding GC, so the wrapper does.
  const ttl = config.session.ttl ?? 3_600_000;
  const interval = config.session.cleanupInterval ?? 300_000;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (config.session.reuseByContext !== false && ttl > 0 && interval > 0) {
    sweepTimer = setInterval(() => {
      handle.registry.sweepBindings({ olderThanMs: ttl }).catch((e: unknown) => {
        log.warn("Binding sweep failed", { error: e instanceof Error ? e.message : String(e) });
      });
    }, interval);
    sweepTimer.unref?.();
  } else if (ttl > 0) {
    log.info("Session cleanup sweep disabled — expired contexts are only reclaimed when they are next used", {
      ttl,
      cleanupInterval: interval,
    });
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
