#!/usr/bin/env node
/**
 * Compatibility shim — mock Ollama moved to examples/mock-ollama/server.mjs
 * so it can be reused beyond OTel cookouts.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

console.warn(
  "[deprecated] examples/otel-stack/mock-ollama.mjs → use examples/mock-ollama/server.mjs",
);

const child = spawn(
  process.execPath,
  [join(dirname(fileURLToPath(import.meta.url)), "../mock-ollama/server.mjs")],
  { stdio: "inherit", env: process.env },
);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
