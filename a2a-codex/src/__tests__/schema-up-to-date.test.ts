/**
 * Schema-up-to-date test — a2a-codex
 *
 * Regenerates the JSON schema from the TypeScript types in-memory and compares it against the committed
 * `schemas/agent-config.schema.json`. If this test fails, run `npm run schema` and commit the updated schema.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator, type Config } from "ts-json-schema-generator";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("agent-config.schema.json", () => {
  it("matches the schema generated from src/config/types.ts", () => {
    const config: Config = {
      path: join(PACKAGE_ROOT, "src/config/types.ts"),
      tsconfig: join(PACKAGE_ROOT, "tsconfig.json"),
      type: "AgentConfig",
      skipTypeCheck: true,
    };
    const fresh = createGenerator(config).createSchema(config.type);
    const committed = JSON.parse(readFileSync(join(PACKAGE_ROOT, "schemas/agent-config.schema.json"), "utf-8"));
    expect(fresh).toEqual(committed);
  });
});
