/** `opencode.model`: unset / "auto" / "default" mean the OpenCode server picks its default model. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig } from "../config/loader.js";

const saved = { ...process.env };
beforeEach(() => { delete process.env["MODEL"]; delete process.env["OPENCODE_MODEL"]; });
afterEach(() => { process.env = { ...saved }; });

const modelOf = (model: unknown) => resolveConfig(undefined, { opencode: { model } } as never).opencode.model;

describe("opencode model setting", () => {
  it("is empty by default (server default)", () => {
    expect(resolveConfig().opencode.model).toBe("");
  });
  it.each(["", "  ", "auto", "AUTO", "default"])("%j resolves to empty", (v) => {
    expect(modelOf(v)).toBe("");
  });
  it("keeps an explicit provider/model, trimmed", () => {
    expect(modelOf(" github-copilot/claude-sonnet-4.5 ")).toBe("github-copilot/claude-sonnet-4.5");
  });
});
