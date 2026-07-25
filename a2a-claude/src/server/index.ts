/**
 * A2A Server Bootstrap — a2a-claude
 *
 * Thin wrapper around `@a2a-wrapper/core`'s `createA2AServer`. All A2A
 * protocol wiring (agent card, JSON-RPC/REST transports, version
 * negotiation) lives in core — this file only supplies the
 * claude-specific executor, the `/context` routes, and the startup banner.
 */

import express from "express";
import { createA2AServer as coreCreateA2AServer } from "@a2a-wrapper/core";
import type { ServerHandle as CoreServerHandle } from "@a2a-wrapper/core";

import type { AgentConfig } from "../config/types.js";
import { ClaudeExecutor } from "../claude/executor.js";
import { logger } from "../utils/logger.js";

const log = logger.child("server");

export interface ServerHandle extends Omit<CoreServerHandle, "executor"> {
  executor: ClaudeExecutor;
}

export async function createA2AServer(config: Required<AgentConfig>): Promise<ServerHandle> {
  const handle = await coreCreateA2AServer<Required<AgentConfig>>(config, (cfg) => new ClaudeExecutor(cfg), {
    protocolVersion: "1.0",
    registerRoutes: (app, executor) => {
      const claudeExecutor = executor as ClaudeExecutor;

      // Context API
      app.get("/context", async (_req, res) => {
        try {
          const content = await claudeExecutor.getContextContent();
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
          const response = await claudeExecutor.buildContext(customPrompt);
          const content = await claudeExecutor.getContextContent();
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
║                  Claude A2A Server                           ║
╠══════════════════════════════════════════════════════════════╣
║  Agent:         ${config.agentCard.name}
║  Workspace:     ${config.claude.workingDirectory}
║  Permission:    ${config.claude.permissionMode ?? "acceptEdits"}
║  Bind:          ${hostname}:${port}
║  Agent Card:    ${advertiseProtocol}://${advertiseHost}:${port}/.well-known/agent-card.json
║  JSON-RPC:      ${advertiseProtocol}://${advertiseHost}:${port}/a2a/jsonrpc
║  REST API:      ${advertiseProtocol}://${advertiseHost}:${port}/a2a/rest
║  Health:        ${advertiseProtocol}://${advertiseHost}:${port}/health
╚══════════════════════════════════════════════════════════════╝
    `);
    },
  });

  return {
    ...handle,
    executor: handle.executor as ClaudeExecutor,
    async shutdown() {
      await handle.shutdown();
      log.info("Server shut down");
    },
  };
}
