#!/usr/bin/env node
/**
 * Drive real a2a-copilot + a2a-claude executor code paths into a local Phoenix.
 *
 * This is NOT a live LLM call (this env has no Copilot policy access /
 * Claude login). It runs each wrapper's executor under instrumentExecutor with
 * a fake/mocked backend session so Phoenix receives authentic wrapper spans:
 *   - span name a2a.task.execute
 *   - a2a.wrapper.sdk = a2a-copilot | a2a-claude
 *   - a2a.wrapper.core.version
 *   - a2a.task.usage.* from applyUsageSummaryToActiveSpan
 *
 *   phoenix serve
 *   node examples/otel-stack/smoke-providers.mjs
 */

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const require = createRequire(import.meta.url);
const phoenixApi = process.env.PHOENIX_API ?? "http://127.0.0.1:6006";
const endpoint = process.env.OTEL_EXPORTER_ENDPOINT ?? "http://127.0.0.1:6006";

async function load(rel) {
  return import(pathToFileURL(join(root, rel)).href);
}

function makeBus() {
  const events = [];
  return {
    events,
    publish: (e) => events.push(e),
    finished: () => {},
    on() { return this; },
    off() { return this; },
    once() { return this; },
    removeAllListeners() { return this; },
  };
}

function makeCtx(taskId, contextId, text) {
  return {
    taskId,
    contextId,
    task: undefined,
    userMessage: {
      messageId: `msg-${taskId}`,
      contextId,
      taskId,
      role: 1,
      parts: [{ content: { $case: "text", value: text }, metadata: undefined }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
  };
}

/** Minimal Claude Agent SDK fake (mirrors test FakeClaudeClient happy path). */
function makeFakeClaudeClient(text = "claude-otel-pong") {
  const sessionId = "claude-otel-sess";
  return {
    calls: [],
    runQuery(prompt, options) {
      this.calls.push({ prompt, options });
      const messages = [
        { type: "system", subtype: "init", session_id: sessionId, model: "claude-test", plugins: [] },
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text }] },
        },
        {
          type: "result",
          subtype: "success",
          result: text,
          usage: { input_tokens: 11, output_tokens: 7 },
          total_cost_usd: 0.02,
          num_turns: 1,
          session_id: sessionId,
          model: "claude-test",
          duration_ms: 42,
        },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
        },
        interrupt: async () => {},
        close: async () => {},
      };
    },
  };
}

function makeMockCopilotSession() {
  const handlers = new Map();
  return {
    sessionId: "copilot-otel-sess",
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    async send() {},
    async sendAndWait() {
      return { data: { content: "copilot-otel-pong" } };
    },
    async disconnect() {},
    async destroy() {},
    emit(event, data) {
      for (const h of handlers.get(event) ?? []) h({ data });
    },
  };
}

async function queryPhoenixSpans(limit = 20) {
  const res = await fetch(`${phoenixApi}/v1/projects/default/spans?limit=${limit}`);
  if (!res.ok) throw new Error(`Phoenix spans HTTP ${res.status}`);
  return res.json();
}

function findProviderSpans(spans, sdk) {
  return (spans.data ?? []).filter(
    (s) =>
      s.name === "a2a.task.execute" &&
      s.attributes?.["a2a.wrapper.sdk"] === sdk,
  );
}

