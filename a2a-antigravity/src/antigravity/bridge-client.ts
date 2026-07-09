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
import { hasManagedPython, managedPythonPath } from "./python-setup.js";

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
  private shuttingDown = false;
  private closedProcesses = new WeakSet<ChildProcessWithoutNullStreams>();

  constructor(config: Required<AgentConfig>) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.started) return;

    const pythonPath = this.resolvePythonPath();
    const bridgePath = resolveBridgePath(this.config.antigravity.bridgePath);
    await this.checkPythonRuntime(pythonPath);

    const proc = spawn(pythonPath, [bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.proc = proc;

    proc.on("error", (err) => {
      const msg = `Antigravity bridge process error: ${err.message}`;
      log.error(msg);
      this.markExited(proc, new Error(msg));
    });

    proc.on("exit", (code, signal) => {
      const msg = `Antigravity bridge exited (${code ?? "null"}, ${signal ?? "null"})`;
      if (this.shuttingDown) log.debug(msg);
      else log.warn(msg);
      this.markExited(proc, new Error(msg));
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) log.debug(text);
    });

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => this.handleLine(line));
    proc.on("close", () => {
      this.closedProcesses.add(proc);
      rl.close();
    });

    await this.sendAndWait({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      id: randomUUID(),
      command: "initialize",
      config: this.buildBridgeConfig(),
    });
    this.started = true;
  }

  private resolvePythonPath(): string {
    const configured = this.config.antigravity.pythonPath;
    const explicit = Boolean(process.env["ANTIGRAVITY_PYTHON"])
      || process.env["A2A_ANTIGRAVITY_EXPLICIT_PYTHON"] === "1"
      || (Boolean(configured) && configured !== "python3");

    if (explicit) return configured ?? "python3";

    if (hasManagedPython()) {
      const managed = managedPythonPath();
      log.debug("Using managed Antigravity Python environment", { pythonPath: managed });
      return managed;
    }

    return configured ?? "python3";
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
            `where google-antigravity is installed, or run "a2a-antigravity setup" ` +
            `to create the managed environment.`,
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
            `Install Python, run "a2a-antigravity setup", or set ` +
            `antigravity.pythonPath/ANTIGRAVITY_PYTHON.`,
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
            `Run "a2a-antigravity setup" to create the managed Python environment, ` +
            `or install it manually with: ${pythonPath} -m pip install google-antigravity. ` +
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
    const proc = this.proc;
    if (!proc) return;

    this.shuttingDown = true;
    this.rejectAll(new Error("Antigravity bridge is shutting down"));

    try {
      if (proc.stdin.writable) {
        await this.sendAndWait({
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          id: randomUUID(),
          command: "shutdown",
        });
      }
    } catch {
      // Process may have already exited; shutdown stays best-effort.
    }

    try {
      if (proc.stdin.writable) proc.stdin.end();
    } catch {
      // Best-effort EOF so the Python read loop can exit naturally.
    }

    try {
      await this.waitForClose(proc, 5_000);
    } catch {
      log.warn("Antigravity bridge did not exit after shutdown request; sending SIGTERM");
      proc.kill("SIGTERM");
      try {
        await this.waitForClose(proc, 2_000);
      } catch {
        log.warn("Antigravity bridge did not exit after SIGTERM; sending SIGKILL");
        proc.kill("SIGKILL");
        await this.waitForClose(proc, 1_000).catch(() => undefined);
      }
    } finally {
      if (this.proc === proc) this.proc = null;
      this.started = false;
      this.shuttingDown = false;
    }
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

    const proc = this.proc;
    const timeoutMs = this.config.timeouts.bridgeStartup ?? 30_000;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`Antigravity bridge request timed out: ${request.command}`));
      }, timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify(request)}\n`, "utf8", (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(new Error(`Failed to write bridge request ${request.command}: ${err.message}`));
      });
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

  private markExited(proc: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.started = false;
    this.rejectAll(error);
  }

  private waitForClose(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (this.closedProcesses.has(proc)) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting ${timeoutMs}ms for Antigravity bridge to exit`));
      }, timeoutMs);

      const onClose = (): void => {
        cleanup();
        resolve();
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        proc.off("close", onClose);
      };

      proc.once("close", onClose);
    });
  }
}
