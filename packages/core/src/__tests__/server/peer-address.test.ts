/**
 * The server stamps the caller address into an internal header that
 * `otel.propagation.trustedPeers` reads. It must be unspoofable, and
 * `server.trustProxy` must control whether X-Forwarded-For is believed.
 */
import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createA2AServer, type ServerHandle } from "../../server/factory.js";
import type { BaseAgentConfig } from "../../config/types.js";
import { PEER_HEADER } from "../../index.js";

let nextPort = 41600;
let handle: ServerHandle | undefined;

afterEach(async () => {
  if (handle) {
    await new Promise<void>((r) => handle!.server.close(() => r()));
    await handle.executor.shutdown();
    handle = undefined;
  }
});

function makeConfig(server: Record<string, unknown> = {}): Required<BaseAgentConfig> {
  return {
    agentCard: {
      name: "test", description: "test", protocolVersion: "0.3.0", version: "1.0.0", skills: [],
      defaultInputModes: ["text"], defaultOutputModes: ["text"], streaming: true,
      pushNotifications: false, stateTransitionHistory: false,
    },
    server: { port: nextPort++, hostname: "127.0.0.1", advertiseHost: "localhost", advertiseProtocol: "http" as const, ...server },
    backend: {},
    session: { titlePrefix: "t", reuseByContext: true, ttl: 3600000, cleanupInterval: 300000 },
    features: { streamArtifactChunks: false },
    timeouts: { prompt: 600000 },
    logging: { level: "info" },
    mcp: {},
  } as Required<BaseAgentConfig>;
}

async function peerSeenByExecutor(server: Record<string, unknown>, headers: Record<string, string>) {
  let seen: Record<string, unknown> | undefined;
  const factory = () => ({
    initialize: async () => {},
    shutdown: async () => {},
    execute: async (ctx: { context?: { state?: Map<string, unknown> } }) => {
      seen = ctx.context?.state?.get("headers") as Record<string, unknown>;
    },
  });
  handle = await createA2AServer(makeConfig(server), factory as never);
  const req = request(handle.app)
    .post("/a2a/jsonrpc")
    .set("content-type", "application/json");
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  await req.send({
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: { message: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "text", text: "hi" }] } },
  });
  return seen?.[PEER_HEADER];
}

describe("caller address middleware", () => {
  it("records the socket address", async () => {
    const peer = await peerSeenByExecutor({}, {});
    expect(String(peer)).toMatch(/127\.0\.0\.1$/);
  });

  it("overwrites a client-supplied x-a2a-peer header", async () => {
    const peer = await peerSeenByExecutor({}, { [PEER_HEADER]: "1.2.3.4" });
    expect(String(peer)).not.toContain("1.2.3.4");
    expect(String(peer)).toMatch(/127\.0\.0\.1$/);
  });

  it("ignores X-Forwarded-For unless trustProxy allows it", async () => {
    const peer = await peerSeenByExecutor({}, { "x-forwarded-for": "203.0.113.9" });
    expect(String(peer)).not.toContain("203.0.113.9");
  });

  it("honours X-Forwarded-For from a trusted proxy", async () => {
    const peer = await peerSeenByExecutor({ trustProxy: "loopback" }, { "x-forwarded-for": "203.0.113.9" });
    expect(String(peer)).toContain("203.0.113.9");
  });
});
