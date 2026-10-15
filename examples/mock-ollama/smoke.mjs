#!/usr/bin/env node
/**
 * Generic mock-ollama cookout — no OTel / Phoenix required.
 *
 * Starts the stub, boots a2a-copilot + a2a-claude against it, sends
 * message/send to each, asserts the mock saw LLM traffic and A2A succeeded.
 *
 *   node examples/mock-ollama/smoke.mjs
 *
 * Reuse this pattern for any feature you want to exercise with real CLIs
 * without cloud credentials.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");

const MOCK_PORT = Number(process.env.MOCK_OLLAMA_PORT || 19134);
const COPILOT_PORT = Number(process.env.MOCK_SMOKE_COPILOT_PORT || 3101);
const CLAUDE_PORT = Number(process.env.MOCK_SMOKE_CLAUDE_PORT || 3102);
const MODEL = process.env.MOCK_OLLAMA_MODEL || "mock-ollama";

const children = [];
const agentChildren = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnLogged(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  const label = opts.label || cmd;
  child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  children.push(child);
  if (opts.agent) agentChildren.push(child);
  return child;
}

async function waitHttp(url, { timeoutMs = 30_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status >= 200 && res.status < 500) return;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function killAgentsAndWait(timeoutMs = 15_000) {
  await Promise.all(
    agentChildren.map(
      (c) =>
        new Promise((resolve) => {
          if (c.exitCode !== null || c.signalCode) {
            resolve(undefined);
            return;
          }
          const timer = setTimeout(() => {
            try {
              c.kill("SIGKILL");
            } catch {
              /* ignore */
            }
            resolve(undefined);
          }, timeoutMs);
          c.once("exit", () => {
            clearTimeout(timer);
            resolve(undefined);
          });
          try {
            c.kill("SIGTERM");
          } catch {
            clearTimeout(timer);
            resolve(undefined);
          }
        }),
    ),
  );
  agentChildren.length = 0;
}

async function messageSend(port, text) {
  const contextId = randomUUID();
  const res = await fetch(`http://127.0.0.1:${port}/a2a/jsonrpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: randomUUID(),
          role: "user",
          contextId,
          parts: [{ kind: "text", text }],
        },
        configuration: { blocking: true },
      },
    }),
  });
  const body = await res.json();
  return {
    status: res.status,
    body,
    taskId: body.result?.id,
    contextId,
  };
}

function writePatchedConfig(agentFile, port, mockBase) {
  const src = JSON.parse(readFileSync(join(__dirname, "agents", agentFile), "utf8"));
  src.server.port = port;
  if (src.copilot?.provider) {
    src.copilot.provider.baseUrl = `${mockBase}/v1`;
    src.copilot.model = MODEL;
    src.copilot.workspaceDirectory = "/tmp/a2a-mock-ollama-copilot-ws";
    mkdirSync(src.copilot.workspaceDirectory, { recursive: true });
  }
  if (src.claude) {
    src.claude.model = MODEL;
    src.claude.workingDirectory = "/tmp/a2a-mock-ollama-claude-ws";
    mkdirSync(src.claude.workingDirectory, { recursive: true });
  }
  const out = join("/tmp", `a2a-mock-ollama-${agentFile}`);
  writeFileSync(out, JSON.stringify(src, null, 2));
  return out;
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function main() {
  const mockBase = `http://127.0.0.1:${MOCK_PORT}`;
  console.log("Starting mock-ollama on", MOCK_PORT);
  spawnLogged(process.execPath, [join(__dirname, "server.mjs")], {
    label: "mock-ollama",
    env: {
      ...process.env,
      MOCK_OLLAMA_PORT: String(MOCK_PORT),
      MOCK_OLLAMA_MODEL: MODEL,
      MOCK_OLLAMA_REPLY: "pong-from-mock-ollama",
    },
  });
  await waitHttp(`${mockBase}/health`);

  const copilotCfg = writePatchedConfig("copilot.json", COPILOT_PORT, mockBase);
  const claudeCfg = writePatchedConfig("claude.json", CLAUDE_PORT, mockBase);

  console.log("Starting a2a-copilot…");
  spawnLogged(process.execPath, [join(root, "a2a-copilot/dist/cli.js"), "--config", copilotCfg], {
    label: "a2a-copilot",
    agent: true,
    env: {
      ...process.env,
      COPILOT_PROVIDER_BASE_URL: `${mockBase}/v1`,
      COPILOT_PROVIDER_API_KEY: "ollama",
      COPILOT_PROVIDER_WIRE_API: "responses",
      COPILOT_MODEL: MODEL,
      COPILOT_ALLOW_ALL: "1",
    },
    cwd: root,
  });
  await waitHttp(`http://127.0.0.1:${COPILOT_PORT}/health`, { timeoutMs: 60_000 });

  console.log("Sending A2A message/send → copilot…");
  const copilotRes = await messageSend(COPILOT_PORT, "Reply with exactly: pong");
  if (copilotRes.body.error) console.error("copilot error", copilotRes.body.error);
  else console.log("copilot taskId", copilotRes.taskId);
  await sleep(500);
  await killAgentsAndWait();

  console.log("Starting a2a-claude…");
  spawnLogged(process.execPath, [join(root, "a2a-claude/dist/cli.js"), "--config", claudeCfg], {
    label: "a2a-claude",
    agent: true,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: mockBase,
      ANTHROPIC_API_KEY: "ollama",
      ANTHROPIC_AUTH_TOKEN: "ollama",
      WORKSPACE_DIR: "/tmp/a2a-mock-ollama-claude-ws",
      CLAUDE_MODEL: MODEL,
    },
    cwd: root,
  });
  await waitHttp(`http://127.0.0.1:${CLAUDE_PORT}/health`, { timeoutMs: 60_000 });

  console.log("Sending A2A message/send → claude…");
  const claudeRes = await messageSend(CLAUDE_PORT, "Reply with exactly: pong");
  if (claudeRes.body.error) console.error("claude error", claudeRes.body.error);
  else console.log("claude taskId", claudeRes.taskId);
  await sleep(500);
  await killAgentsAndWait();

  const mockReqs = await fetch(`${mockBase}/__mock__/requests`).then((r) => r.json());
  const paths = mockReqs.requests?.map((r) => `${r.method} ${r.path}`) ?? [];
  console.log("\nMock Ollama request paths:", paths);

  const sawCopilot = paths.some((p) => p.includes("/v1/responses") || p.includes("/chat/completions"));
  const sawClaude = paths.some((p) => p.includes("/v1/messages"));
  let failed = false;
  if (copilotRes.body.error || claudeRes.body.error) {
    console.error("\nFAILED: message/send RPC error");
    failed = true;
  }
  if (!sawCopilot || !sawClaude) {
    console.error("\nFAILED: expected mock LLM traffic for both Copilot and Claude");
    failed = true;
  }
  if (failed) process.exitCode = 2;
  else console.log("\nOK — mock-ollama served real a2a-copilot + a2a-claude turns");

  cleanup();
  await sleep(400);
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
