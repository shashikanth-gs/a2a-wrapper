# Golden fixture

`old-executor.golden.json` is what an A2A client received from a2a-claude 0.4.1 (the `AgentExecutor` that published on an
event bus, on `integration/core-boundary-impl` at 4041054) for the scripted Claude sessions in `../helpers/scenarios.ts`,
through the real SDK `DefaultRequestHandler`: for each scenario the events of `message/stream`, and the Task `message/send`
returns, as plain-data summaries (`summarizeEvent`, `summarizeTask` of `@a2a-wrapper/core`). The scenarios cover buffered and
chunked responses, every trace event kind (thinking, tool calls, MCP, sub-agent delegation, file changes, todos, permission
denials), structured output, error results, a model refusal, background-task rounds (held-open tasks), the three ways a held task
ends, rate limits (rejected, in flight, warning, assistant error), prompt timeout, a failing iterator, and no usage in a result.

`../golden-parity.test.ts` replays the scenarios through `ClaudeProvider` and compares. It is the parity proof of the provider
migration; the intentional differences are listed in its header and applied to the recording there.

## Re-recording

The fixture records the OLD behaviour, so it only changes if the scenarios change. To re-record, check out the commit above,
build `packages/core` and `a2a-claude`, and run this as a vitest test inside `a2a-claude/src/__tests__/`:

```ts
import { it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestServer, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { ClaudeExecutor } from "../claude/executor.js";
import { FakeClaudeClient } from "./helpers/fake-client.js";
import { SCENARIOS, configFor } from "./helpers/scenarios.js";

it("records the golden fixture from the OLD executor", async () => {
  const ws = mkdtempSync(join(tmpdir(), "a2a-claude-golden-"));
  const out: Record<string, unknown> = {};
  for (const s of SCENARIOS) {
    const server1 = createTestServer(new ClaudeExecutor(configFor(s, ws), () => new FakeClaudeClient([s.script])) as any);
    const streamed = await server1.stream({ text: "hello", contextId: "ctx-g" });
    const server2 = createTestServer(new ClaudeExecutor(configFor(s, ws), () => new FakeClaudeClient([s.script])) as any);
    const blocking = summarizeTask(await server2.send({ text: "hello", contextId: "ctx-g2" }));
    out[s.name] = { stream: streamed.events.map(summarizeEvent), streamError: streamed.error ? String(streamed.error) : undefined, blocking };
  }
  writeFileSync(new URL("./golden/old-executor.golden.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
  rmSync(ws, { recursive: true, force: true });
}, 120_000);
```
