import { describe, it, expect, afterEach } from "vitest";
import * as fc from "fast-check";
import request from "supertest";
import { createA2AServer } from "../../server/factory.js";
import type { ServerHandle } from "../../server/factory.js";
import type { BaseAgentConfig } from "../../config/types.js";
import { publishTask, publishStatus } from "../../events/event-publisher.js";

/**
 * Property-based tests for the A2A Server Factory module.
 *
 * Validates Requirements 9.3, 15.2 via Property 15,
 * and Requirement 9.4 via Property 16.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockExecutorFactory = () => ({
  initialize: async () => {},
  shutdown: async () => {},
  execute: async () => {},
});

/** Monotonically increasing port counter to avoid EADDRINUSE collisions. */
let nextPort = 40100;

const makeConfig = (): Required<BaseAgentConfig> => ({
  agentCard: {
    name: "test",
    description: "test",
    protocolVersion: "0.3.0",
    version: "1.0.0",
    skills: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  server: {
    port: nextPort++,
    hostname: "127.0.0.1",
    advertiseHost: "localhost",
    advertiseProtocol: "http" as const,
  },
  backend: {},
  session: {
    titlePrefix: "test",
    reuseByContext: true,
    ttl: 3600000,
    cleanupInterval: 300000,
  },
  features: { streamArtifactChunks: false },
  timeouts: { prompt: 600000 },
  logging: { level: "info" },
  mcp: {},
});

/** Wait for server to fully close. */
function waitForClose(handle: ServerHandle): Promise<void> {
  return new Promise((resolve) => {
    handle.server.close(() => resolve());
  });
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

let activeHandle: ServerHandle | undefined;

afterEach(async () => {
  if (activeHandle) {
    try { await waitForClose(activeHandle); } catch { /* ignore */ }
    await activeHandle.executor.shutdown();
    activeHandle = undefined;
  }
});

// ─── Arbitraries ────────────────────────────────────────────────────────────

const arbVersionString = fc
  .tuple(fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 9 }))
  .map(([major, minor]) => `${major}.${minor}`);

// Feature: shared-core-package, Property 15: A2A-Version header reflects configured protocol version
// Validates: Requirements 9.3, 15.2
describe("Property 15: A2A-Version header reflects configured protocol version", () => {
  it("all responses include A2A-Version header matching the configured protocol version", async () => {
    await fc.assert(
      fc.asyncProperty(arbVersionString, async (version) => {
        const config = makeConfig();
        const handle = await createA2AServer(config, mockExecutorFactory, {
          protocolVersion: version,
        });

        try {
          const res = await request(handle.app).get("/health");
          expect(res.headers["a2a-version"]).toBe(version);
        } finally {
          await waitForClose(handle);
          await handle.executor.shutdown();
        }
      }),
      { numRuns: 15 },
    );
  });

  it("defaults to A2A-Version: 1.0 when not configured", async () => {
    const config = makeConfig();
    const handle = await createA2AServer(config, mockExecutorFactory);
    try {
      const res = await request(handle.app).get("/health");
      expect(res.headers["a2a-version"]).toBe("1.0");
    } finally {
      await waitForClose(handle);
      await handle.executor.shutdown();
    }
  });
});

