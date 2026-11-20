import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { detectServerVersion, createBackend } from "../opencode/backend-factory.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const json: (res: any, status: number, body: unknown) => void = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};
const html = (res: any) => {
  res.setHeader("content-type", "text/html");
  res.end("<html></html>");
};

describe("detectServerVersion", () => {
  it("detects 2.x from a JSON /api/info", async () => {
    const url = await start((_q, res) => json(res, 200, { version: "2.3.2" }));
    expect(await detectServerVersion(url)).toMatchObject({ kind: "v2", version: "2.3.2" });
  });
  it("detects a password-protected 2.x (401 JSON)", async () => {
    const url = await start((_q, res) => json(res, 401, { error: "unauthorized" }));
    expect(await detectServerVersion(url)).toMatchObject({ kind: "v2" });
  });
  it("sends Basic auth when a password is given", async () => {
    let seen = "";
    const url = await start((req, res) => {
      seen = String(req.headers.authorization);
      json(res, 200, { version: "2.3.2" });
    });
    await detectServerVersion(url, { password: "pw" });
    expect(seen).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"));
  });
  it("treats an HTML /api/info as 1.x", async () => {
    const url = await start((_q, res) => html(res));
    expect(await detectServerVersion(url)).toMatchObject({ kind: "v1" });
  });
  it("assumes 1.x when the server is unreachable", async () => {
    expect(await detectServerVersion("http://127.0.0.1:1")).toMatchObject({ kind: "v1" });
  });
});

describe("createBackend", () => {
  it("honours an explicit apiVersion without probing", async () => {
    expect((await createBackend({ baseUrl: "http://127.0.0.1:1", apiVersion: "2", healthCheckInterval: 0 })).kind).toBe("v2");
    expect((await createBackend({ baseUrl: "http://127.0.0.1:1", apiVersion: "1", healthCheckInterval: 0 })).kind).toBe("v1");
  });
  it("auto-selects the V2 client for a 2.x server", async () => {
    const url = await start((_q, res) => json(res, 200, { version: "2.3.2" }));
    expect((await createBackend({ baseUrl: url, healthCheckInterval: 0 })).kind).toBe("v2");
  });
  it("auto-selects the V1 client for a 1.x server", async () => {
    const url = await start((_q, res) => html(res));
    expect((await createBackend({ baseUrl: url, healthCheckInterval: 0 })).kind).toBe("v1");
  });
});
