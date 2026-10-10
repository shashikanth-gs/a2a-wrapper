#!/usr/bin/env node
/**
 * End-to-end OTel cookout via fake Ollama (BYOK) — Copilot + Claude.
 *
 * Prerequisites:
 *   - packages built: core, a2a-copilot, a2a-claude
 *   - optional peers: @opentelemetry/sdk-node + exporter-trace-otlp-proto
 *   - Phoenix: `phoenix serve` (or set SKIP_PHOENIX_CHECK=1)
 *
 *   node examples/otel-stack/cookout-byok.mjs
 *
 * Flow:
 *   1. Start mock-ollama (OpenAI + Anthropic compatible)
 *   2. Start a2a-copilot with BYOK provider → mock
 *   3. Start a2a-claude with ANTHROPIC_BASE_URL → mock
 *   4. POST message/send to each
 *   5. Assert Phoenix has a2a.wrapper.sdk spans for both
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const require = createRequire(import.meta.url);

const MOCK_PORT = Number(process.env.MOCK_OLLAMA_PORT || 19134);
const PHOENIX = process.env.PHOENIX_API || "http://127.0.0.1:6006";
const COPILOT_PORT = Number(process.env.COOKOUT_COPILOT_PORT || 3101);
const CLAUDE_PORT = Number(process.env.COOKOUT_CLAUDE_PORT || 3102);
const MODEL = process.env.MOCK_OLLAMA_MODEL || "mock-ollama";

const children = [];
/** @type {import('node:child_process').ChildProcess[]} */
const agentChildren = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnLogged(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  const label = opts.label || cmd;
  child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  children.push(child);
  if (opts.agent) agentChildren.push(child);
  return child;
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
}

async function waitHttp(url, { timeoutMs = 30_000, ok = (s) => s >= 200 && s < 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (ok(res.status)) return;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function messageSend(port, text) {
  const contextId = randomUUID();
  const messageId = randomUUID();
  // Do NOT pre-assign taskId — A2A creates the task. Passing an unknown taskId
  // yields "Task not found" from the SDK ResultManager.
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
          messageId,
          role: "user",
          contextId,
          parts: [{ kind: "text", text }],
        },
        configuration: { blocking: true },
      },
    }),
  });
  const body = await res.json();
  const taskId = body.result?.id ?? body.result?.taskId ?? body.result?.status?.taskId;
  return { status: res.status, body, taskId, contextId, messageId };
}

function writePatchedConfig(srcName, port, mockBase) {
  const src = JSON.parse(readFileSync(join(__dirname, srcName), "utf8"));
  src.server.port = port;
  if (src.copilot?.provider) {
    src.copilot.provider.baseUrl = `${mockBase}/v1`;
    src.copilot.model = MODEL;
    src.copilot.workspaceDirectory = `/tmp/a2a-cookout-copilot-ws`;
    mkdirSync(src.copilot.workspaceDirectory, { recursive: true });
  }
  if (src.claude) {
    src.claude.model = MODEL;
    src.claude.workingDirectory = `/tmp/a2a-cookout-claude-ws`;
    mkdirSync(src.claude.workingDirectory, { recursive: true });
  }
  const out = join("/tmp", `a2a-cookout-${srcName}`);
  writeFileSync(out, JSON.stringify(src, null, 2));
  return out;
}

