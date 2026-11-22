/** `antigravity.model`: unset / "auto" / "default" leave the SDK to choose its default model. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig } from "../config/loader.js";

const saved = { ...process.env };
beforeEach(() => { delete process.env["ANTIGRAVITY_MODEL"]; delete process.env["GEMINI_MODEL"]; });
afterEach(() => { process.env = { ...saved }; });

const modelOf = (model: unknown) => resolveConfig(undefined, { antigravity: { model } } as never).antigravity.model;

describe("antigravity model setting", () => {
  it("is unset by default", () => {
    expect(resolveConfig().antigravity.model).toBeUndefined();
  });
  it.each(["", "  ", "auto", "AUTO", "default"])("%j resolves to unset", (v) => {
    expect(modelOf(v)).toBeUndefined();
  });
  it("keeps an explicit model, trimmed", () => {
    expect(modelOf(" gemini-3-pro ")).toBe("gemini-3-pro");
  });
});