// Feature: shared-core-package, Property 16: Dynamic agent card URL rewriting
// Validates: Requirements 9.4
describe("Property 16: Dynamic agent card URL rewriting", () => {
  const arbProto = fc.constantFrom("http", "https");
  const arbHost = fc
    .tuple(
      fc.stringMatching(/^[a-z][a-z0-9-]*$/).filter((s) => s.length > 0),
      fc.integer({ min: 1024, max: 65535 }),
    )
    .map(([name, port]) => `${name}:${port}`);

  it("v1.0 agent card (A2A-Version: 1.0) uses request Host/x-forwarded-proto in supportedInterfaces, not static config", async () => {
    await fc.assert(
      fc.asyncProperty(arbProto, arbHost, async (proto, host) => {
        const config = makeConfig();
        const handle = await createA2AServer(config, mockExecutorFactory);

        try {
          const res = await request(handle.app)
            .get("/.well-known/agent-card.json")
            .set("Host", host)
            .set("x-forwarded-proto", proto)
            .set("A2A-Version", "1.0");

          expect(res.status).toBe(200);

          const body = res.body;
          const expectedBase = `${proto}://${host}`;
          const expectedJsonRpc = `${expectedBase}/a2a/jsonrpc`;
          const expectedRest = `${expectedBase}/a2a/rest`;

          expect(body.url).toBeUndefined();
          expect(body.additionalInterfaces).toBeUndefined();
          expect(Array.isArray(body.supportedInterfaces)).toBe(true);

          const jsonrpcEntry = body.supportedInterfaces.find(
            (i: any) => i.protocolBinding === "JSONRPC" && i.protocolVersion === "1.0",
          );
          const restEntry = body.supportedInterfaces.find(
            (i: any) => i.protocolBinding === "HTTP+JSON" && i.protocolVersion === "1.0",
          );
          expect(jsonrpcEntry.url).toBe(expectedJsonRpc);
          expect(restEntry.url).toBe(expectedRest);
        } finally {
          await waitForClose(handle);
          await handle.executor.shutdown();
        }
      }),
      { numRuns: 15 },
    );
  });

  it("legacy v0.3 agent card (no A2A-Version header) still uses request Host/x-forwarded-proto in url/additionalInterfaces", async () => {
    await fc.assert(
      fc.asyncProperty(arbProto, arbHost, async (proto, host) => {
        const config = makeConfig();
        const handle = await createA2AServer(config, mockExecutorFactory);

        try {
          const res = await request(handle.app)
            .get("/.well-known/agent-card.json")
            .set("Host", host)
            .set("x-forwarded-proto", proto);

          expect(res.status).toBe(200);

          const body = res.body;
          const expectedBase = `${proto}://${host}`;
          const expectedJsonRpc = `${expectedBase}/a2a/jsonrpc`;
          const expectedRest = `${expectedBase}/a2a/rest`;

          // Backward compatibility: callers that never adopted the
          // A2A-Version header (default "0.3") still get the legacy shape.
          expect(body.protocolVersion).toBe("0.3.0");
          expect(body.url).toBe(expectedJsonRpc);

          const jsonrpcEntry = body.additionalInterfaces.find(
            (i: any) => i.transport === "JSONRPC",
          );
          const restEntry = body.additionalInterfaces.find(
            (i: any) => i.transport === "REST",
          );
          expect(jsonrpcEntry.url).toBe(expectedJsonRpc);
          expect(restEntry.url).toBe(expectedRest);
        } finally {
          await waitForClose(handle);
          await handle.executor.shutdown();
        }
      }),
      { numRuns: 15 },
    );
  });
});

/** Executor that immediately completes every task with a text response. */
const completingExecutorFactory = () => ({
  initialize: async () => {},
  shutdown: async () => {},
  execute: async (requestContext: any, bus: any) => {
    const taskId = requestContext.taskId ?? "generated-task-id";
    const contextId = requestContext.contextId ?? "generated-context-id";
    publishTask(bus, taskId, contextId);
    publishStatus(bus, taskId, contextId, "completed", "done", true);
    bus.finished();
  },
});

// New: backward compatibility through the SDK's legacyCompat JSON-RPC layer
describe("A2A v0.3 backward compatibility via legacyCompat", () => {
  it("accepts a v0.3-shaped message/send JSON-RPC request", async () => {
    const config = makeConfig();
    const handle = await createA2AServer(config, completingExecutorFactory);

    try {
      const res = await request(handle.app)
        .post("/a2a/jsonrpc")
        .set("Content-Type", "application/json")
        .send({
          jsonrpc: "2.0",
          id: "1",
          method: "message/send",
          params: {
            message: {
              kind: "message",
              messageId: "m1",
              role: "user",
              parts: [{ kind: "text", text: "hello" }],
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe("2.0");
      expect(res.body.error).toBeUndefined();
    } finally {
      await waitForClose(handle);
      await handle.executor.shutdown();
    }
  });
});
