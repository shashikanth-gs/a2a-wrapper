import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator, type Config } from "ts-json-schema-generator";

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

    const fresh = createGenerator(config).createSchema(config.type);
    const committed = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "schemas/agent-config.schema.json"), "utf-8"),
    );

    expect(fresh).toEqual(committed);
  });
});
