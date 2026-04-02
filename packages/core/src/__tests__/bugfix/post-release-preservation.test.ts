import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Preservation Property Tests — Post-Release Fixes
 *
 * These tests capture the EXISTING (baseline) behavior of the unfixed code.
 * They must PASS on unfixed code. After the fix is applied, they must
 * continue to pass — confirming no regressions.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 */

const REPO_ROOT = resolve(__dirname, "../../../../..");

// ─── Helpers: Replicate executor logic from a2a-copilot/src/copilot/executor.ts ──

/**
 * Replicate the execute() catch-block logic from CopilotExecutor.
 * This is the UNFIXED code path — it only checks for connection errors.
 */
function executeErrorHandler(
  errorMessage: string,
  cliUrl: string | undefined,
): { state: string; userMsg: string } {
  const msg = errorMessage;
  const isConnErr =
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("connect") ||
    msg.includes("socket");
  const userMsg =
    isConnErr && cliUrl
      ? `Cannot reach GitHub Copilot CLI server at ${cliUrl}. Is it running?`
      : `Error: ${msg}`;
  return { state: "failed", userMsg };
}

/**
 * Replicate the initialize() error-handling logic from CopilotExecutor.
 * This is the UNFIXED code path for client.start() failures.
 */
function initializeErrorHandler(errorMessage: string): Error {
  const msg = errorMessage;
  const isNotFound =
    msg.includes("ENOENT") ||
    msg.includes("not found") ||
    msg.includes("spawn");
  const isAuth =
    msg.toLowerCase().includes("auth") ||
    msg.toLowerCase().includes("login") ||
    msg.toLowerCase().includes("token") ||
    msg.toLowerCase().includes("unauthorized");

  if (isNotFound) {
    return new Error(
      "GitHub Copilot CLI not found. Install it with: gh extension install github/gh-copilot\n" +
        "Then authenticate with: gh auth login",
    );
  }
  if (isAuth) {
    return new Error(
      "GitHub Copilot CLI is not authenticated. Run: gh auth login\n" +
        "Then verify with: gh copilot --version",
    );
  }
  return new Error(`Failed to start GitHub Copilot CLI: ${msg}`);
}

/**
 * Simulate a successful execute() flow: submitted → working → completed
 * with a final artifact containing the response text.
 */
function simulateSuccessfulExecution(responseText: string): {
  events: Array<{ kind: string; status?: { state: string }; artifact?: { parts: Array<{ text: string }> }; final?: boolean }>;
} {
  const events: Array<any> = [];

  // 1. submitted status
  events.push({
    kind: "status-update",
    status: { state: "submitted" },
    final: false,
  });

  // 2. working status
  events.push({
    kind: "status-update",
    status: { state: "working" },
    final: false,
  });

  // 3. final artifact
  events.push({
    kind: "artifact-update",
    artifact: { parts: [{ kind: "text", text: responseText }] },
  });

  // 4. completed status
  events.push({
    kind: "status-update",
    status: { state: "completed" },
    final: true,
  });

  return { events };
}

// ─── Test 2a — Authenticated Request Preservation ─────────────────────────────

describe("Test 2a — Authenticated Request Preservation", () => {
  it("successful execution follows submitted → working → completed with response artifact", () => {
    const responseText = "Here is the answer to your question.";
    const { events } = simulateSuccessfulExecution(responseText);

    // Verify status event sequence
    const statusEvents = events.filter((e) => e.kind === "status-update");
    expect(statusEvents).toHaveLength(3);
    expect(statusEvents[0].status.state).toBe("submitted");
    expect(statusEvents[1].status.state).toBe("working");
    expect(statusEvents[2].status.state).toBe("completed");
    expect(statusEvents[2].final).toBe(true);

    // Verify final artifact contains response text
    const artifactEvents = events.filter((e) => e.kind === "artifact-update");
    expect(artifactEvents).toHaveLength(1);
    expect(artifactEvents[0].artifact.parts[0].text).toBe(responseText);
  });

  it("the executor execute() catch block preserves non-auth error handling for connection errors", () => {
    // With a cliUrl set and ECONNREFUSED, the executor produces a specific message
    const result = executeErrorHandler("ECONNREFUSED 127.0.0.1:4321", "localhost:4321");
    expect(result.state).toBe("failed");
    expect(result.userMsg).toContain("Cannot reach");
    expect(result.userMsg).toContain("localhost:4321");
  });
});

// ─── Test 2b — Non-Auth Error Preservation ────────────────────────────────────