async function runClaude(core) {
  const { ClaudeExecutor } = await load("a2a-claude/dist/claude/executor.js");
  const { DEFAULTS } = await load("a2a-claude/dist/config/defaults.js");
  const pkg = require(join(root, "a2a-claude/package.json"));

  const ws = mkdtempSync(join(tmpdir(), "a2a-claude-otel-"));
  try {
    const config = structuredClone(DEFAULTS);
    config.claude.workingDirectory = ws;
    config.events = { enabled: false };
    config.otel = {
      enabled: true,
      serviceName: "a2a-claude-smoke",
      taskUsageRollup: true,
      annotateUsageCalls: true,
      exporter: { endpoint, protocol: "http/protobuf" },
    };

    const fake = makeFakeClaudeClient();
    const raw = new ClaudeExecutor(config, () => fake);
    const ex = core.instrumentExecutor(raw, {
      otel: config.otel,
      agentName: config.agentCard.name,
      wrapperName: pkg.name,
      wrapperVersion: pkg.version,
    });

    await ex.initialize();
    const bus = makeBus();
    const taskId = `claude-${Date.now()}`;
    await ex.execute(makeCtx(taskId, "claude-conv", "say pong"), bus);
    await ex.shutdown();
    return { taskId, sdk: pkg.name, version: pkg.version };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

async function runCopilot(core) {
  const { CopilotExecutor } = await load("a2a-copilot/dist/copilot/executor.js");
  const { DEFAULTS } = await load("a2a-copilot/dist/config/defaults.js");
  const pkg = require(join(root, "a2a-copilot/package.json"));

  const config = structuredClone(DEFAULTS);
  config.copilot.streaming = false; // sendAndWait path is simpler for the mock
  config.events = { enabled: false };
  config.features = { ...(config.features ?? {}), trackUsage: true };
  config.otel = {
    enabled: true,
    serviceName: "a2a-copilot-smoke",
    taskUsageRollup: true,
    annotateUsageCalls: true,
    exporter: { endpoint, protocol: "http/protobuf" },
    backend: {
      // Marks backend OTel "on" for de-dupe policy; we still want task usage rollup.
      copilot: { otlpEndpoint: endpoint, propagateTraceContext: true },
    },
  };

  const raw = new CopilotExecutor(config);
  const session = makeMockCopilotSession();

  // Skip real Copilot CLI spawn (policy-denied in this env) but keep executor logic.
  raw.initialize = async () => {
    raw.sessionManager = {
      getOrCreate: async () => ({ sessionId: session.sessionId, session, isNew: true }),
      trackTask: () => {},
      untrackTask: () => {},
      getSessionForTask: () => undefined,
      getContextForTask: () => "copilot-conv",
      startCleanup: () => {},
      shutdown: async () => {},
    };
    raw.mcpHooks = { setEmitter: () => {}, clearEmitter: () => {} };
    raw.initialized = true;
  };

  const origSendAndWait = session.sendAndWait.bind(session);
  session.sendAndWait = async (params) => {
    // Fire usage the same way Copilot SDK does (see usage-telemetry tests).
    session.emit("assistant.usage", {
      model: "gpt-4.1-smoke",
      inputTokens: 21,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      duration: 55,
      timeToFirstTokenMs: 12,
      cost: 0,
      apiEndpoint: null,
      initiator: null,
    });
    return origSendAndWait(params);
  };

  const ex = core.instrumentExecutor(raw, {
    otel: config.otel,
    agentName: config.agentCard.name,
    wrapperName: pkg.name,
    wrapperVersion: pkg.version,
  });

  await ex.initialize();
  const bus = makeBus();
  const taskId = `copilot-${Date.now()}`;
  await ex.execute(makeCtx(taskId, "copilot-conv", "say pong"), bus);
  await ex.shutdown();
  return { taskId, sdk: pkg.name, version: pkg.version };
}

async function main() {
  const core = await load("packages/core/dist/index.js");
  const ok = await core.bootstrapOtelSdkFromConfig({
    enabled: true,
    serviceName: "a2a-provider-smoke",
    exporter: { endpoint, protocol: "http/protobuf" },
  });
  if (!ok) {
    console.error("OTel bootstrap failed — need sdk-node + exporter-trace-otlp-proto");
    process.exit(1);
  }

  console.log("Running Claude executor path…");
  const claude = await runClaude(core);
  console.log("  ok", claude);

  console.log("Running Copilot executor path…");
  const copilot = await runCopilot(core);
  console.log("  ok", copilot);

  await core.shutdownOtelSdk();
  await new Promise((r) => setTimeout(r, 2000));

  const spans = await queryPhoenixSpans(50);
  const claudeSpans = findProviderSpans(spans, "a2a-claude");
  const copilotSpans = findProviderSpans(spans, "a2a-copilot");

  const summarize = (s) => ({
    name: s.name,
    sdk: s.attributes?.["a2a.wrapper.sdk"],
    sdkVersion: s.attributes?.["a2a.wrapper.sdk.version"],
    coreVersion: s.attributes?.["a2a.wrapper.core.version"],
    taskId: s.attributes?.["a2a.task.id"],
    input: s.attributes?.["a2a.task.usage.input_tokens"],
    output: s.attributes?.["a2a.task.usage.output_tokens"],
    conversation: s.attributes?.["gen_ai.conversation.id"],
  });

  console.log("\nPhoenix spans for a2a-claude:", claudeSpans.length);
  console.log(JSON.stringify(claudeSpans.map(summarize), null, 2));
  console.log("\nPhoenix spans for a2a-copilot:", copilotSpans.length);
  console.log(JSON.stringify(copilotSpans.map(summarize), null, 2));

  if (!claudeSpans.length || !copilotSpans.length) {
    console.error("\nFAILED: expected at least one span per provider SDK in Phoenix");
    process.exit(2);
  }
  console.log("\nOK — both provider wrapper spans ingested by Phoenix");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
