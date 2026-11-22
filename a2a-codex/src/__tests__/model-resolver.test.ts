/** `codex.model` resolution: explicit names pass through, `auto` picks the account's top listed model. */
import { describe, it, expect, vi } from "vitest";
import { pickModelFromCatalog, resolveCodexModel } from "../codex/model-resolver.js";

const catalog = (models: unknown[]) => JSON.stringify({ models });
const sample = catalog([
  { slug: "hidden-best", visibility: "hide", priority: 0 },
  { slug: "gpt-b", visibility: "list", priority: 2 },
  { slug: "gpt-a", visibility: "list", priority: 1 },
  { slug: "gpt-c", visibility: "list", priority: 3 },
]);

describe("pickModelFromCatalog", () => {
  it("picks the lowest-priority listed model and ignores hidden ones", () => {
    expect(pickModelFromCatalog(JSON.parse(sample))).toBe("gpt-a");
  });
  it("accepts a bare array", () => {
    expect(pickModelFromCatalog([{ slug: "x", visibility: "list", priority: 1 }])).toBe("x");
  });
  it("falls back to the best non-hidden model when nothing is marked listed", () => {
    expect(pickModelFromCatalog({ models: [{ slug: "h", visibility: "hide", priority: 1 }, { slug: "o", priority: 2 }] })).toBe("o");
  });
  it("treats a missing priority as lowest", () => {
    expect(pickModelFromCatalog({ models: [{ slug: "np", visibility: "list" }, { slug: "p", visibility: "list", priority: 9 }] })).toBe("p");
  });
  it("returns undefined for empty or malformed catalogs", () => {
    expect(pickModelFromCatalog({ models: [] })).toBeUndefined();
    expect(pickModelFromCatalog({})).toBeUndefined();
    expect(pickModelFromCatalog(null)).toBeUndefined();
    expect(pickModelFromCatalog({ models: [{ visibility: "list" }, { slug: "" }] })).toBeUndefined();
  });
});

describe("resolveCodexModel", () => {
  it("passes an explicit model through without touching the catalog", async () => {
    const runCatalog = vi.fn();
    expect(await resolveCodexModel(" gpt-9 ", {}, { runCatalog })).toBe("gpt-9");
    expect(runCatalog).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "auto", "AUTO", "default"])("auto (%j) resolves from `codex debug models`", async (v) => {
    const runCatalog = vi.fn(async () => sample);
    expect(await resolveCodexModel(v, { codexPath: "/opt/codex" }, { runCatalog })).toBe("gpt-a");
    expect(runCatalog).toHaveBeenCalledWith("/opt/codex");
  });

  it("falls back to the cache file when the command fails", async () => {
    const runCatalog = vi.fn(async () => { throw new Error("ENOENT"); });
    const readCache = vi.fn(async () => sample);
    expect(await resolveCodexModel("auto", {}, { runCatalog, readCache })).toBe("gpt-a");
    expect(readCache).toHaveBeenCalled();
  });

  it("falls back to the cache file when the command prints invalid JSON or an empty catalog", async () => {
    const readCache = async () => sample;
    expect(await resolveCodexModel("auto", {}, { runCatalog: async () => "not json", readCache })).toBe("gpt-a");
    expect(await resolveCodexModel("auto", {}, { runCatalog: async () => catalog([]), readCache })).toBe("gpt-a");
  });

  it("returns undefined (Codex chooses) when no catalog is available, and never throws", async () => {
    const fail = async () => { throw new Error("nope"); };
    expect(await resolveCodexModel("auto", {}, { runCatalog: fail, readCache: fail })).toBeUndefined();
  });
});
