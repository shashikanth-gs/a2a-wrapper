#!/usr/bin/env node
/**
 * Planner — the orchestrator for the software-engineering-crew example.
 *
 * Zero dependencies (Node >= 20). Talks plain A2A JSON-RPC to two agents:
 *
 *   1. implementer (a2a-claude)  — writes the feature
 *   2. tester      (a2a-codex)   — writes tests, reviews, fixes what it finds
 *
 * Usage:
 *   node planner.mjs "Add a slugify(text) helper to src/slugify.js"
 *   node planner.mjs --mock "Add a slugify helper"     # no API keys needed
 *
 * Env:
 *   IMPLEMENTER_URL  default http://localhost:3030   (a2a-claude)
 *   TESTER_URL       default http://localhost:3020   (a2a-codex)
 */

import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const mock = args.includes("--mock");
const feature = args.filter((a) => a !== "--mock").join(" ").trim();

if (!feature) {
  console.error('Usage: node planner.mjs [--mock] "<feature request>"');
  process.exit(2);
}

let implementerUrl = process.env.IMPLEMENTER_URL ?? "http://localhost:3030";
let testerUrl = process.env.TESTER_URL ?? "http://localhost:3020";
let stopMock = async () => {};

if (mock) {
  const { startMockAgents } = await import("./mock-agents.mjs");
  ({ implementerUrl, testerUrl, stop: stopMock } = await startMockAgents());
  console.log("[planner] --mock: using in-process stand-in agents (no LLM calls)\n");
}

// ─── A2A helpers ─────────────────────────────────────────────────────────────

async function discover(baseUrl) {
  const res = await fetch(`${baseUrl}/.well-known/agent-card.json`).catch(() => {
    throw new Error(`Cannot reach an agent at ${baseUrl}. Is it running?`);
  });
  if (!res.ok) throw new Error(`No agent card at ${baseUrl} (HTTP ${res.status}). Is the agent running?`);
  return res.json();
}

/** Extract all text from a Task's artifacts, falling back to the status message. */
function collectText(result) {
  const textOf = (parts = []) => parts.filter((p) => p.text != null || p.kind === "text").map((p) => p.text ?? "").join("");
  if (result.kind === "message") return textOf(result.parts);
  const fromArtifacts = (result.artifacts ?? []).map((a) => textOf(a.parts)).filter(Boolean).join("\n\n");
  return fromArtifacts || textOf(result.status?.message?.parts);
}

async function delegate(label, baseUrl, prompt, contextId) {
  const card = await discover(baseUrl);
  console.log(`[planner] → ${label}: ${card.name} (${baseUrl})`);

  const res = await fetch(`${baseUrl}/a2a/jsonrpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10 * 60_000),
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
          parts: [{ kind: "text", text: prompt }],
        },
        configuration: { blocking: true },
      },
    }),
  });

  const body = await res.json();
  if (body.error) throw new Error(`${label} failed: ${body.error.message ?? JSON.stringify(body.error)}`);

  const state = body.result?.status?.state;
  if (state && !["completed", "input-required"].includes(state)) {
    throw new Error(`${label} ended in state "${state}"`);
  }
  const text = collectText(body.result);
  console.log(`[planner] ← ${label} done (${state ?? "message"}, ${text.length} chars)\n`);
  return text;
}

// ─── The workflow ────────────────────────────────────────────────────────────

try {
  const contextId = randomUUID(); // shared so each agent keeps its own multi-turn session

  const implementation = await delegate(
    "implementer",
    implementerUrl,
    `Implement this feature in the workspace. Keep the change small, and finish with a short summary of the files you changed.\n\nFeature: ${feature}`,
    contextId,
  );

  const review = await delegate(
    "tester",
    testerUrl,
    `Another engineer just implemented a feature in this workspace. Write tests for it, run them, fix any bugs you find, and report what you changed.\n\nFeature: ${feature}\n\nImplementer's summary:\n${implementation}`,
    contextId,
  );

  console.log("═".repeat(72));
  console.log("FEATURE REQUEST\n" + feature);
  console.log("\nIMPLEMENTATION (Claude via a2a-claude)\n" + implementation);
  console.log("\nTESTS & REVIEW (Codex via a2a-codex)\n" + review);
  console.log("═".repeat(72));
} catch (err) {
  console.error(`[planner] ${err.message}`);
  process.exitCode = 1;
} finally {
  await stopMock();
}
