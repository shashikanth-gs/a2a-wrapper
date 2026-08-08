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
 *    {@link ServerOptions.protocolVersion} (default `"1.0"`).
 * 4. Wrapper-specific routes (context API, MCP status) are **not** included —
 *    those belong in each wrapper's `registerRoutes` hook.
 * 5. Supports an optional {@link ServerOptions.onListening} hook so that
 *    wrapper projects can restore their own branded startup banner without
 *    duplicating the Express bootstrap.
 *
 * ### A2A v1.0 backward compatibility
 *
 * `/a2a/jsonrpc` and `/a2a/rest` are mounted with `legacyCompat: { enabled: true }`,
 * which lets the SDK's `compat/v0_3` layer transparently translate v0.3-shaped
 * JSON-RPC method calls / REST requests to v1.0 and back — this requires no
 * custom code here, only that the agent card declares a mirrored v0.3
 * interface per binding (see `buildAgentCardForUrls` in `agent-card.ts`,
 * via `duplicateInterfacesForLegacy`).
 *
 * `/.well-known/agent-card.json`, however, is **not** served via the SDK's
 * `agentCardHandler()` convenience: that helper's `AgentCardProvider` is a
 * zero-argument `() => Promise<AgentCard>` with no access to the incoming
 * request, so it cannot reproduce this repo's per-request dynamic
 * `Host`/`X-Forwarded-Proto` URL rewriting (needed for reverse-proxy
 * deployments). Instead, `serveAgentCard` below builds the card by hand per
 * request, using `A2A-Version` header negotiation (defaulting to `"0.3"`
 * when absent, matching the SDK's own documented default) to decide between
 * the native v1.0 shape and a hand-built legacy v0.3 shape — the SDK's
 * internal v0.3 translator (`toCompatAgentCard`) isn't publicly exported, so
 * `buildLegacyAgentCard` in `agent-card.ts` fills that role instead. This is
 * an intentional, deliberate departure from the SDK's default pattern, not
 * an oversight.
 *
 * @module server/factory
 */

import express, { type Express, type RequestHandler } from "express";
import { AGENT_CARD_PATH, A2A_VERSION_HEADER, AgentCard } from "@a2a-js/sdk";
import type { AgentCardSignatureGenerator } from "@a2a-js/sdk";
import { generateAgentCardSignature } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import {
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";

import type { AgentCardConfig } from "../config/types.js";
import type { EventTransport, EventTransportFn } from "../events/transport.js";
import { buildAgentCard, buildAgentCardForUrls, buildLegacyAgentCard } from "./agent-card.js";
import type { BuildAgentCardInput } from "./agent-card.js";

/** Arguments accepted by `@a2a-js/sdk`'s `generateAgentCardSignature`. */
export interface AgentCardSigningOptions {
  /** Private key used to sign the card. Passed through to `jose`. */
  privateKey: Parameters<typeof generateAgentCardSignature>[0];
  /** Protected JWS header. The SDK's verifier requires `alg`, `kid`, and `typ`. */
  protectedHeader: Parameters<typeof generateAgentCardSignature>[1];
  /** Optional unprotected JWS header. */
  header?: Parameters<typeof generateAgentCardSignature>[2];
}

/**
 * Resolves `AgentCardConfig.signing` (env-var-indirected JWK + key metadata)
 * into {@link AgentCardSigningOptions}, or `undefined` when signing isn't
 * enabled/configured. The private key material is never read from the
 * config file itself — only from the environment variable it names.
 *
 * @internal
 */
function resolveAgentCardSigningFromConfig(
  signing: AgentCardConfig["signing"],
): AgentCardSigningOptions | undefined {
  if (!signing?.enabled) return undefined;
  const raw = process.env[signing.privateKeyJwkEnvVar];
  if (!raw) {
    throw new Error(
      `agentCard.signing is enabled but env var "${signing.privateKeyJwkEnvVar}" is not set.`,
    );
  }
  return {
    privateKey: JSON.parse(raw),
    protectedHeader: { alg: signing.algorithm, kid: signing.keyId, typ: "JWT" },
  };
}

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
   * detect the server's protocol level. It's purely informational — it
   * doesn't affect request/response translation, which is instead driven
   * per-request by the caller's own `A2A-Version` header (see the
   * module-level doc comment).
   *
   * @default "1.0"
   */
  protocolVersion?: string;

  /**
   * Optional Signed Agent Card support (A2A v1.0). When provided, the
   * native v1.0 agent card served at `/.well-known/agent-card.json` is
   * signed with a JWS (RFC 7515) via the SDK's `generateAgentCardSignature`,
   * populating `AgentCard.signatures`. Off by default — unsigned cards have
   * `signatures: []`.
   *
   * Legacy v0.3-shaped cards (served to callers without a v1.0
   * `A2A-Version` header) are never signed — `signatures` is a v1.0-only
   * concept.
   */
  agentCardSigning?: AgentCardSigningOptions;

  /**
   * Hook invoked once the HTTP server is listening, after
   * `app.listen(port, hostname)` returns. Use this to print a wrapper's own
   * branded startup banner instead of duplicating the Express bootstrap.
   */
  onListening?: (info: { port: number; hostname: string; advertiseHost: string; advertiseProtocol: string }) => void;

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

  /**
   * Custom event transport for sideband observability events.
   *
   * When provided, this transport is used instead of the built-in transports
   * configured via `config.events`. Accepts either an object implementing
   * {@link EventTransport} or a plain async function.
   *
   * This is the primary extension point for custom sinks (Kafka, Redis, DB):
   *
   * ```typescript
   * createA2AServer(config, executorFactory, {
   *   eventTransport: async (event) => {
   *     await kafkaProducer.send({ topic: "traces", messages: [{ value: JSON.stringify(event) }] });
   *   },
   * });
   * ```
   *
   * The transport is passed through to executors via the {@link ServerHandle}.
   * Executors call `resolveTransport(config.events, bus, taskId, contextId, customTransport)`
   * inside their `execute()` method to get the final transport for each request.
   */
  eventTransport?: EventTransport | EventTransportFn;
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
   * Custom event transport supplied via {@link ServerOptions.eventTransport}.
   * Executors pass this to `resolveTransport()` so the custom transport
   * takes priority over config-driven built-in transports.
   *
   * `undefined` when no custom transport was provided — `resolveTransport()`
   * will fall back to the config-driven transport (A2A sideband by default).
   */
  eventTransport?: EventTransport | EventTransportFn;

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
 * @typeParam T - The full configuration type. Only structurally required to
 *   provide `agentCard` and `server` sections (see {@link BuildAgentCardInput}) —
 *   deliberately *not* constrained to core's `BaseAgentConfig`, since every
 *   wrapper project names its backend-specific config section differently
 *   (`claude`, `codex`, `antigravity`, ...) rather than a generic `backend`
 *   field. The generic parameter ensures the `executorFactory` receives the
 *   same fully-resolved config type that the wrapper project defined.
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
 *     protocolVersion: "1.0",
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
export async function createA2AServer<T extends BuildAgentCardInput>(
  config: Required<T>,
  executorFactory: (config: Required<T>) => A2AExecutor,
  options?: ServerOptions,
): Promise<ServerHandle> {
  const { server: srv } = config;
  const port = srv.port ?? 3000;
  const hostname = srv.hostname ?? "0.0.0.0";
  const advertiseHost = srv.advertiseHost ?? "localhost";
  const advertiseProto = srv.advertiseProtocol ?? "http";
  const protocolVersion = options?.protocolVersion ?? "1.0";

  // ── 1. Executor ─────────────────────────────────────────────────────────
  const executor = executorFactory(config);
  await executor.initialize();

  // ── 2. Agent card (static, used for request-handler-internal version
  //      validation only — the /.well-known/agent-card.json route below
  //      rebuilds a fresh, per-request card with dynamic URLs) ────────────
  const agentCard = buildAgentCard(config);

  // ── Signed Agent Card (optional) ─────────────────────────────────────────
  // A programmatic `options.agentCardSigning` override takes priority over
  // `config.agentCard.signing` (same override pattern as `eventTransport`).
  const signingOptions = options?.agentCardSigning ?? resolveAgentCardSigningFromConfig(config.agentCard.signing);
  const agentCardSignatureGenerator: AgentCardSignatureGenerator | undefined = signingOptions
    ? generateAgentCardSignature(signingOptions.privateKey, signingOptions.protectedHeader, signingOptions.header)
    : undefined;

  // ── 3. A2A SDK request handler ──────────────────────────────────────────
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor as any, // executor satisfies AgentExecutor at runtime; cast avoids coupling core to SDK's full AgentExecutor shape
    undefined, // eventBusManager (SDK default)
    undefined, // pushNotificationStore
    undefined, // pushNotificationSender
    undefined, // extendedAgentCardProvider
    agentCardSignatureGenerator,
  );

  // ── 4. Express app ──────────────────────────────────────────────────────
  const app = express();

  // ── A2A-Version response header middleware ──────────────────────────────
  // Every response includes the protocol version this server implements.
  // This is purely informational — request/response translation is driven
  // per-request by the caller's own A2A-Version header, not this value.
  app.use((_req, res, next) => {
    res.setHeader(A2A_VERSION_HEADER, protocolVersion);
    next();
  });

  // ── Health check ────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "healthy", agent: agentCard.name });
  });

  // ── Dynamic agent card handler ──────────────────────────────────────────
  // Rewrites endpoint URLs to match the caller's Host + x-forwarded-proto
  // headers so clients behind Docker / reverse proxies reach the correct
  // address for JSON-RPC / REST endpoints. Also negotiates between the
  // native v1.0 card shape and a legacy v0.3 shape based on the caller's
  // A2A-Version request header — see the module-level doc comment for why
  // this is hand-built rather than using the SDK's `agentCardHandler`.
  const serveAgentCard: RequestHandler = async (req, res) => {
    const host = req.headers.host || `${advertiseHost}:${port}`;
    const proto =
      (req.headers["x-forwarded-proto"] as string) || advertiseProto;
    const dynamicBase = `${proto}://${host}`;
    const jsonRpcUrl = `${dynamicBase}/a2a/jsonrpc`;
    const restUrl = `${dynamicBase}/a2a/rest`;

    const requestedVersion = (req.headers[A2A_VERSION_HEADER.toLowerCase()] as string) || "0.3";
    if (requestedVersion.startsWith("0.3")) {
      res.json(buildLegacyAgentCard(config.agentCard, jsonRpcUrl, restUrl));
      return;
    }

    // Normalize through the SDK's proto JSON round-trip before signing:
    // `generateAgentCardSignature` canonicalizes exactly the object it's
    // given, while `verifyAgentCardSignature` canonicalizes
    // `AgentCard.toJSON(AgentCard.fromJSON(card))` — without this
    // normalization step the two would sign/verify different byte payloads
    // whenever the hand-built card isn't already in that exact shape.
    // Unsigned cards retain per-request URL rewriting for local development
    // and proxy discovery. A signed card must never incorporate requester-
    // controlled Host / X-Forwarded-Proto values: doing so would let any
    // caller obtain a valid signature over attacker-selected endpoints.
    // Signed cards therefore use only the trusted advertiseHost/protocol
    // values from resolved server configuration.
    const cardToNormalize = agentCardSignatureGenerator
      ? agentCard
      : buildAgentCardForUrls(config.agentCard, jsonRpcUrl, restUrl);
    let card: AgentCard = AgentCard.toJSON(AgentCard.fromJSON(cardToNormalize)) as AgentCard;
    if (agentCardSignatureGenerator) {
      card = await agentCardSignatureGenerator(card);
    }
    res.json(card);
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
  // legacyCompat: v0.3-shaped JSON-RPC method names / REST requests are
  // transparently translated to v1.0 by the SDK, as long as the agent card
  // declares a mirrored v0.3 interface per binding (see agent-card.ts).
  app.use(
    "/a2a/jsonrpc",
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
      legacyCompat: { enabled: true },
    }),
  );
  app.use(
    "/a2a/rest",
    restHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
      legacyCompat: { enabled: true },
    }),
  );

  // ── 5. Wrapper-specific custom routes ───────────────────────────────────
  if (options?.registerRoutes) {
    options.registerRoutes(app, executor);
  }

  // ── 6. Start listening ──────────────────────────────────────────────────
  const httpServer = app.listen(port, hostname, () => {
    options?.onListening?.({ port, hostname, advertiseHost, advertiseProtocol: advertiseProto });
  });

  // ── 7. Return handle ───────────────────────────────────────────────────
  return {
    app,
    server: httpServer,
    executor,
    eventTransport: options?.eventTransport,
    async shutdown() {
      httpServer.close();
      await executor.shutdown();
    },
  };
}
