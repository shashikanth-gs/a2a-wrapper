import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";

import { probeSubAgents } from "../../sub-agents/probe.js";
import type { SubAgentConfig } from "../../sub-agents/types.js";

/**
 * Unit tests for the sub-agents reachability probe.
 *
 * Validates Requirements 6.1–6.5 by exercising
 * {@link probeSubAgents} against a freshly spun-up `http.createServer`
 * for each scenario: 2xx, non-2xx, connection refusal, timeout, and
 * concurrent execution.
 *
 * Each test creates and tears down its own server(s) via a small
 * helper that tracks open sockets so `server.close()` resolves
 * promptly even when a probe deliberately hangs.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * A test fixture wrapping an http.Server bound to an OS-assigned
 * port. The fixture exposes the resolved URL the probe should hit
 * and a `close` method that destroys any lingering sockets so the
 * timeout-style tests do not stall teardown.
 */
interface ServerFixture {
  url: string;
  port: number;
  close: () => Promise<void>;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<ServerFixture> {
  const server = http.createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Reserve a TCP port and immediately release it so the assigned
 * number can be used for a "nothing listens here" connection-refusal
 * test. The kernel may eventually re-assign this port, but for the
 * lifetime of a single test that race is vanishingly rare on
 * loopback.
 */
async function reserveUnusedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const sock = net.createServer();
    sock.unref();
    sock.listen(0, "127.0.0.1", () => {
      const port = (sock.address() as AddressInfo).port;
      sock.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function makeAgent(
  url: string,
  overrides: Partial<SubAgentConfig> = {},
): SubAgentConfig {
  return {
    name: overrides.name ?? "probe-target",
    agentCardUrl: url,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("probeSubAgents — success path", () => {
  let fixture: ServerFixture;

  beforeEach(async () => {
    fixture = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name: "ok" }));
    });
  });

  afterEach(async () => {
    await fixture.close();
  });

  // Requirement 6.1, 6.2: 2xx response yields ok:true with status 200 and a
  // measured duration.
  it("returns ok:true with status 200 and a recorded duration on a 2xx response", async () => {
    const agent = makeAgent(fixture.url, { name: "alpha" });

    const [result] = await probeSubAgents([agent], 5000);

    expect(result.name).toBe("alpha");
    expect(result.url).toBe(fixture.url);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBeUndefined();
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.durationMs)).toBe(true);
  });

  it("uses endpointUrlOverride as the probed URL when set", async () => {
    const agent = makeAgent("http://placeholder.invalid/", {
      name: "with-override",
      endpointUrlOverride: fixture.url,
    });

    const [result] = await probeSubAgents([agent], 5000);

    expect(result.ok).toBe(true);
    expect(result.url).toBe(fixture.url);
    expect(result.status).toBe(200);
  });
});

describe("probeSubAgents — non-2xx responses", () => {
  // Requirement 6.3: non-2xx returns ok:false but preserves status.
  it.each([
    ["404 Not Found", 404],
    ["500 Internal Server Error", 500],
    ["401 Unauthorized", 401],
    ["503 Service Unavailable", 503],
  ])("returns ok:false with status %s preserved", async (_label, statusCode) => {
    const fixture = await startServer((_req, res) => {
      res.statusCode = statusCode;
      res.end();
    });

    try {
      const agent = makeAgent(fixture.url, { name: "non-2xx" });
      const [result] = await probeSubAgents([agent], 5000);

      expect(result.ok).toBe(false);
      expect(result.status).toBe(statusCode);
      expect(typeof result.error).toBe("string");
      expect(result.error).toContain(String(statusCode));
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await fixture.close();
    }
  });

  it("treats a 3xx redirect as non-2xx because redirect: 'manual' is set", async () => {
    const fixture = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "/elsewhere");
      res.end();
    });

    try {
      const agent = makeAgent(fixture.url);
      const [result] = await probeSubAgents([agent], 5000);

      expect(result.ok).toBe(false);
      expect(result.status).toBe(302);
    } finally {
      await fixture.close();
    }
  });
});

describe("probeSubAgents — connection refusal", () => {
  // Requirement 6.4: network errors surface as ok:false with an error string,
  // and no status is recorded because the response head never arrived.
  it("returns ok:false with an error message when nothing listens on the target port", async () => {
    const port = await reserveUnusedPort();
    const url = `http://127.0.0.1:${port}/`;
    const agent = makeAgent(url, { name: "refused" });

    const [result] = await probeSubAgents([agent], 5000);

    expect(result.ok).toBe(false);
    expect(result.url).toBe(url);
    expect(result.status).toBeUndefined();
    expect(typeof result.error).toBe("string");
    expect(result.error).not.toBe("");
    // Don't pin to a specific phrase — undici's wording varies across
    // Node versions. A non-empty string is the contract.
  });
});

describe("probeSubAgents — timeout", () => {
  // Requirement 6.4, 6.5: a server that never responds must abort cleanly
  // and produce an error mentioning "timeout" (or "abort").
  it("returns ok:false with an error containing 'timeout' or 'abort' when the server hangs past timeoutMs", async () => {
    // Server accepts the request but never writes a response head.
    const fixture = await startServer((_req, _res) => {
      // Intentionally do not call res.end() — the request will hang.
    });

    try {
      const agent = makeAgent(fixture.url, { name: "slow" });
      const start = Date.now();
      const [result] = await probeSubAgents([agent], 100);
      const elapsed = Date.now() - start;

      expect(result.ok).toBe(false);
      expect(result.status).toBeUndefined();
      expect(typeof result.error).toBe("string");
      // Accept "timeout", "timed out", or "abort" — undici and the
      // probe's own normalization use slightly different wording.
      expect(result.error!.toLowerCase()).toMatch(/timeout|timed out|abort/);
      // The probe should fire abort close to the configured timeout, not
      // hang on the server's open socket. Allow generous slack for CI.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      await fixture.close();
    }
  });
});

describe("probeSubAgents — parallel execution", () => {
  // Requirement 6.5: probes run concurrently. Asserted on the peak number of
  // requests in flight at the same time, not on wall-clock time, so a slow CI
  // runner cannot make it flaky (sequential probing peaks at 1).
  it("runs probes concurrently — all 3 slow agents are in flight at the same time", async () => {
    let inFlight = 0;
    let peak = 0;
    const makeSlowServer = () =>
      startServer((_req, res) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          res.statusCode = 200;
          res.end();
        }, 100);
      });

    const fixtures = await Promise.all([
      makeSlowServer(),
      makeSlowServer(),
      makeSlowServer(),
    ]);

    try {
      const agents: SubAgentConfig[] = fixtures.map((f, i) =>
        makeAgent(f.url, { name: `parallel-${i}` }),
      );

      const results = await probeSubAgents(agents, 5000);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
      }
      // Sequential probing would never have more than one request in flight.
      expect(peak).toBe(3);
    } finally {
      await Promise.all(fixtures.map((f) => f.close()));
    }
  });

  it("preserves input order in the result array", async () => {
    const fixture = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end();
    });

    try {
      const agents: SubAgentConfig[] = [
        makeAgent(fixture.url, { name: "first" }),
        makeAgent(fixture.url, { name: "second" }),
        makeAgent(fixture.url, { name: "third" }),
      ];

      const results = await probeSubAgents(agents, 5000);

      expect(results.map((r) => r.name)).toEqual(["first", "second", "third"]);
    } finally {
      await fixture.close();
    }
  });
});
