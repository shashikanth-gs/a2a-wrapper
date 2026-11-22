import { describe, expect, it } from "vitest";
import { corePartsText, fromA2AArtifact, toArtifactUpdate } from "../../index.js";

describe("CoreArtifact.extensions", () => {
  it("is rendered as the artifact's extension URIs and read back", () => {
    const update = toArtifactUpdate("t", "c", { id: "a", name: "trace.x", extensions: ["urn:x"], parts: [{ kind: "text", text: "x" }] });
    expect(update.artifact?.extensions).toEqual(["urn:x"]);
    expect(fromA2AArtifact(update.artifact!).extensions).toEqual(["urn:x"]);
  });

  it("an artifact without extensions still renders none (unchanged behaviour)", () => {
    const update = toArtifactUpdate("t", "c", { id: "a", parts: [{ kind: "text", text: "x" }] });
    expect(update.artifact?.extensions).toEqual([]);
    expect(fromA2AArtifact(update.artifact!).extensions).toBeUndefined();
  });
});

describe("corePartsText", () => {
  it("joins text parts with newlines and ignores the rest", () => {
    expect(
      corePartsText([
        { kind: "text", text: "a" },
        { kind: "data", data: { x: 1 } },
        { kind: "text", text: "b" },
        { kind: "unknown", raw: 1 },
      ]),
    ).toBe("a\nb");
    expect(corePartsText([])).toBe("");
  });
});
