# Golden fixture

`old-executor.golden.json` is what an A2A client received from a2a-copilot 1.8.2 (the `AgentExecutor` that published on an
event bus, on `integration/core-boundary-impl` at 23d46bf) for the scripted Copilot sessions in `../helpers/scenarios.ts`,
through the real SDK `DefaultRequestHandler`: for each scenario the events of `message/stream`, and the Task `message/send`
returns, as plain-data summaries (`summarizeEvent`, `summarizeTask` of `@a2a-wrapper/core`).

`../golden-parity.test.ts` replays the scenarios through `CopilotProvider` and compares. It is the parity proof of the
provider migration; the intentional differences are listed in its header and asserted there.

## Re-recording

The fixture records the OLD behaviour, so it only changes if the scenarios change. To re-record, check out the commit above,
build `packages/core` and `a2a-copilot`, and run this as a vitest test inside `a2a-copilot/src/__tests__/`:

```ts
import { it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { createTestServer, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { CopilotExecutor } from "../copilot/executor.js";
import { SCENARIOS, ScriptedSession, configFor } from "./helpers/scenarios.js";

it("records the golden fixture from the OLD executor", async () => {
  const out: Record<string, unknown> = {};
  for (const s of SCENARIOS) {
    const exec = new CopilotExecutor(configFor(s));
    vi.spyOn(exec as any, "initialize").mockResolvedValue(undefined);
    let session = new ScriptedSession(s);
    (exec as any).sessionManager = {
      getOrCreate: async () => ({ sessionId: session.sessionId, session, isNew: true }),
      trackTask() {}, untrackTask() {}, startCleanup() {}, shutdown: async () => {}, destroySession: async () => {},
    };
    (exec as any).mcpHooks = { setEmitter() {}, clearEmitter() {} };
    const server = createTestServer(exec as any);
    const streamed = await server.stream({ text: "hello", contextId: "ctx-g" });
    session = new ScriptedSession(s);
    const blocking = summarizeTask(await server.send({ text: "hello", contextId: "ctx-g2" }));
    out[s.name] = { stream: streamed.events.map(summarizeEvent), streamError: streamed.error ? String(streamed.error) : undefined, blocking };
  }
  writeFileSync(new URL("./golden/old-executor.golden.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
});
```
