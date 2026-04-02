/**
 * A2A Server Bootstrap
 *
 * Creates an Express server with:
 *  - /.well-known/agent-card.json  → Agent Card
 *  - /a2a/jsonrpc                  → JSON-RPC transport
 *  - /a2a/rest                     → REST transport
 *  - /health                       → Health check
 *  - /context                      → Read context file
 *  - /context/build                → Build context file
 *  - /mcp/status                   → MCP server status
 *
 * All wiring is driven by the resolved AgentConfig.
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
import { OpenCodeExecutor } from "../opencode/executor.js";
import { buildAgentCard } from "./agent-card.js";
import { logger } from "../utils/logger.js";

const log = logger.child("server");

export interface ServerHandle {
  app: ReturnType<typeof express>;
  server: ReturnType<ReturnType<typeof express>["listen"]>;
  executor: OpenCodeExecutor;
  shutdown(): Promise<void>;
}

/**
 * Create, wire, and start the A2A server.
 * Returns a handle that can be used to shut down.
 */
export async function createA2AServer(config: Required<AgentConfig>): Promise<ServerHandle> {
  const { server: srv } = config;
  const port = srv.port ?? 3000;
  const hostname = srv.hostname ?? "0.0.0.0";
  const advertiseHost = srv.advertiseHost ?? "localhost";
  const advertiseProto = srv.advertiseProtocol ?? "http";

  // 1. Executor
  const executor = new OpenCodeExecutor(config);
  await executor.initialize();

  // 2. Agent card
  const agentCard = buildAgentCard(config);

  // 3. A2A request handler
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

  // 4. Express app
  const app = express();

  // ── A2A-Version header middleware ────────────────────────────────────────
  // Log the client's requested protocol version and respond with the version
  // this server implements. This supports future version negotiation.
  app.use((req, _res, next) => {
    const clientVersion = req.headers["a2a-version"] as string | undefined;
    if (clientVersion) {
      log.debug("A2A-Version header received", { clientVersion, path: req.path });
    }
    next();
  });
  app.use((_req, res, next) => {
    res.setHeader("A2A-Version", "0.3");
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "healthy", agent: agentCard.name });
  });

  // Dynamic agent card handler — rewrites endpoint URLs to match the caller's
  // Host + x-forwarded-proto headers so clients behind Docker / reverse proxies
  // reach the correct address for JSON-RPC / REST endpoints.
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
        { transport: "REST",    url: restUrl },
      ],
    });
  };

  // Current A2A spec path (v0.3.x)
  app.get(`/${AGENT_CARD_PATH}`, serveAgentCard);

  // Legacy agent card paths for older A2A Inspector versions
  for (const p of [".well-known/agent.json", ".well-known/agent-json"]) {
    if (p !== AGENT_CARD_PATH) app.get(`/${p}`, serveAgentCard);
  }

  app.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  app.use("/a2a/rest", restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  // ── Context API ─────────────────────────────────────────────────────────

  // GET /mcp/status — return the current MCP server status from OpenCode
  app.get("/mcp/status", async (_req, res) => {
    try {
      const { getMcpStatus } = await import("../opencode/mcp-manager.js");
      const client = (executor as any).client;
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

  // POST /context/build — build or refresh the context file
  app.use("/context/build", express.json());
  app.post("/context/build", async (req, res) => {
    try {
      const customPrompt = req.body?.prompt as string | undefined;
      log.info("Context build requested", { customPrompt: !!customPrompt });
      const response = await executor.buildContext(customPrompt);
      const content = await executor.getContextContent();
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

  // 5. Start
  const httpServer = app.listen(port, hostname, () => {
    log.info("A2A server started", { bind: hostname, advertise: advertiseHost, port, proto: advertiseProto });
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                   OpenCode A2A Server                        ║
╠══════════════════════════════════════════════════════════════╣
║  Agent:         ${agentCard.name}
║  Bind Address:  ${hostname}:${port}
║  Agent Card:    ${advertiseProto}://${advertiseHost}:${port}/${AGENT_CARD_PATH}
║  JSON-RPC:      ${advertiseProto}://${advertiseHost}:${port}/a2a/jsonrpc
║  REST API:      ${advertiseProto}://${advertiseHost}:${port}/a2a/rest
║  Context:       ${advertiseProto}://${advertiseHost}:${port}/context
║  Build Context: ${advertiseProto}://${advertiseHost}:${port}/context/build  [POST]
║  MCP Status:    ${advertiseProto}://${advertiseHost}:${port}/mcp/status
║  Health Check:  ${advertiseProto}://${advertiseHost}:${port}/health
╠══════════════════════════════════════════════════════════════╣
║  Ready to receive A2A requests from any compatible client!   ║
╚══════════════════════════════════════════════════════════════╝
    `);
  });

  // 6. Handle
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

export { buildAgentCard } from "./agent-card.js";
