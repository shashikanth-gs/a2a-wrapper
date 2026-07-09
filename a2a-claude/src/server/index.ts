/**
 * A2A Server Bootstrap — a2a-claude
 *
 * Creates an Express server with:
 *  - /.well-known/agent-card.json  → Agent Card
 *  - /a2a/jsonrpc                  → JSON-RPC transport
 *  - /a2a/rest                     → REST transport
 *  - /health                       → Health check
 *  - /context                      → Read context file
 *  - /context/build                → Build context file (POST)
 */

import express, { type RequestHandler } from "express";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import {
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";

import type { AgentConfig } from "../config/types.js";
import { ClaudeExecutor } from "../claude/executor.js";
import { buildAgentCard } from "./agent-card.js";
import { logger } from "../utils/logger.js";

const log = logger.child("server");

export interface ServerHandle {
  app: ReturnType<typeof express>;
  server: ReturnType<ReturnType<typeof express>["listen"]>;
  executor: ClaudeExecutor;
  shutdown(): Promise<void>;
}

export async function createA2AServer(config: Required<AgentConfig>): Promise<ServerHandle> {
  const { server: srv } = config;
  const port = srv.port ?? 3030;
  const hostname = srv.hostname ?? "0.0.0.0";
  const advertiseHost = srv.advertiseHost ?? "localhost";
  const advertiseProto = srv.advertiseProtocol ?? "http";

  // 1. Executor
  const executor = new ClaudeExecutor(config);
  await executor.initialize();

  // 2. Agent card
  const agentCard = buildAgentCard(config);

  // 3. A2A request handler
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

  // 4. Express app
  const app = express();

  app.use((_req, res, next) => {
    res.setHeader("A2A-Version", "0.3");
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "healthy", agent: agentCard.name });
  });

  // Dynamic agent card handler — rewrites endpoint URLs to match caller's Host header
  const serveAgentCard: RequestHandler = (req, res) => {
    const host = req.headers.host || `${advertiseHost}:${port}`;
    const proto = (req.headers["x-forwarded-proto"] as string) || advertiseProto;
    const dynamicBase = `${proto}://${host}`;
    const jsonRpcUrl = `${dynamicBase}/a2a/jsonrpc`;
    const restUrl = `${dynamicBase}/a2a/rest`;
    res.json({
      ...agentCard,
      url: jsonRpcUrl,
      additionalInterfaces: [
        { transport: "JSONRPC", url: jsonRpcUrl },
        { transport: "REST", url: restUrl },
      ],
    });
  };

  app.get(`/${AGENT_CARD_PATH}`, serveAgentCard);
  for (const p of [".well-known/agent.json", ".well-known/agent-json"]) {
    if (p !== AGENT_CARD_PATH) app.get(`/${p}`, serveAgentCard);
  }

  app.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  app.use("/a2a/rest", restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  // Context API
  app.get("/context", async (_req, res) => {
    try {
      const content = await executor.getContextContent();
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
      const response = await executor.buildContext(customPrompt);
      const content = await executor.getContextContent();
      res.json({ status: "completed", message: "Context file built successfully", response, context: content });
    } catch (e) {
      log.error("Context build failed", { error: (e as Error).message });
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // 5. Start
  const httpServer = app.listen(port, hostname, () => {
    log.info("A2A server started", { bind: hostname, advertise: advertiseHost, port, proto: advertiseProto });
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                  Claude A2A Server                           ║
╠══════════════════════════════════════════════════════════════╣
║  Agent:         ${agentCard.name}
║  Workspace:     ${config.claude.workingDirectory}
║  Permission:    ${config.claude.permissionMode ?? "acceptEdits"}
║  Bind:          ${hostname}:${port}
║  Agent Card:    ${advertiseProto}://${advertiseHost}:${port}/${AGENT_CARD_PATH}
║  JSON-RPC:      ${advertiseProto}://${advertiseHost}:${port}/a2a/jsonrpc
║  REST API:      ${advertiseProto}://${advertiseHost}:${port}/a2a/rest
║  Health:        ${advertiseProto}://${advertiseHost}:${port}/health
╚══════════════════════════════════════════════════════════════╝
    `);
  });

  return {
    app,
    server: httpServer,
    executor,
    async shutdown() {
      httpServer.close();
      await executor.shutdown();
      log.info("Server shut down");
    },
  };
}
