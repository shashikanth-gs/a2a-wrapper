/**
 * Live contract test. It runs only when OPENCODE_TEST_URL points at a running
 * OpenCode server (1.x or 2.x), for example:
 *
 *   OPENCODE_TEST_URL=http://127.0.0.1:4096 npx vitest run live-server
 *   OPENCODE_TEST_URL=http://127.0.0.1:4300 OPENCODE_SERVER_PASSWORD=... npx vitest run live-server
 *
 * Set OPENCODE_TEST_MODEL (for example "opencode/big-pickle") to also run a
 * real prompt. OPENCODE_TEST_DIR selects the project directory.
 */
import { describe, it, expect } from "vitest";
import { createBackend } from "../opencode/backend-factory.js";

const url = process.env["OPENCODE_TEST_URL"];
const model = process.env["OPENCODE_TEST_MODEL"];
const dir = process.env["OPENCODE_TEST_DIR"] || process.cwd();
const password = process.env["OPENCODE_SERVER_PASSWORD"];

describe.skipIf(!url)("live OpenCode server", () => {
  it("connects, creates a session and lists agents", async () => {
    const backend = await createBackend({ baseUrl: url!, password, healthCheckInterval: 0 });
    const h = await backend.health();
    expect(h.healthy).toBe(true);
    const s = await backend.sessionCreate(dir, { title: "live-contract-test" });
    expect(s.id).toBeTruthy();
    expect(await backend.sessionIdle(s.id, dir)).toBe(true);
    expect(await backend.agentList(dir)).toBeTruthy();
  });

  it.skipIf(!model)(
    "completes a prompt and normalizes the transcript",
    async () => {
      const backend = await createBackend({ baseUrl: url!, password, healthCheckInterval: 0 });
      const [providerID, ...rest] = model!.split("/");
      const m = { providerID, modelID: rest.join("/") };
      const s = await backend.sessionCreate(dir, { title: "live-contract-prompt", model: m });
      const handle = await backend.subscribeEvents(dir);
      let idle = false;
      const reader = (async () => {
        for await (const e of handle.stream as AsyncGenerator<any>) {
          if (e?.type === "session.idle" && e.properties?.sessionID === s.id) {
            idle = true;
            break;
          }
        }
      })();
      await backend.sessionPromptAsync(s.id, { parts: [{ type: "text", text: "Reply with exactly: pong" }], model: m });
      await Promise.race([reader, new Promise((r) => setTimeout(r, 90_000))]);
      handle.abort();
      expect(idle).toBe(true);
      const msgs = await backend.sessionMessages(s.id, dir);
      const last = [...msgs].reverse().find((x) => (x.info as any).role === "assistant");
      expect(last?.parts.some((p: any) => p.type === "text" && /pong/i.test(p.text))).toBe(true);
    },
    120_000,
  );
});
