import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenCodeClientWrapper, OpenCodeVersionError } from "../opencode/client.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** Emulates OpenCode 2.x: only /api/info answers JSON (401 when a password is set), everything else is the SPA HTML fallback. */
async function startV2Server(requireAuth = false): Promise<string> {
  server = createServer((req, res) => {
    if (req.url === "/api/info") {
      res.setHeader("content-type", "application/json");
      if (requireAuth) { res.statusCode = 401; res.end(JSON.stringify({ error: "unauthorized" })); return; }
      res.end(JSON.stringify({ version: "2.0.31" }));
    } else {
      res.setHeader("content-type", "text/html");
      res.end("<html></html>");
    }
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("OpenCode 2.x detection", () => {
  it("throws a clear OpenCodeVersionError against a V2-only server", async () => {
    const client = new OpenCodeClientWrapper({ baseUrl: await startV2Server(), healthCheckInterval: 0 });
    await expect(client.health()).rejects.toBeInstanceOf(OpenCodeVersionError);
    await expect(client.health()).rejects.toThrow(/2\.0\.31/);
  });

  it("detects a password-protected V2 server (401 JSON on /api/info)", async () => {
    const client = new OpenCodeClientWrapper({ baseUrl: await startV2Server(true), healthCheckInterval: 0 });
    await expect(client.health()).rejects.toBeInstanceOf(OpenCodeVersionError);
  });
});
