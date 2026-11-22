import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createProviderServer, type ProviderServerHandle } from "../../server/factory.js";
import type { BaseAgentConfig } from "../../config/types.js";
import type { ProviderExecutor } from "../../model/index.js";

let nextPort = 40500;
const makeConfig = (): Required<BaseAgentConfig> =>
  ({
    agentCard: {
      name: "provider-test",
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
    server: { port: nextPort++, hostname: "127.0.0.1", advertiseHost: "localhost", advertiseProtocol: "http" as const },
    backend: {},
    session: { titlePrefix: "t", reuseByContext: true, ttl: 3600000, cleanupInterval: 300000 },
    features: { streamArtifactChunks: false },
    timeouts: { prompt: 600000 },
    logging: { level: "info" },
    mcp: {},
  }) as Required<BaseAgentConfig>;

function provider(log: string[] = []): ProviderExecutor {
  return {
    info: () => ({ id: "fake", displayName: "Fake", inputModes: ["text/plain"], outputModes: ["text/plain"] }),
    initialize: async () => void log.push("initialize"),
    shutdown: async () => void log.push("shutdown"),
    async run(req, run) {
      run.event({ type: "text", text: `echo: ${(req.input[0] as { text: string }).text}` });
      run.complete({});
    },
  };
}

let handle: ProviderServerHandle | undefined;
afterEach(async () => {
  if (handle) await new Promise<void>((r) => handle!.server.close(() => r()));
  handle = undefined;
});

describe("createProviderServer", () => {
  it("serves a provider over JSON-RPC through the run runtime, initializing it first", async () => {
    const log: string[] = [];
    handle = await createProviderServer(makeConfig(), provider(log));
    expect(log).toEqual(["initialize"]);
    expect(handle.registry.provider).toBe(handle.provider);
    const res = await request(handle.server)
      .post("/a2a/jsonrpc")
      .set("A2A-Version", "0.3")
      .send({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "text", text: "hi" }] } } });
    expect(res.status).toBe(200);
    expect(res.body.result.status.state).toBe("completed");
    expect(res.body.result.artifacts[0].parts[0].text).toBe("echo: hi");
  });

  it("takes a function that builds the provider from the config, and passes registry options through", async () => {
    let seen: unknown;
    handle = await createProviderServer(
      makeConfig(),
      (cfg) => {
        seen = cfg.agentCard.name;
        return provider();
      },
      { registry: { bindingTtlMs: 1234 } },
    );
    expect(seen).toBe("provider-test");
    const card = await request(handle.server).get("/.well-known/agent-card.json");
    expect(card.status).toBe(200);
  });

  it("shutdown stops the provider", async () => {
    const log: string[] = [];
    handle = await createProviderServer(makeConfig(), provider(log));
    const h = handle;
    handle = undefined;
    await h.shutdown();
    expect(log).toContain("shutdown");
  });
});
