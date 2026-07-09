/**
 * A2A Server Bootstrap — a2a-antigravity
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
import { AntigravityExecutor } from "../antigravity/executor.js";
import { buildAgentCard } from "./agent-card.js";
import { logger } from "../utils/logger.js";

const log = logger.child("server");

export interface ServerHandle {
  app: ReturnType<typeof express>;
  server: ReturnType<ReturnType<typeof express>["listen"]>;
  executor: AntigravityExecutor;
  shutdown(): Promise<void>;
}

export async function createA2AServer(config: Required<AgentConfig>): Promise<ServerHandle> {
  const { server: srv } = config;
  const port = srv.port ?? 3030;
  const hostname = srv.hostname ?? "0.0.0.0";
  const advertiseHost = srv.advertiseHost ?? "localhost";
  const advertiseProto = srv.advertiseProtocol ?? "http";

  const executor = new AntigravityExecutor(config);
  await executor.initialize();

  const agentCard = buildAgentCard(config);
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("A2A-Version", "0.3");
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "healthy", agent: agentCard.name });
  });

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

  const httpServer = app.listen(port, hostname, () => {
    log.info("A2A server started", {
      bind: hostname,
      port,
      agent: config.agentCard.name,
      authMode: config.antigravity.provider?.authMode ?? "sdkDefault",
    });
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║               Antigravity A2A Server                         ║
╠══════════════════════════════════════════════════════════════╣
║  Agent:         ${config.agentCard.name}
║  Auth Mode:     ${config.antigravity.provider?.authMode ?? "sdkDefault"}
║  Workspace:     ${config.antigravity.workingDirectory ?? config.antigravity.workspaces?.[0] ?? "(SDK default)"}
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
      await new Promise<void>((resolve) => {
        httpServer.close((err) => {
          if (err) log.warn("HTTP server close returned an error", { error: err.message });
          resolve();
        });
      });
      await executor.shutdown();
      log.info("Server shut down");
    },
  };
}
