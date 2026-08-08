import { describe, it, expect } from "vitest";
import type { Message } from "@a2a-js/sdk";
import { extractUserText } from "../../events/part-utils.js";

function message(parts: Message["parts"]): Message {
  return {
    messageId: "m1",
    contextId: "c1",
    taskId: "t1",
    role: 1,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

describe("extractUserText", () => {
  it("extracts a single text part", () => {
    const msg = message([{ content: { $case: "text", value: "hello" }, metadata: undefined }]);
    expect(extractUserText(msg)).toBe("hello");
  });

  it("joins multiple text parts with newlines", () => {
    const msg = message([
      { content: { $case: "text", value: "line1" }, metadata: undefined },
      { content: { $case: "text", value: "line2" }, metadata: undefined },
    ]);
    expect(extractUserText(msg)).toBe("line1\nline2");
  });

  it("ignores raw parts", () => {
    const msg = message([{ content: { $case: "raw", value: Buffer.from("x") }, metadata: undefined }]);
    expect(extractUserText(msg)).toBe("");
  });

  it("ignores url parts", () => {
    const msg = message([{ content: { $case: "url", value: "https://example.com/f" }, metadata: undefined }]);
    expect(extractUserText(msg)).toBe("");
  });

  it("ignores data parts", () => {
    const msg = message([{ content: { $case: "data", value: { a: 1 } }, metadata: undefined }]);
    expect(extractUserText(msg)).toBe("");
  });

  it("ignores parts with no content", () => {
    const msg = message([{ content: undefined, metadata: undefined }]);
    expect(extractUserText(msg)).toBe("");
  });

  it("mixed parts: only text parts are joined, in order", () => {
    const msg = message([
      { content: { $case: "data", value: { a: 1 } }, metadata: undefined },
      { content: { $case: "text", value: "first" }, metadata: undefined },
      { content: { $case: "url", value: "https://x" }, metadata: undefined },
      { content: { $case: "text", value: "second" }, metadata: undefined },
    ]);
    expect(extractUserText(msg)).toBe("first\nsecond");
  });

  it("returns empty string for a message with no parts", () => {
    expect(extractUserText(message([]))).toBe("");
  });
});
