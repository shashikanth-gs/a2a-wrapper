/** `codex.model` defaults to auto (resolved from the account catalog at startup, see model-resolver). */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig } from "../config/loader.js";
import { DEFAULTS } from "../config/defaults.js";

const saved = { ...process.env };
beforeEach(() => { delete process.env["CODEX_MODEL"]; delete process.env["MODEL"]; });
afterEach(() => { process.env = { ...saved }; });

describe("codex model setting", () => {
  it("defaults to auto, not a pinned model name", () => {
    expect(DEFAULTS.codex.model).toBe("auto");
    expect(resolveConfig().codex.model).toBe("auto");
  });
  it("an explicit model overrides the default", () => {
    expect(resolveConfig(undefined, { codex: { model: "gpt-6.2-sol" } } as never).codex.model).toBe("gpt-6.2-sol");
  });
  it("an unresolved ${VAR} in the config clears the model (treated as auto by the resolver)", () => {
    delete process.env["NOT_SET_MODEL"];
    expect(resolveConfig(undefined, { codex: { model: "${NOT_SET_MODEL}" } } as never).codex.model).toBeUndefined();
  });
});
