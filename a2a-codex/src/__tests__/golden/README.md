# Golden fixture

`old-executor.golden.json` is what an A2A client received from a2a-codex 1.7.2 (the `AgentExecutor` that published on an
event bus, on `integration/core-boundary-impl` at bb576d3) for the scripted Codex threads in `../helpers/scenarios.ts`,
through the real SDK `DefaultRequestHandler`: for each scenario the events of `message/stream`, and the Task `message/send`
returns, as plain-data summaries (`summarizeEvent`, `summarizeTask` of `@a2a-wrapper/core`).

`../golden-parity.test.ts` replays the scenarios through `CodexProvider` and compares. It is the parity proof of the
provider migration; the intentional differences are listed in its header and asserted there.

## Re-recording

The fixture records the OLD behaviour, so it only changes if the scenarios change. To re-record, check out the commit above,
build `packages/core` and `a2a-codex`, and run this as a vitest test inside `a2a-codex/src/__tests__/`:

```ts
import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { createTestServer, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { CodexExecutor } from "../codex/executor.js";
import { SessionManager } from "../codex/session-manager.js";
import { SCENARIOS, FakeClient, configFor } from "./helpers/scenarios.js";

it("records the golden fixture from the OLD executor", async () => {
  const out: Record<string, unknown> = {};
  for (const s of SCENARIOS) {
    const config = configFor(s);
    const exec: any = new CodexExecutor(config);
    const client = new FakeClient(s);
    exec.client = client;
    exec.sessionManager = new SessionManager(client as any, config);
    exec.initialized = true;
    const server = createTestServer(exec);
    const streamed = await server.stream({ text: "hello", contextId: "ctx-g" });
    const blocking = summarizeTask(await server.send({ text: "hello", contextId: "ctx-g2" }));
    out[s.name] = { stream: streamed.events.map(summarizeEvent), streamError: streamed.error ? String(streamed.error) : undefined, blocking };
  }
  writeFileSync(new URL("./golden/old-executor.golden.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
});
```
