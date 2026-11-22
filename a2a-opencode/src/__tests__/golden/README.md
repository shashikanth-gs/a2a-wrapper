# Golden fixture

`old-executor.golden.json` is what an A2A client received from a2a-opencode 1.7.2 (the `AgentExecutor` that published on an
event bus, on `integration/core-boundary-impl` at 0d58392) for the scripted OpenCode sessions in `../helpers/scenarios.ts`,
through the real SDK `DefaultRequestHandler`: for each scenario the events of `message/stream`, the Task `message/send`
returns, and the prompt parts the executor sent to the server, as plain-data summaries (`summarizeEvent`, `summarizeTask` of
`@a2a-wrapper/core`). The scenarios cover buffered and chunked responses, intermediate text flushed as status before a tool,
tool traces (success, error, parallel, sensitive and oversized data), usage (repeated message updates, incomplete and user
messages, no cost, no usage), session errors, failing prompts, the transcript fallback, a prompt timeout, disabled events and the
system prompt of the first message. The events are the canonical (1.x-shaped) ones both server generations produce.

`../golden-parity.test.ts` replays the scenarios through `OpenCodeProvider` (on a 1.x and on a 2.x fake server) and compares.
It is the parity proof of the provider migration; the intentional differences are listed in its header and applied to the
recording there.

## Re-recording

The fixture records the OLD behaviour, so it only changes if the scenarios change. To re-record, check out the commit above, build
`packages/core` and `a2a-opencode`, and run this as a vitest test inside `a2a-opencode/src/__tests__/`:

```ts
import { it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { createTestServer, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { FakeBackend } from "./helpers/fake-backend.js";
import { SCENARIOS, configFor } from "./helpers/scenarios.js";
import { OpenCodeExecutor } from "../opencode/executor.js";

const holder: { backend?: FakeBackend } = {};
vi.mock("../opencode/backend-factory.js", () => ({ createBackend: async () => holder.backend }));

it("records the golden fixture from the OLD executor", async () => {
  const out: Record<string, unknown> = {};
  for (const s of SCENARIOS) {
    const mk = () => {
      holder.backend = new FakeBackend({ kind: "v1", scripts: [s.script], ...(s.failPrompt ? { failPrompt: s.failPrompt } : {}), ...(s.messages ? { messages: s.messages } : {}) });
      return { server: createTestServer(new OpenCodeExecutor(configFor(s)) as any), backend: holder.backend };
    };
    const a = mk();
    const streamed = await a.server.stream({ text: "hello", contextId: "ctx-g" });
    const prompts = a.backend.prompts.map((p) => p.body.parts);
    const b = mk();
    const blocking = summarizeTask(await b.server.send({ text: "hello", contextId: "ctx-g2" }));
    out[s.name] = { stream: streamed.events.map(summarizeEvent), streamError: streamed.error ? String(streamed.error) : undefined, blocking, prompts };
  }
  writeFileSync(new URL("./golden/old-executor.golden.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
}, 120_000);
```
