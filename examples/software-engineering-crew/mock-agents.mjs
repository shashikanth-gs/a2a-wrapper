/**
 * Stand-in A2A agents so `planner.mjs --mock` runs with no API keys.
 * They implement just enough of A2A (agent card + JSON-RPC message/send)
 * to exercise the planner. Not a substitute for the real wrappers.
 */
import http from "node:http";

const DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? 0); // simulate model thinking time

function makeAgent(name, reply, port = 0) {
  let base = "";
  const server = http.createServer((req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      return json(200, { name, protocolVersion: "0.3.0", url: `${base}/a2a/jsonrpc` });
    }
    if (req.method === "POST" && req.url === "/a2a/jsonrpc") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const { id, params } = JSON.parse(raw);
        const prompt = params.message.parts.map((p) => p.text).join("");
        setTimeout(() => json(200, {
          jsonrpc: "2.0",
          id,
          result: {
            kind: "task",
            id: "mock-task",
            contextId: params.message.contextId,
            status: { state: "completed" },
            artifacts: [{ artifactId: "a1", parts: [{ kind: "text", text: reply(prompt) }] }],
          },
        }), DELAY_MS);
      });
      return;
    }
    json(404, { error: "not found" });
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ url: base, close: () => new Promise((r) => server.close(r)) });
    }),
  );
}

export async function startMockAgents({ fixedPorts = false } = {}) {
  const impl = await makeAgent("Mock Implementer", () => "Added src/slugify.js exporting slugify(text). (mock output)", fixedPorts ? 3030 : 0);
  const tester = await makeAgent("Mock Tester", (p) => `Wrote test/slugify.test.js and all tests pass. Saw implementer summary: ${p.includes("slugify") ? "yes" : "no"}. (mock output)`, fixedPorts ? 3020 : 0);
  return {
    implementerUrl: impl.url,
    testerUrl: tester.url,
    stop: async () => { await impl.close(); await tester.close(); },
  };
}

// `node mock-agents.mjs` runs them as standalone servers on the real example
// ports (3030 implementer, 3020 tester) so you can point the planner at them.
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { implementerUrl, testerUrl } = await startMockAgents({ fixedPorts: true });
  console.log(`mock implementer listening on ${implementerUrl}`);
  console.log(`mock tester      listening on ${testerUrl}`);
}
