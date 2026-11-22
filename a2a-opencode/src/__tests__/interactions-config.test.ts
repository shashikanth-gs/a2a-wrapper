import { afterEach, describe, expect, it } from "vitest";
import { loadEnvOverrides, resolveConfig } from "../config/loader.js";

afterEach(() => {
  delete process.env["INTERACTIONS_MODE"];
});

describe("interactions config", () => {
  it("is absent by default, which is the headless behaviour (nobody is asked)", () => {
    expect(resolveConfig().interactions).toBeUndefined();
    expect(loadEnvOverrides().interactions).toBeUndefined();
  });

  it("INTERACTIONS_MODE=ask turns asking on; auto is accepted; anything else is ignored", () => {
    process.env["INTERACTIONS_MODE"] = "ask";
    expect(resolveConfig().interactions).toEqual({ mode: "ask" });
    process.env["INTERACTIONS_MODE"] = "auto";
    expect(resolveConfig().interactions).toEqual({ mode: "auto" });
    process.env["INTERACTIONS_MODE"] = "maybe";
    expect(resolveConfig().interactions).toBeUndefined();
  });

  it("a CLI override wins over the environment and the config keeps the other fields", () => {
    process.env["INTERACTIONS_MODE"] = "auto";
    const cfg = resolveConfig(undefined, { interactions: { mode: "ask", timeoutMs: 5 } });
    expect(cfg.interactions).toEqual({ mode: "ask", timeoutMs: 5 });
  });
});
