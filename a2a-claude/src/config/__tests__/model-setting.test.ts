/** `claude.model`: unset / "auto" / "default" leave the SDK to apply the account default. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig } from "../loader.js";

const saved = { ...process.env };
beforeEach(() => { delete process.env["CLAUDE_MODEL"]; delete process.env["MODEL"]; delete process.env["ANTHROPIC_MODEL"]; });
afterEach(() => { process.env = { ...saved }; });

const modelOf = (model: unknown) => resolveConfig(undefined, { claude: { model } } as never).claude.model;

describe("claude model setting", () => {
  it("is unset by default", () => {
    expect(resolveConfig().claude.model).toBeUndefined();
  });
  it.each(["", "  ", "auto", "AUTO", "default"])("%j resolves to unset", (v) => {
    expect(modelOf(v)).toBeUndefined();
  });
  it("keeps an explicit model, trimmed", () => {
    expect(modelOf(" claude-sonnet-4-6 ")).toBe("claude-sonnet-4-6");
  });
});
