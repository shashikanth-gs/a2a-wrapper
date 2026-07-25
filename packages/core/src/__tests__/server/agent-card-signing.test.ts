import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import * as jose from "jose";
import { verifyAgentCardSignature } from "@a2a-js/sdk";
import { createA2AServer } from "../../server/factory.js";
import type { ServerHandle } from "../../server/factory.js";
import type { BaseAgentConfig } from "../../config/types.js";

/**
 * End-to-end test for Signed Agent Card support (A2A v1.0, JWS per RFC 7515).
 * Confirms `ServerOptions.agentCardSigning` actually produces a card whose
 * `signatures[0]` verifies against the corresponding public key — not just
 * that the option is silently accepted.
 */

const mockExecutorFactory = () => ({
  initialize: async () => {},
  shutdown: async () => {},
  execute: async () => {},
});

let nextPort = 41100;

const makeConfig = (): Required<BaseAgentConfig> => ({
  agentCard: {
    name: "signed-agent",
    description: "test",
    version: "1.0.0",
    skills: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    streaming: true,
    pushNotifications: false,
  },
  server: {
    port: nextPort++,
    hostname: "127.0.0.1",
    advertiseHost: "localhost",
    advertiseProtocol: "http" as const,
  },
  backend: {},
  session: { titlePrefix: "test", reuseByContext: true, ttl: 3600000, cleanupInterval: 300000 },
  features: { streamArtifactChunks: false },
  timeouts: { prompt: 600000 },
  logging: { level: "info" },
  mcp: {},
});

function waitForClose(handle: ServerHandle): Promise<void> {
  return new Promise((resolve) => handle.server.close(() => resolve()));
}

let activeHandle: ServerHandle | undefined;
afterEach(async () => {
  if (activeHandle) {
    try { await waitForClose(activeHandle); } catch { /* ignore */ }
    await activeHandle.executor.shutdown();
    activeHandle = undefined;
  }
});

describe("Signed Agent Card", () => {
  it("signs the v1.0 card and the signature verifies against the public key", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    const privateJwk = await jose.exportJWK(privateKey);
    const keyId = "test-key-1";

    const config = makeConfig();
    const handle = await createA2AServer(config, mockExecutorFactory, {
      agentCardSigning: {
        privateKey: privateJwk,
        protectedHeader: { alg: "ES256", kid: keyId, typ: "JWT" },
      },
    });
    activeHandle = handle;

    const res = await request(handle.app)
      .get("/.well-known/agent-card.json")
      .set("A2A-Version", "1.0");

    expect(res.status).toBe(200);
    expect(res.body.signatures).toHaveLength(1);

    const verifier = verifyAgentCardSignature(async (kid) => {
      expect(kid).toBe(keyId);
      return publicKey;
    });

    await expect(verifier(res.body)).resolves.toBeUndefined();
  });

  it("legacy v0.3 card is never signed", async () => {
    const { privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    const privateJwk = await jose.exportJWK(privateKey);

    const config = makeConfig();
    const handle = await createA2AServer(config, mockExecutorFactory, {
      agentCardSigning: {
        privateKey: privateJwk,
        protectedHeader: { alg: "ES256", kid: "k1", typ: "JWT" },
      },
    });
    activeHandle = handle;

    const res = await request(handle.app).get("/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    expect(res.body.signatures).toBeUndefined();
    expect(res.body.protocolVersion).toBe("0.3.0");
  });

  it("unsigned cards (no agentCardSigning option) have no signatures", async () => {
    const config = makeConfig();
    const handle = await createA2AServer(config, mockExecutorFactory);
    activeHandle = handle;

    const res = await request(handle.app)
      .get("/.well-known/agent-card.json")
      .set("A2A-Version", "1.0");

    expect(res.status).toBe(200);
    // buildAgentCard() sets `signatures: []`, but the served card is
    // normalized through the SDK's proto JSON round-trip (see factory.ts),
    // which — per standard proto3 JSON semantics — omits empty repeated
    // fields rather than serializing them as `[]`.
    expect(res.body.signatures ?? []).toEqual([]);
  });
});
