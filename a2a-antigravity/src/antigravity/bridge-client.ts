/**
 * Bridge Client
 *
 * Owns the private Python subprocess and JSONL protocol plumbing.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentConfig } from "../config/types.js";
import { resolveBridgePath } from "./backend-paths.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  parseBridgeMessage,
  type BridgeConfig,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeRunEvent,
} from "./bridge-protocol.js";
import { logger } from "../utils/logger.js";

const log = logger.child("bridge-client");

interface PendingRequest {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveRun {
  onEvent(event: BridgeRunEvent): void;
  resolve(event: BridgeRunEvent): void;
  reject(error: Error): void;
}

export class BridgeClient {
  private readonly config: Required<AgentConfig>;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private activeRuns = new Map<string, ActiveRun>();
  private started = false;

  constructor(config: Required<AgentConfig>) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.started) return;

    const pythonPath = this.config.antigravity.pythonPath ?? "python3";
    const bridgePath = resolveBridgePath(this.config.antigravity.bridgePath);
    await this.checkPythonRuntime(pythonPath);

    this.proc = spawn(pythonPath, [bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.proc.on("exit", (code, signal) => {
      const msg = `Antigravity bridge exited (${code ?? "null"}, ${signal ?? "null"})`;
      log.warn(msg);
      this.rejectAll(new Error(msg));
      this.started = false;
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) log.debug(text);
    });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    await this.sendAndWait({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: randomUUID(),
      command: "initialize",
      config: this.buildBridgeConfig(),
    });
    this.started = true;
  }

  private checkPythonRuntime(pythonPath: string): Promise<void> {
    const timeoutMs = this.config.timeouts.bridgeStartup ?? 30_000;
    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        pythonPath,
        ["-c", "import google.antigravity; print('google-antigravity ok')"],
        { stdio: ["ignore", "pipe", "pipe"], env: process.env },
      );
      let stderr = "";
      let stdout = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(
          new Error(
            `Python runtime check timed out after ${timeoutMs}ms. ` +
            `Set antigravity.pythonPath/ANTIGRAVITY_PYTHON to a Python environment ` +
            `where google-antigravity is installed.`,
          ),
        );
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `Failed to start Python runtime "${pythonPath}": ${err.message}. ` +
            `Install Python or set antigravity.pythonPath/ANTIGRAVITY_PYTHON.`,
          ),
        );
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          log.debug("Python runtime check passed", { pythonPath, output: stdout.trim() });
          resolve();
          return;
        }
        reject(
          new Error(
            `Python runtime "${pythonPath}" cannot import google-antigravity ` +
            `(exit ${code ?? "null"}, signal ${signal ?? "null"}). ` +
            `Install it with: ${pythonPath} -m pip install google-antigravity. ` +
            `${stderr.trim() ? `stderr: ${stderr.trim()}` : ""}`,
          ),
        );
      });
    });
  }

  async openSession(sessionId: string, contextId: string): Promise<void> {
    await this.start();
    await this.sendAndWait({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: randomUUID(),
      command: "open_session",
      sessionId,
      contextId,
      config: this.buildBridgeConfig(),
    });
  }

  async run(
    sessionId: string,
    taskId: string,
    prompt: string,
    onEvent: (event: BridgeRunEvent) => void,
  ): Promise<BridgeRunEvent> {
    await this.start();
    const requestId = randomUUID();

    const terminal = new Promise<BridgeRunEvent>((resolve, reject) => {
      this.activeRuns.set(taskId, { onEvent, resolve, reject });
    });

    try {
      await this.sendAndWait({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        id: requestId,
        command: "run",
        taskId,
        sessionId,
        prompt,
      });
      return await terminal;
    } catch (err) {
      this.activeRuns.delete(taskId);
      throw err;
    }
  }

  async cancel(taskId: string): Promise<void> {
    await this.start();
    await this.sendAndWait({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: randomUUID(),
      command: "cancel",
      taskId,
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.proc) return;
    await this.sendAndWait({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: randomUUID(),
      command: "close_session",
      sessionId,
    });
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.sendAndWait({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        id: randomUUID(),
        command: "shutdown",
      });
    } catch {
      // Process may have already exited; shutdown stays best-effort.
    }
    this.proc.kill();
    this.proc = null;
    this.started = false;
  }

  private buildBridgeConfig(): BridgeConfig {
    return {
      antigravity: this.config.antigravity,
      mcp: this.config.mcp,
      logLevel: this.config.logging.level,
    };
  }

  private sendAndWait(request: BridgeRequest): Promise<void> {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error("Antigravity bridge is not running"));
    }

    const timeoutMs = this.config.timeouts.bridgeStartup ?? 30_000;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`Antigravity bridge request timed out: ${request.command}`));
      }, timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      this.proc!.stdin.write(`${JSON.stringify(request)}\n`, "utf8");
    });
  }

  private handleLine(line: string): void {
    let msg: BridgeMessage;
    try {
      msg = parseBridgeMessage(line);
    } catch (err) {
      log.warn("Invalid bridge message", { error: (err as Error).message, line });
      return;
    }

    if (msg.kind === "ack") {
      const pending = this.pending.get(msg.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.requestId);
      if (msg.ok) {
        pending.resolve();
      } else {
        const err = new Error(`${msg.code}: ${msg.message}`);
        (err as Error & { code?: string; details?: unknown }).code = msg.code;
        (err as Error & { code?: string; details?: unknown }).details = msg.details;
        pending.reject(err);
      }
      return;
    }

    if ("taskId" in msg && msg.taskId) {
      const active = this.activeRuns.get(msg.taskId);
      if (!active) return;
      active.onEvent(msg);
      if (msg.kind === "completed" || msg.kind === "canceled" || msg.kind === "failed") {
        this.activeRuns.delete(msg.taskId);
        active.resolve(msg);
      }
      return;
    }

    if (msg.kind === "log") {
      const data = msg.data ?? {};
      if (msg.level === "error") log.error(msg.message, data);
      else if (msg.level === "warn") log.warn(msg.message, data);
      else if (msg.level === "debug") log.debug(msg.message, data);
      else log.info(msg.message, data);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const run of this.activeRuns.values()) {
      run.reject(error);
    }
    this.activeRuns.clear();
  }
}
