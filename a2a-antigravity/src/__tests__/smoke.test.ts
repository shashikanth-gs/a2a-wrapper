import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../config/defaults.js";
import { parseBridgeMessage } from "../antigravity/bridge-protocol.js";

describe("DEFAULTS", () => {
  it("uses the expected A2A protocol version", () => {
    expect(DEFAULTS.agentCard.protocolVersion).toBe("0.3.0");
  });

  it("defaults to port 3030", () => {
    expect(DEFAULTS.server.port).toBe(3030);
  });

  it("uses SDK-default auth by default", () => {
    expect(DEFAULTS.antigravity.provider?.authMode).toBe("sdkDefault");
  });

  it("buffers artifact chunks by default", () => {
    expect(DEFAULTS.features.streamArtifactChunks).toBe(false);
  });
});

describe("parseBridgeMessage", () => {
  it("parses valid JSONL bridge messages", () => {
    expect(parseBridgeMessage('{"kind":"ack","requestId":"1","ok":true}')).toEqual({
      kind: "ack",
      requestId: "1",
      ok: true,
    });
  });

  it("rejects malformed JSON", () => {
    expect(() => parseBridgeMessage("{bad")).toThrow(/BRIDGE_PROTOCOL_ERROR/);
  });
});
