/**
 * Schema-up-to-date test — a2a-claude
 *
 * Regenerates the JSON schema from the TypeScript types in-memory and
 * compares it against the committed `schemas/agent-config.schema.json`.
 *
 * If this test fails, the types and the committed schema have diverged.
 * Run `npm run schema` to regenerate, then commit the updated schema.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGenerator,
  type Config,
} from "ts-json-schema-generator";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "../..");

describe("agent-config.schema.json", () => {
  it("matches the schema generated from src/config/types.ts", () => {
    const config: Config = {
      path: join(PACKAGE_ROOT, "src/config/types.ts"),
      tsconfig: join(PACKAGE_ROOT, "tsconfig.json"),
      type: "AgentConfig",
      skipTypeCheck: true,
    };

    const generator = createGenerator(config);
    const fresh = generator.createSchema(config.type);

    const committed = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "schemas/agent-config.schema.json"), "utf-8"),
    );

    // Equality on the parsed JSON form ignores whitespace differences but
    // catches every semantic divergence — added/removed/renamed properties,
    // type changes, description drift.
    expect(fresh).toEqual(committed);
  });
});
