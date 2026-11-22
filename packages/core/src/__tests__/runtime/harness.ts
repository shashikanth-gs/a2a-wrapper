/** Shared fakes for the run runtime tests. */

import { vi } from "vitest";
import {
  ANONYMOUS_CALLER,
  type AbortOutcome,
  type CoreRequest,
  type CoreTaskRun,
  type ProviderExecutor,
} from "../../index.js";
import type { ExecuteInit, RunPublisher } from "../../index.js";

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export interface FakePublisher extends RunPublisher {
  calls: Array<{ k: "status" | "event" | "artifact" | "finished"; v?: any }>;
  statuses(): any[];
  terminal(): any[];
}

export function makePublisher(): FakePublisher {
  const calls: FakePublisher["calls"] = [];
  const pub: FakePublisher = {
    calls,
    status: vi.fn((v) => void calls.push({ k: "status", v })),
    event: vi.fn((v) => void calls.push({ k: "event", v })),
    artifact: vi.fn((v) => void calls.push({ k: "artifact", v })),
    finished: vi.fn(() => void calls.push({ k: "finished" })),
    statuses: () => calls.filter((c) => c.k === "status").map((c) => c.v),
    terminal: () =>
      calls
        .filter((c) => c.k === "status" && ["completed", "failed", "canceled", "rejected"].includes(c.v.state))
        .map((c) => c.v),
  };
  return pub;
}

export interface RunCall {
  req: CoreRequest;
  view: CoreTaskRun;
  /** Settle the provider.run promise of this call. */
  resolve(): void;
  reject(e: Error): void;
}

export interface FakeProvider extends ProviderExecutor {
  runs: RunCall[];
  abort: ReturnType<typeof vi.fn>;
  abortOrphan: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

/** A provider whose run() stays pending until the test settles it. */
export function makeProvider(
  opts: {
    abort?: (...a: any[]) => Promise<AbortOutcome>;
    abortOrphan?: (...a: any[]) => Promise<AbortOutcome>;
    run?: (req: CoreRequest, view: CoreTaskRun) => Promise<void>;
  } = {},
): FakeProvider {
  const runs: RunCall[] = [];
  const p = {
    runs,
    info: () => ({ id: "fake", displayName: "Fake", version: "1", inputModes: ["text/plain"], outputModes: ["text/plain"] }),
    initialize: async () => {},
    shutdown: async () => {},
    run: vi.fn((req: CoreRequest, view: CoreTaskRun) => {
      if (opts.run) return opts.run(req, view);
      return new Promise<void>((resolve, reject) => {
        runs.push({ req, view, resolve, reject });
      });
    }),
    abort: vi.fn(opts.abort ?? (async () => ({ stopped: "confirmed", session: "reusable" }) as AbortOutcome)),
    abortOrphan: vi.fn(opts.abortOrphan ?? (async () => ({ stopped: "confirmed", session: "reusable" }) as AbortOutcome)),
    release: vi.fn(async () => {}),
  };
  return p as unknown as FakeProvider;
}

export function makeInit(
  taskId: string,
  contextId = "ctx",
  publisher: RunPublisher = makePublisher(),
  extra: Partial<ExecuteInit> = {},
): ExecuteInit {
  return {
    taskId,
    contextId,
    caller: { ...ANONYMOUS_CALLER },
    publisher,
    request: (ids) => ({
      ...ids,
      taskId,
      contextId,
      input: [{ kind: "text", text: "hi" }],
      history: [],
      caller: { ...ANONYMOUS_CALLER },
      correlation: { eventId: "e", metadata: {} },
      extensions: new Map(),
    }),
    ...extra,
  };
}
