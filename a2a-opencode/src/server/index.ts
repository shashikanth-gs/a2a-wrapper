/**
 * A2A Server Bootstrap — a2a-opencode
 *
 * Thin wrapper around `@a2a-wrapper/core`'s `createA2AServer`. All A2A
 * protocol wiring (agent card, JSON-RPC/REST transports, version
 * negotiation) lives in core — this file only supplies the
 * opencode-specific executor, the `/context` and `/mcp/status` routes,
 * and the startup banner.
 */

import express from "express";
import { createA2AServer as coreCreateA2AServer, buildAgentCard } from "@a2a-wrapper/core";
import type { ServerHandle as CoreServerHandle } from "@a2a-wrapper/core";

import type { AgentConfig } from "../config/types.js";
import { OpenCodeExecutor } from "../opencode/executor.js";
import { logger } from "../utils/logger.js";

const log = logger.child("server");

export interface ServerHandle extends Omit<CoreServerHandle, "executor"> {
  executor: OpenCodeExecutor;
}

/**
 * Create, wire, and start the A2A server.
 * Returns a handle that can be used to shut down.
 */
export async function createA2AServer(config: Required<AgentConfig>): Promise<ServerHandle> {
  const handle = await coreCreateA2AServer<Required<AgentConfig>>(config, (cfg) => new OpenCodeExecutor(cfg), {
    protocolVersion: "1.0",
    registerRoutes: (app, executor) => {
      const opencodeExecutor = executor as OpenCodeExecutor;

      // GET /mcp/status — return the current MCP server status from OpenCode
      app.get("/mcp/status", async (_req, res) => {
        try {
          const { getMcpStatus } = await import("../opencode/mcp-manager.js");
          const client = (opencodeExecutor as any).client;
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
          const content = await opencodeExecutor.getContextContent();
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
          const response = await opencodeExecutor.buildContext(customPrompt);
          const content = await opencodeExecutor.getContextContent();
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

  return {
    ...handle,
    executor: handle.executor as OpenCodeExecutor,
    async shutdown() {
      await handle.shutdown();
      log.info("Server shut down");
    },
  };
}

export { buildAgentCard };
