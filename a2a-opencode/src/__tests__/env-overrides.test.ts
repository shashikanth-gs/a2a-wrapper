import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnvOverrides } from "../config/loader.js";

const KEYS = [
  "MODEL", "OPENCODE_MODEL", "DIRECTORY", "WORKSPACE_DIR", "OPENCODE_URL", "OPENCODE_AGENT",
  "OPENCODE_API_VERSION", "OPENCODE_SERVER_PASSWORD",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadEnvOverrides (opencode)", () => {
  it("reads MODEL", () => {
    process.env["MODEL"] = "anthropic/claude-sonnet-4";
    expect(loadEnvOverrides().opencode?.model).toBe("anthropic/claude-sonnet-4");
  });

  it("accepts OPENCODE_MODEL as an alias (as documented in .env.example)", () => {
    process.env["OPENCODE_MODEL"] = "github-copilot/gpt-4o";
    expect(loadEnvOverrides().opencode?.model).toBe("github-copilot/gpt-4o");
  });

  it("prefers MODEL when both are set", () => {
    process.env["MODEL"] = "a/one";
    process.env["OPENCODE_MODEL"] = "b/two";
    expect(loadEnvOverrides().opencode?.model).toBe("a/one");
  });

  it("reads DIRECTORY but deliberately ignores WORKSPACE_DIR (that is a server.sh/start.sh variable)", () => {
    process.env["WORKSPACE_DIR"] = "/should/not/leak";
    expect(loadEnvOverrides().opencode).toBeUndefined();
    process.env["DIRECTORY"] = "/srv/proj";
    expect(loadEnvOverrides().opencode?.projectDirectory).toBe("/srv/proj");
  });

  it("reads the OpenCode 2.x connection variables and validates apiVersion", () => {
    process.env["OPENCODE_API_VERSION"] = "2";
    process.env["OPENCODE_SERVER_PASSWORD"] = "pw";
    expect(loadEnvOverrides().opencode).toMatchObject({ apiVersion: "2", password: "pw" });
    process.env["OPENCODE_API_VERSION"] = "bogus";
    expect(loadEnvOverrides().opencode?.apiVersion).toBeUndefined();
  });
});
