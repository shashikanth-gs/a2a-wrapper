#!/usr/bin/env node
/**
 * ask.mjs — the smallest possible A2A client (Node >= 20, no dependencies).
 *
 *   node ask.mjs "What does Array.prototype.flatMap do?"
 *
 * It discovers the agent from its agent card, sends one message, prints the answer.
 * Env: AGENT_URL (default http://localhost:3000)
 */
import { randomUUID } from "node:crypto";

const base = process.env.AGENT_URL ?? "http://localhost:3000";
const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('Usage: node ask.mjs "<question>"');
  process.exit(2);
}

try {
  const card = await fetch(`${base}/.well-known/agent-card.json`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((e) => { throw new Error(`Cannot reach an agent at ${base} (${e.message}). Is it running?`); });
  console.log(`Agent: ${card.name}  ·  skills: ${(card.skills ?? []).map((s) => s.id).join(", ")}\n`);

  const res = await fetch(card.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/send",
      params: {
        message: { kind: "message", messageId: randomUUID(), role: "user", parts: [{ kind: "text", text: question }] },
        configuration: { blocking: true },
      },
    }),
  });
  const { result, error } = await res.json();
  if (error) throw new Error(error.message ?? JSON.stringify(error));

  const text = (parts = []) => parts.map((p) => p.text ?? "").join("");
  const answer = result.kind === "message"
    ? text(result.parts)
    : (result.artifacts ?? []).map((a) => text(a.parts)).join("\n") || text(result.status?.message?.parts);
  const wrap = (t) => t.trim().replace(/(.{1,90})(\s+|$)/g, "$1\n").trimEnd();
  console.log(answer ? wrap(answer) : JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
