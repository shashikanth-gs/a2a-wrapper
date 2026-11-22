/** Shared fakes for the run runtime tests. */

import { vi } from "vitest";
import {
  ANONYMOUS_CALLER,
  type AbortOutcome,
  type CoreRequest,
  type CoreMessage,
  type CoreTaskRun,
  type ProviderExecutor,
  type SteerOutcome,
} from "../../index.js";
import type { ExecuteInit, RunPublisher } from "../../index.js";

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export interface FakePublisher extends RunPublisher {
  calls: Array<{ k: "status" | "event" | "artifact" | "finished" | "interaction"; v?: any }>;
  statuses(): any[];
  terminal(): any[];
}

export function makePublisher(): FakePublisher {
  const calls: FakePublisher["calls"] = [];
  const pub: FakePublisher = {
    calls,
    status: vi.fn((v) => void calls.push({ k: "status", v })),
    interaction: vi.fn((interaction, options) => void calls.push({ k: "interaction", v: { interaction, options } })),
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
  /** Present only when the provider was made with a `steer` handler. */
  steer: ReturnType<typeof vi.fn>;
}

/** A provider whose run() stays pending until the test settles it. */
export function makeProvider(
  opts: {
    abort?: (...a: any[]) => Promise<AbortOutcome>;
    abortOrphan?: (...a: any[]) => Promise<AbortOutcome>;
    run?: (req: CoreRequest, view: CoreTaskRun) => Promise<void>;
    /** Give the provider a `steer` handler. Absent: the provider has none (core's fallback applies). */
    steer?: (view: CoreTaskRun, message: CoreMessage) => Promise<SteerOutcome> | SteerOutcome;
    /** Make a provider with NO `abort` handler. */
    noAbort?: boolean;
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
  if (opts.noAbort) delete (p as { abort?: unknown }).abort;
  if (opts.steer) (p as { steer?: unknown }).steer = vi.fn(async (view: CoreTaskRun, m: CoreMessage) => opts.steer!(view, m));
  return p as unknown as FakeProvider;
}

let messageSeq = 0;

/** A core message for a task that is already running. */
export function makeMessage(
  delivery?: string,
  text: string | undefined = "next",
  over: Partial<CoreMessage> = {},
): CoreMessage {
  return {
    id: `msg-${++messageSeq}`,
    role: "user",
    parts: text === undefined ? [] : [{ kind: "text", text }],
    from: ANONYMOUS_CALLER,
    ...(delivery ? { delivery } : {}),
    at: "t",
    ...over,
  };
}

/** The request builder a queued message's turn uses: input is the message's own text. */
export function requestFor(taskId: string, message: CoreMessage, contextId = "ctx") {
  return (ids: { runId: string; turnId: string; session?: { ref: string } }): CoreRequest => ({
    ...ids,
    taskId,
    contextId,
    input: message.parts,
    history: [],
    caller: { ...ANONYMOUS_CALLER },
    correlation: { eventId: "e", metadata: {} },
    extensions: new Map(),
  });
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

let replySeq = 0;

/** A reply to a parked task, as the A2A layer hands it to the registry. */
export function makeReply(
  taskId: string,
  parts: ExecuteInit["message"] extends infer M ? (M extends { parts: infer P } ? P : never) : never,
  publisher: RunPublisher = makePublisher(),
  caller: ExecuteInit["caller"] = { ...ANONYMOUS_CALLER },
): ExecuteInit {
  return makeInit(taskId, "ctx", publisher, {
    caller,
    message: { id: `reply-${++replySeq}`, role: "user", parts, from: caller, at: "t" },
  });
}

/** The interaction last published on a fake publisher. */
export function lastInteraction(pub: FakePublisher): any {
  const all = pub.calls.filter((c) => c.k === "interaction");
  return all[all.length - 1]?.v.interaction;
}
