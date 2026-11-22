/**
 * Config schema validation tests — a2a-opencode
 *
 * Verifies that the generated JSON schema (`schemas/agent-config.schema.json`)
 * accepts the bundled example configs and rejects shapes the type system
 * already forbids. This catches drift between the TypeScript types, the
 * generated schema, and the example configs we ship.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "../..");

let validate: ValidateFunction;

function loadJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, relativePath), "utf-8"));
}

function stripComments<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(stripComments) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "$comment" || k === "$schema") continue;
      out[k] = stripComments(v);
    }
    return out as T;
  }
  return value;
}

beforeAll(() => {
  const schema = loadJson("schemas/agent-config.schema.json");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  validate = ajv.compile(schema as object);
});

describe("AgentConfig JSON schema", () => {
  it("accepts the example agent config", () => {
    const cfg = stripComments(loadJson("agents/example/config.json"));
    const ok = validate(cfg);
    expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
    expect(ok).toBe(true);
  });

  it("accepts the multi-agent (subAgents) example config", () => {
    const cfg = stripComments(loadJson("agents/multi-agent/config.json"));
    const ok = validate(cfg);
    expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
    expect(ok).toBe(true);
  });

  it("rejects a config missing the required agentCard.name", () => {
    const cfg = { agentCard: { description: "no name" } };
    const ok = validate(cfg);
    expect(ok).toBe(false);
    expect(validate.errors).toBeDefined();
  });

  it.each(["auto", "1", "2"])("accepts opencode.apiVersion %s", (apiVersion) => {
    const cfg = { agentCard: { name: "Test", description: "x" }, opencode: { apiVersion, password: "pw", username: "opencode" } };
    expect(validate(cfg), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects an invalid opencode.apiVersion", () => {
    const cfg = { agentCard: { name: "Test", description: "x" }, opencode: { apiVersion: "3" } };
    expect(validate(cfg)).toBe(false);
  });

  it("accepts the interaction policy, the idle and maximum session age and the steer window", () => {
    const cfg = {
      agentCard: { name: "Test", description: "x" },
      interactions: { mode: "ask", timeoutMs: 60000, onTimeout: "deny", autoAnswer: [{ match: { tool: "read" }, answer: { kind: "allow_once" } }] },
      session: { ttl: 600000, maxAge: 3600000, cleanupInterval: 60000 },
      timeouts: { steerAck: 2000 },
    };
    expect(validate(cfg), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects an invalid interactions.mode", () => {
    expect(validate({ agentCard: { name: "Test", description: "x" }, interactions: { mode: "maybe" } })).toBe(false);
  });

  it("rejects an unknown top-level field", () => {
    const cfg = {
      agentCard: { name: "Test", description: "x" },
      bogusField: 42,
    };
    const ok = validate(cfg);
    expect(ok).toBe(false);
  });
});
