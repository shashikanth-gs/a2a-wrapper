/**
 * A2A Server Bootstrap — a2a-antigravity
 *
 * Thin wrapper around `@a2a-wrapper/core`'s `createA2AServer`. All A2A
 * protocol wiring (agent card, JSON-RPC/REST transports, version
 * negotiation) lives in core — this file only supplies the
 * antigravity-specific executor and startup banner.
 */

import { createA2AServer as coreCreateA2AServer } from "@a2a-wrapper/core";
import type { ServerHandle as CoreServerHandle } from "@a2a-wrapper/core";

import type { AgentConfig } from "../config/types.js";
import { AntigravityExecutor } from "../antigravity/executor.js";
import { logger } from "../utils/logger.js";

const log = logger.child("server");

export interface ServerHandle extends Omit<CoreServerHandle, "executor"> {
  executor: AntigravityExecutor;
}

export async function createA2AServer(config: Required<AgentConfig>): Promise<ServerHandle> {
  const handle = await coreCreateA2AServer<Required<AgentConfig>>(config, (cfg) => new AntigravityExecutor(cfg), {
    protocolVersion: "1.0",
    onListening: ({ port, hostname, advertiseHost, advertiseProtocol }) => {
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
    executor: handle.executor as AntigravityExecutor,
    async shutdown() {
      await handle.shutdown();
      log.info("Server shut down");
    },
  };
}