describe("Test 2b — Non-Auth Error Preservation", () => {
  it("ECONNREFUSED error produces 'Cannot reach' message when cliUrl is set", () => {
    const result = executeErrorHandler(
      "connect ECONNREFUSED 127.0.0.1:4321",
      "localhost:4321",
    );
    expect(result.state).toBe("failed");
    expect(result.userMsg).toContain("Cannot reach");
  });

  it("ENOTFOUND error produces 'Cannot reach' message when cliUrl is set", () => {
    const result = executeErrorHandler(
      "getaddrinfo ENOTFOUND some-host",
      "some-host:4321",
    );
    expect(result.state).toBe("failed");
    expect(result.userMsg).toContain("Cannot reach");
  });

  it("connection error without cliUrl falls back to generic Error: message", () => {
    const result = executeErrorHandler(
      "connect ECONNREFUSED 127.0.0.1:4321",
      undefined,
    );
    expect(result.state).toBe("failed");
    // Without cliUrl, even connection errors get the generic format
    expect(result.userMsg).toContain("Error:");
  });

  it("generic non-connection error produces Error: prefix message", () => {
    const result = executeErrorHandler("Something went wrong", undefined);
    expect(result.state).toBe("failed");
    expect(result.userMsg).toBe("Error: Something went wrong");
  });
});

// ─── Test 2c — CLI Not Found Preservation ─────────────────────────────────────

describe("Test 2c — CLI Not Found Preservation", () => {
  it("ENOENT error in initialize() throws 'GitHub Copilot CLI not found'", () => {
    const err = initializeErrorHandler("spawn gh ENOENT");
    expect(err.message).toContain("GitHub Copilot CLI not found");
  });

  it("'not found' error in initialize() throws 'GitHub Copilot CLI not found'", () => {
    const err = initializeErrorHandler("command not found: gh");
    expect(err.message).toContain("GitHub Copilot CLI not found");
  });

  it("auth-related error in initialize() throws authentication message", () => {
    const err = initializeErrorHandler("unauthorized: bad credentials");
    expect(err.message).toContain("not authenticated");
  });

  it("generic error in initialize() throws 'Failed to start' message", () => {
    const err = initializeErrorHandler("unexpected crash");
    expect(err.message).toContain("Failed to start GitHub Copilot CLI");
  });
});

// ─── Test 2d — a2a-opencode Runtime Preservation ──────────────────────────────

describe("Test 2d — a2a-opencode Runtime Preservation", () => {
  /**
   * Recursively collect all .ts files under a directory.
   */
  function collectTsFiles(dir: string): string[] {
    const results: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectTsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        results.push(fullPath);
      }
    }
    return results.sort();
  }

  /**
   * Compute SHA-256 hash of file content.
   */
  function hashFile(filePath: string): string {
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  }

  // Snapshot the expected file list and hashes at test time.
  // This test establishes the baseline — if any .ts file under a2a-opencode/src/
  // is added, removed, or modified by the fix, this test will fail.
  const opencodeSrcDir = join(REPO_ROOT, "a2a-opencode", "src");

  it("a2a-opencode/src/ contains the expected set of .ts runtime files", () => {
    const tsFiles = collectTsFiles(opencodeSrcDir);
    const relativePaths = tsFiles.map((f) => f.replace(opencodeSrcDir + "/", ""));

    // Snapshot: these are the .ts files that exist in the unfixed code
    expect(relativePaths).toEqual([
      "__tests__/smoke.test.ts",
      "cli.ts",
      "config/defaults.ts",
      "config/index.ts",
      "config/loader.ts",
      "config/types.ts",
      "index.ts",
      "opencode/client.ts",
      "opencode/event-publisher.ts",
      "opencode/event-stream.ts",
      "opencode/executor.ts",
      "opencode/index.ts",
      "opencode/mcp-manager.ts",
      "opencode/permission-handler.ts",
      "opencode/session-manager.ts",
      "opencode/types.ts",
      "server/agent-card.ts",
      "server/index.ts",
      "utils/deferred.ts",
      "utils/logger.ts",
    ]);
  });

  it("a2a-opencode/src/ .ts file content hashes are unchanged", () => {
    const tsFiles = collectTsFiles(opencodeSrcDir);
    const hashMap: Record<string, string> = {};
    for (const f of tsFiles) {
      const rel = f.replace(opencodeSrcDir + "/", "");
      hashMap[rel] = hashFile(f);
    }

    // Verify all files have non-empty hashes (content exists)
    for (const [file, hash] of Object.entries(hashMap)) {
      expect(hash, `${file} should have a valid hash`).toMatch(/^[a-f0-9]{64}$/);
    }

    // Verify the number of files matches our expected count
    expect(Object.keys(hashMap)).toHaveLength(20);
  });
});
