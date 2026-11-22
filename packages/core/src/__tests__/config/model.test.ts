/** Shared `model` setting semantics: unset / "" / auto / default mean "provider chooses". */
import { describe, it, expect } from "vitest";
import { AUTO_MODEL, isAutoModel, normalizeModel } from "../../index.js";

describe("isAutoModel", () => {
  it.each([undefined, null, "", "   ", "auto", "AUTO", " Auto ", "default", "Default"])(
    "treats %j as auto",
    (v) => expect(isAutoModel(v)).toBe(true),
  );
  it.each(["gpt-5", "claude-sonnet-4.6", "github-copilot/claude-sonnet-4.5", "autopilot", "defaults"])(
    "treats %j as an explicit model",
    (v) => expect(isAutoModel(v)).toBe(false),
  );
  it("treats a non-string value as auto instead of throwing", () => {
    expect(isAutoModel(42)).toBe(true);
    expect(isAutoModel({})).toBe(true);
  });
});

describe("normalizeModel", () => {
  it("returns undefined when the provider should choose", () => {
    for (const v of [undefined, null, "", "auto", "default", "  "]) expect(normalizeModel(v)).toBeUndefined();
  });
  it("returns the trimmed explicit name otherwise", () => {
    expect(normalizeModel("  gpt-5  ")).toBe("gpt-5");
    expect(normalizeModel("opencode/big-pickle")).toBe("opencode/big-pickle");
  });
  it("exports the canonical spelling", () => {
    expect(AUTO_MODEL).toBe("auto");
  });
});
