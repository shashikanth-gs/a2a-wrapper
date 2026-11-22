/** `copilot.model`: "auto" (the default) lets Copilot choose; explicit names pass through. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig } from "../config/loader.js";
import { DEFAULTS } from "../config/defaults.js";

const saved = { ...process.env };
beforeEach(() => { delete process.env["COPILOT_MODEL"]; });
afterEach(() => { process.env = { ...saved }; });

const modelOf = (model: unknown, extra: Record<string, unknown> = {}) =>
  resolveConfig(undefined, { copilot: { model, ...extra } } as never).copilot.model;

describe("copilot model setting", () => {
  it("defaults to auto, not a pinned model name", () => {
    expect(DEFAULTS.copilot.model).toBe("auto");
    expect(resolveConfig().copilot.model).toBe("auto");
  });
  it.each(["", "  ", "auto", "AUTO", "default", "Default"])("%j resolves to the literal auto", (v) => {
    expect(modelOf(v)).toBe("auto");
  });
  it("keeps an explicit model, trimmed", () => {
    expect(modelOf(" gpt-4.1 ")).toBe("gpt-4.1");
    expect(modelOf("claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
  });
  it("COPILOT_MODEL overrides the default", () => {
    process.env["COPILOT_MODEL"] = "gpt-5.2";
    expect(resolveConfig().copilot.model).toBe("gpt-5.2");
  });
  it("a custom (BYOK) provider cannot resolve auto, so the model stays unset for validation to report", () => {
    const provider = { type: "openai", baseUrl: "http://localhost:11434/v1" };
    expect(modelOf("auto", { provider })).toBeUndefined();
    expect(modelOf("llama3", { provider })).toBe("llama3");
  });
});
