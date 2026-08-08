/**
 * A2A Server Bootstrap — a2a-copilot
 *
 * Thin wrapper around `@a2a-wrapper/core`'s `createA2AServer`. All A2A
 * protocol wiring (agent card, JSON-RPC/REST transports, version
 * negotiation) lives in core — this file only supplies the
 * copilot-specific executor, the `/context` routes, and the startup banner.
 */

import express from "express";
import { createA2AServer as coreCreateA2AServer, buildAgentCard } from "@a2a-wrapper/core";
import type { ServerHandle as CoreServerHandle } from "@a2a-wrapper/core";

import type { AgentConfig } from "../config/types.js";
import { CopilotExecutor } from "../copilot/executor.js";
import { logger } from "../utils/logger.js";

const log = logger.child("server");

export interface ServerHandle extends Omit<CoreServerHandle, "executor"> {
  executor: CopilotExecutor;
}

/**
 * Create, wire, and start the A2A server.
 * Returns a handle that can be used to shut down.
 */
export async function createA2AServer(config: Required<AgentConfig>): Promise<ServerHandle> {
  const handle = await coreCreateA2AServer<Required<AgentConfig>>(config, (cfg) => new CopilotExecutor(cfg), {
    protocolVersion: "1.0",
    registerRoutes: (app, executor) => {
      const copilotExecutor = executor as CopilotExecutor;

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
    executor: handle.executor as CopilotExecutor,
    async shutdown() {
      await handle.shutdown();
      log.info("Server shut down");
    },
  };
}

export { buildAgentCard };