async function phoenixSpans(limit = 50) {
  const res = await fetch(`${PHOENIX}/v1/projects/default/spans?limit=${limit}`);
  if (!res.ok) throw new Error(`Phoenix spans HTTP ${res.status}`);
  return res.json();
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
  if (!process.env.SKIP_PHOENIX_CHECK) {
    await waitHttp(`${PHOENIX}/healthz`, { timeoutMs: 5_000 });
    console.log("Phoenix OK", PHOENIX);
  }

  const mockBase = `http://127.0.0.1:${MOCK_PORT}`;
  console.log("Starting mock-ollama on", MOCK_PORT);
  spawnLogged(process.execPath, [join(__dirname, "mock-ollama.mjs")], {
    label: "mock-ollama",
    env: {
      ...process.env,
      MOCK_OLLAMA_PORT: String(MOCK_PORT),
      MOCK_OLLAMA_MODEL: MODEL,
      MOCK_OLLAMA_REPLY: "pong-from-mock-ollama",
    },
  });
  await waitHttp(`${mockBase}/health`);

  // Verify CLIs can talk to mock (cheap sanity)
  const chat = await fetch(`${mockBase}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
  }).then((r) => r.json());
  console.log("mock chat ok:", chat.choices?.[0]?.message?.content);

  const copilotCfg = writePatchedConfig("agent-copilot-byok.json", COPILOT_PORT, mockBase);
  const claudeCfg = writePatchedConfig("agent-claude-byok.json", CLAUDE_PORT, mockBase);

  // Sequential: one provider at a time so each CLI can flush OTel cleanly.
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
  console.log("copilot status", copilotRes.status);
  if (copilotRes.body.error) console.error("copilot error", copilotRes.body.error);
  else console.log("copilot taskId", copilotRes.taskId, "contextId", copilotRes.contextId);
  // Let SimpleSpanProcessor finish the OTLP POST before SIGTERM.
  await sleep(1000);

  console.log("Stopping a2a-copilot (flush OTel)…");
  await killAgentsAndWait();
  agentChildren.length = 0;

  console.log("Starting a2a-claude…");
  spawnLogged(process.execPath, [join(root, "a2a-claude/dist/cli.js"), "--config", claudeCfg], {
    label: "a2a-claude",
    agent: true,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: mockBase,
      ANTHROPIC_API_KEY: "ollama",
      ANTHROPIC_AUTH_TOKEN: "ollama",
      WORKSPACE_DIR: "/tmp/a2a-cookout-claude-ws",
      CLAUDE_MODEL: MODEL,
    },
    cwd: root,
  });
  await waitHttp(`http://127.0.0.1:${CLAUDE_PORT}/health`, { timeoutMs: 60_000 });

  console.log("Sending A2A message/send → claude…");
  const claudeRes = await messageSend(CLAUDE_PORT, "Reply with exactly: pong");
  console.log("claude status", claudeRes.status);
  if (claudeRes.body.error) console.error("claude error", claudeRes.body.error);
  else console.log("claude taskId", claudeRes.taskId, "contextId", claudeRes.contextId);
  await sleep(1000);

  console.log("Stopping a2a-claude (flush OTel)…");
  await killAgentsAndWait();
  await sleep(500);

  const spans = await phoenixSpans(100);
  const matchCookout = (sdk, contextId, taskId) =>
    (spans.data ?? []).filter((s) => {
      if (s.name !== "a2a.task.execute") return false;
      if (s.attributes?.["a2a.wrapper.sdk"] !== sdk) return false;
      const conv = s.attributes?.["gen_ai.conversation.id"];
      const tid = s.attributes?.["a2a.task.id"];
      return conv === contextId || tid === taskId;
    });

  const copilotSpans = matchCookout("a2a-copilot", copilotRes.contextId, copilotRes.taskId);
  const claudeSpans = matchCookout("a2a-claude", claudeRes.contextId, claudeRes.taskId);
  const summarize = (s) => ({
    sdk: s.attributes?.["a2a.wrapper.sdk"],
    sdkVersion: s.attributes?.["a2a.wrapper.sdk.version"],
    core: s.attributes?.["a2a.wrapper.core.version"],
    taskId: s.attributes?.["a2a.task.id"],
    conversation: s.attributes?.["gen_ai.conversation.id"],
    input: s.attributes?.["a2a.task.usage.input_tokens"],
    output: s.attributes?.["a2a.task.usage.output_tokens"],
  });

  console.log("\nPhoenix a2a-copilot cookout spans:", copilotSpans.length);
  console.log(JSON.stringify(copilotSpans.map(summarize), null, 2));
  console.log("\nPhoenix a2a-claude cookout spans:", claudeSpans.length);
  console.log(JSON.stringify(claudeSpans.map(summarize), null, 2));

  const mockReqs = await fetch(`${mockBase}/__mock__/requests`).then((r) => r.json());
  const paths = mockReqs.requests?.map((r) => `${r.method} ${r.path}`) ?? [];
  console.log("\nMock Ollama request paths:", paths);
  const sawCopilotLlm = paths.some((p) => p.includes("/v1/responses") || p.includes("/chat/completions"));
  const sawClaudeLlm = paths.some((p) => p.includes("/v1/messages"));

  let failed = false;
  if (copilotRes.body.error || claudeRes.body.error) {
    console.error("\nFAILED: message/send returned RPC error");
    failed = true;
  }
  if (!sawCopilotLlm) {
    console.error("\nFAILED: mock-ollama never saw Copilot LLM traffic (/v1/responses)");
    failed = true;
  }
  if (!sawClaudeLlm) {
    console.error("\nFAILED: mock-ollama never saw Claude LLM traffic (/v1/messages)");
    failed = true;
  }
  if (!copilotSpans.length || !claudeSpans.length) {
    console.error("\nFAILED: expected Phoenix spans for this cookout's context/task ids");
    failed = true;
  }

  if (failed) {
    process.exitCode = 2;
  } else {
    console.log("\nOK — BYOK cookout: mock Ollama served Copilot+Claude; Phoenix has both wrapper spans");
  }

  cleanup();
  // Give children a moment to exit before process ends.
  await sleep(500);
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
