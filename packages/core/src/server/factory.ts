/**
 * A2A Server Factory
 *
 * Creates, wires, and starts an Express-based A2A HTTP server with all
 * standard protocol routes. This module is the single entry point for
 * server bootstrapping across all wrapper projects, ensuring consistent
 * route registration, middleware ordering, and lifecycle management.
 *
 * Ported from `a2a-copilot/src/server/index.ts` and
 * `a2a-opencode/src/server/index.ts` with the following changes for
 * core-package reuse:
 *
 * 1. Accepts a generic `executorFactory` callback instead of importing a
 *    concrete executor class — the core package has zero knowledge of any
 *    specific backend.
 * 2. Supports an optional {@link ServerOptions.registerRoutes} hook so that
 *    wrapper projects can mount custom routes (e.g. `/context`, `/mcp/status`)
 *    before the server starts listening.
 * 3. The `A2A-Version` response header value is configurable via
 *    {@link ServerOptions.protocolVersion} (default `"0.3"`).
 * 4. Wrapper-specific routes (context API, MCP status) are **not** included —
 *    those belong in each wrapper's `registerRoutes` hook.
 *
 * @module server/factory
 */

import express, { type Express, type RequestHandler } from "express";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import {
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";

import type { BaseAgentConfig } from "../config/types.js";
import { buildAgentCard } from "./agent-card.js";

// ─── A2AExecutor Interface ──────────────────────────────────────────────────

/**
 * Minimal executor contract required by the server factory.
 *
 * Every wrapper project implements this interface with its backend-specific
 * logic (e.g. `CopilotExecutor`, `OpenCodeExecutor`). The server factory
 * calls {@link initialize} during startup and {@link shutdown} during
 * graceful teardown.
 *
 * The `execute` and `cancelTask` methods are inherited from the SDK's
 * `AgentExecutor` type and are invoked by {@link DefaultRequestHandler}
 * when processing A2A JSON-RPC / REST requests.
 */
export interface A2AExecutor {
  /**
   * Perform asynchronous startup logic (e.g. connect to backend, register
   * MCP servers, warm caches). Called once before the HTTP server begins
   * accepting requests.
   */
  initialize(): Promise<void>;

  /**
   * Perform graceful cleanup (e.g. close backend connections, flush buffers).
   * Called when the server is shutting down.
   */
  shutdown(): Promise<void>;
}

// ─── ServerOptions ──────────────────────────────────────────────────────────

/**
 * Optional customization hooks for the A2A server.
 *
 * Wrapper projects pass these options to {@link createA2AServer} to inject
 * custom routes and override protocol-level defaults without modifying the
 * core server wiring.
 */
export interface ServerOptions {
  /**
   * A2A protocol version advertised in the `A2A-Version` response header.
   *
   * This value is sent on **every** HTTP response so that clients can
   * detect the server's protocol level. Future A2A spec versions can be
   * supported by changing this single value.
   *
   * @default "0.3"
   */
  protocolVersion?: string;

  /**
   * Hook invoked after standard routes are registered but **before** the
   * server starts listening. Use this to mount wrapper-specific endpoints
   * (e.g. `/context`, `/context/build`, `/mcp/status`).
   *
   * @param app      - The Express application instance.
   * @param executor - The initialized executor, available for route handlers
   *                   that need to delegate to the backend.
   */
  registerRoutes?: (app: Express, executor: A2AExecutor) => void;
}

// ─── ServerHandle ───────────────────────────────────────────────────────────

/**
 * Handle returned by {@link createA2AServer} for lifecycle management.
 *
 * Callers use this handle to access the Express app (e.g. for supertest),
 * the underlying HTTP server, the initialized executor, and a `shutdown`
 * method for graceful teardown.
 */
export interface ServerHandle {
  /** The Express application instance with all routes registered. */
  app: Express;

  /** The Node.js HTTP server returned by `app.listen()`. */
  server: ReturnType<Express["listen"]>;

  /** The initialized backend executor. */
  executor: A2AExecutor;

  /**
   * Gracefully shut down the server and executor.
   *
   * Closes the HTTP server so no new connections are accepted, then
   * calls `executor.shutdown()` for backend cleanup.
   */
  shutdown(): Promise<void>;
}

// ─── createA2AServer ────────────────────────────────────────────────────────

/**
 * Create, wire, and start an A2A-compliant Express server.
 *
 * This function is the primary entry point for all wrapper projects. It:
 *
 * 1. Instantiates the backend executor via the supplied `executorFactory`.
 * 2. Builds the static agent card from resolved configuration.
 * 3. Creates the A2A SDK request handler with an in-memory task store.
 * 4. Mounts middleware and standard routes:
 *    - `A2A-Version` response header on every response.
 *    - `GET /health` — health check endpoint.
 *    - `GET /.well-known/agent-card.json` — dynamic agent card with URL
 *      rewriting for reverse proxy compatibility.
 *    - Legacy agent card paths (`.well-known/agent.json`,
 *      `.well-known/agent-json`).
 *    - `POST /a2a/jsonrpc` — JSON-RPC transport.
 *    - `/a2a/rest` — REST transport.
 * 5. Invokes the optional `registerRoutes` hook for wrapper-specific routes.
 * 6. Starts listening on the configured hostname and port.
 * 7. Returns a {@link ServerHandle} for lifecycle management.
 *
 * @typeParam T - The full configuration type, extending {@link BaseAgentConfig}.
 *   The generic parameter ensures the `executorFactory` receives the same
 *   fully-resolved config type that the wrapper project defined.
 *
 * @param config          - Fully resolved configuration with all fields populated.
 * @param executorFactory - Factory function that creates the backend-specific
 *                          executor from the resolved config. The server factory
 *                          calls `executor.initialize()` before registering routes.
 * @param options         - Optional server customization (protocol version,
 *                          custom route hooks).
 * @returns A promise resolving to a {@link ServerHandle} once the server is
 *   listening and ready to accept requests.
 *
 * @example
 * ```typescript
 * import { createA2AServer } from "@a2a-wrapper/core";
 * import { MyExecutor } from "./my-executor.js";
 *
 * const handle = await createA2AServer(
 *   resolvedConfig,
 *   (cfg) => new MyExecutor(cfg),
 *   {
 *     protocolVersion: "0.3",
 *     registerRoutes: (app, executor) => {
 *       app.get("/custom", (_req, res) => res.json({ ok: true }));
 *     },
 *   },
 * );
 *
 * // Graceful shutdown on SIGTERM
 * process.on("SIGTERM", () => handle.shutdown());
 * ```
 */
export async function createA2AServer<T extends BaseAgentConfig<unknown>>(
  config: Required<T>,
  executorFactory: (config: Required<T>) => A2AExecutor,
  options?: ServerOptions,
): Promise<ServerHandle> {
  const { server: srv } = config;
  const port = srv.port ?? 3000;
  const hostname = srv.hostname ?? "0.0.0.0";
  const advertiseHost = srv.advertiseHost ?? "localhost";
  const advertiseProto = srv.advertiseProtocol ?? "http";
  const protocolVersion = options?.protocolVersion ?? "0.3";

  // ── 1. Executor ─────────────────────────────────────────────────────────
  const executor = executorFactory(config);
  await executor.initialize();

  // ── 2. Agent card (static, used as base for dynamic rewriting) ──────────
  const agentCard = buildAgentCard(config);

  // ── 3. A2A SDK request handler ──────────────────────────────────────────
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor as any, // executor satisfies AgentExecutor at runtime; cast avoids coupling core to SDK's full AgentExecutor shape
  );

  // ── 4. Express app ──────────────────────────────────────────────────────
  const app = express();

  // ── A2A-Version response header middleware ──────────────────────────────
  // Every response includes the protocol version this server implements,
  // enabling clients to detect version mismatches and future negotiation.
  app.use((_req, res, next) => {
    res.setHeader("A2A-Version", protocolVersion);
    next();
  });

  // ── Health check ────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "healthy", agent: agentCard.name });
  });

  // ── Dynamic agent card handler ──────────────────────────────────────────
  // Rewrites endpoint URLs to match the caller's Host + x-forwarded-proto
  // headers so clients behind Docker / reverse proxies reach the correct
  // address for JSON-RPC / REST endpoints.
  const serveAgentCard: RequestHandler = (req, res) => {
    const host = req.headers.host || `${advertiseHost}:${port}`;
    const proto =
      (req.headers["x-forwarded-proto"] as string) || advertiseProto;
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

  // Current A2A spec path
  app.get(`/${AGENT_CARD_PATH}`, serveAgentCard);

  // Legacy agent card paths for older A2A Inspector versions
  for (const p of [".well-known/agent.json", ".well-known/agent-json"]) {
    if (p !== AGENT_CARD_PATH) {
      app.get(`/${p}`, serveAgentCard);
    }
  }

  // ── A2A transports ──────────────────────────────────────────────────────
  app.use(
    "/a2a/jsonrpc",
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.use(
    "/a2a/rest",
    restHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  // ── 5. Wrapper-specific custom routes ───────────────────────────────────
  if (options?.registerRoutes) {
    options.registerRoutes(app, executor);
  }

  // ── 6. Start listening ──────────────────────────────────────────────────
  const httpServer = app.listen(port, hostname);

  // ── 7. Return handle ───────────────────────────────────────────────────
  return {
    app,
    server: httpServer,
    executor,
    async shutdown() {
      httpServer.close();
      await executor.shutdown();
    },
  };
}
