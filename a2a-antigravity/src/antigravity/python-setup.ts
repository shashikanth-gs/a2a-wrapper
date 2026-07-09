import { accessSync, constants, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

interface SetupOptions {
  python?: string;
  venvDir?: string;
  force?: boolean;
}

interface PythonRuntime {
  command: string;
  executable: string;
  version: string;
}

export class PythonSetupError extends Error {
  readonly remediation: string[];

  constructor(message: string, remediation: string[] = [], options?: { cause?: unknown }) {
    super(message);
    this.name = "PythonSetupError";
    this.remediation = remediation;
    if (options?.cause) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "../..");
const REQUIREMENTS_PATH = join(PACKAGE_ROOT, "requirements.txt");

export function managedVenvDir(): string {
  if (process.env["A2A_ANTIGRAVITY_HOME"]) {
    return resolve(process.env["A2A_ANTIGRAVITY_HOME"], "venv");
  }

  if (process.env["A2A_ANTIGRAVITY_VENV"]) {
    return resolve(process.env["A2A_ANTIGRAVITY_VENV"]);
  }

  if (platform() === "win32") {
    const base = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return join(base, "a2a-antigravity", "venv");
  }

  if (platform() === "darwin") {
    return join(homedir(), "Library", "Caches", "a2a-antigravity", "venv");
  }

  const base = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  return join(base, "a2a-antigravity", "venv");
}

export function managedPythonPath(venvDir = managedVenvDir()): string {
  return platform() === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

export function hasManagedPython(): boolean {
  const pythonPath = managedPythonPath();
  if (!existsSync(pythonPath)) return false;
  try {
    accessSync(pythonPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function setupPythonEnvironment(options: SetupOptions = {}): Promise<string> {
  const runtime = await resolvePythonRuntime(options.python);
  const venvDir = resolve(options.venvDir ?? managedVenvDir());
  const venvPython = managedPythonPath(venvDir);

  if (options.force && existsSync(venvDir)) {
    console.log(`Removing existing managed Python environment: ${venvDir}`);
    rmSync(venvDir, { recursive: true, force: true });
  }

  if (!existsSync(venvPython)) {
    mkdirSync(dirname(venvDir), { recursive: true });
    console.log(`Creating managed Python environment: ${venvDir}`);
    await run(runtime.command, ["-m", "venv", venvDir], {
      step: "create managed Python virtual environment",
      remediation: [
        "Install Python's venv support for your platform, then rerun `a2a-antigravity setup --force`.",
        "On Debian/Ubuntu this is usually `sudo apt install python3-venv`.",
        "You can also pass a known-good interpreter with `a2a-antigravity setup --python /path/to/python3`.",
      ],
    });
  } else {
    console.log(`Using existing managed Python environment: ${venvDir}`);
  }

  console.log("Upgrading pip in managed Python environment...");
  await run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], {
    step: "upgrade pip in managed Python environment",
    remediation: [
      "Check network access to PyPI and any corporate proxy or certificate settings.",
      "If the venv is corrupted, rerun `a2a-antigravity setup --force`.",
    ],
  });

  console.log(`Installing Python requirements from ${REQUIREMENTS_PATH}...`);
  await run(venvPython, ["-m", "pip", "install", "-r", REQUIREMENTS_PATH], {
    step: "install Antigravity Python requirements",
    remediation: [
      "Check network access to PyPI and confirm the `google-antigravity` wheel supports this OS, CPU, and Python version.",
      "Try a different Python interpreter with `a2a-antigravity setup --python /path/to/python3 --force`.",
      `If you manage Python yourself, install requirements with: ${venvPython} -m pip install -r ${REQUIREMENTS_PATH}`,
    ],
  });

  await run(venvPython, ["-c", "import google.antigravity; print('google-antigravity ok')"], {
    step: "verify google-antigravity import",
    remediation: [
      "Rerun `a2a-antigravity setup --force` to rebuild the managed environment.",
      "If the import still fails, use `ANTIGRAVITY_PYTHON=/path/to/python` with an environment where `google-antigravity` is installed.",
    ],
  });
  console.log(`Managed Python ready: ${venvPython}`);
  return venvPython;
}

async function resolvePythonRuntime(preferred?: string): Promise<PythonRuntime> {
  const versionedPythonCommands = [
    "python3.14",
    "python3.13",
    "python3.12",
    "python3.11",
    "python3.10",
  ];
  const commonPythonPaths = platform() === "win32"
    ? []
    : [
        "/opt/homebrew/bin/python3",
        "/opt/homebrew/bin/python3.14",
        "/opt/homebrew/bin/python3.13",
        "/opt/homebrew/bin/python3.12",
        "/opt/homebrew/bin/python3.11",
        "/opt/homebrew/bin/python3.10",
        "/usr/local/bin/python3",
        "/usr/local/bin/python3.14",
        "/usr/local/bin/python3.13",
        "/usr/local/bin/python3.12",
        "/usr/local/bin/python3.11",
        "/usr/local/bin/python3.10",
      ];
  const candidates = preferred
    ? [preferred]
    : [
        process.env["PYTHON"],
        ...versionedPythonCommands,
        platform() === "win32" ? "python" : "python3",
        "python",
        ...commonPythonPaths,
      ].filter((value): value is string => Boolean(value));

  const seen = new Set<string>();
  const failures: string[] = [];
  for (const command of candidates) {
    if (seen.has(command)) continue;
    seen.add(command);
    try {
      const probe = await capture(command, [
        "-c",
        "import sys; print(sys.executable); print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')",
      ]);
      const [executable = command, version = "unknown"] = probe.stdout.trim().split(/\r?\n/);
      const [majorRaw, minorRaw] = version.split(".");
      const major = Number(majorRaw);
      const minor = Number(minorRaw);
      if (major > 3 || (major === 3 && minor >= 10)) {
        return { command, executable, version };
      }
      const msg = `Skipping Python ${version} at ${executable}; google-antigravity requires Python >= 3.10.`;
      failures.push(msg);
      console.warn(msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${command}: ${msg}`);
      // Try the next candidate.
    }
  }

  throw new PythonSetupError(
    preferred
      ? `The requested Python runtime is not usable: ${preferred}`
      : "Could not find a usable Python >= 3.10 runtime. Install Python 3.10+ or pass --python <path>.",
    [
      "Install Python 3.10 or newer.",
      "Rerun setup with `a2a-antigravity setup --python /path/to/python3`.",
      ...(failures.length ? [`Python candidates checked: ${failures.join("; ")}`] : []),
    ],
  );
}

function run(
  command: string,
  args: string[],
  context: { step: string; remediation?: string[] },
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("error", (err) => {
      reject(new PythonSetupError(
        `Failed to ${context.step}: could not start ${command}: ${err.message}`,
        context.remediation,
        { cause: err },
      ));
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new PythonSetupError(
        `Failed to ${context.step}: ${command} ${args.join(" ")} exited with code ${code ?? "null"}${signal ? `, signal ${signal}` : ""}.`,
        context.remediation,
      ));
    });
  });
}

function capture(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (exit ${code ?? "null"}, signal ${signal ?? "null"}): ${stderr}`));
    });
  });
}
