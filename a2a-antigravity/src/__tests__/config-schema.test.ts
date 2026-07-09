import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

function stripSchema<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(stripSchema) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$schema" || key === "$comment") continue;
      out[key] = stripSchema(nested);
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
  it("accepts the example config", () => {
    const cfg = stripSchema(loadJson("agents/example/config.json"));
    const ok = validate(cfg);
    expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
    expect(ok).toBe(true);
  });

  it("rejects unknown top-level fields", () => {
    const ok = validate({
      agentCard: { name: "Test", description: "x" },
      unknown: true,
    });
    expect(ok).toBe(false);
  });
});
