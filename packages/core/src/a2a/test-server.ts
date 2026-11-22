/**
 * @module a2a/test-server
 *
 * A test harness for wrappers: serve an executor through the REAL SDK `DefaultRequestHandler` (in-memory task store) and
 * look at what an A2A client receives, without the wrapper's tests importing `@a2a-js/sdk`. Only core may depend on the
 * SDK (design doc: core-owned A2A boundary), so a wrapper that implements `ProviderExecutor` tests its provider
 * end to end through {@link createProviderTestServer} and reads the result through the plain-data summaries below.
 *
 * Not for production code. It lives in the main entry point so wrapper tests can import it from `@a2a-wrapper/core`.
 */

import { TaskState } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import { DELIVERY_META_KEY } from "./adapter.js";
import type { ProviderExecutor } from "../model/index.js";
import { InMemoryRunStore, type RunStore } from "../runtime/run-store.js";
import { RunRegistry, type RunRegistryOptions } from "../runtime/run-registry.js";
import type { A2AExecutor } from "../executor/types.js";
import { CoreExecutor } from "./core-executor.js";
import { RunEventBusManager } from "./bus-manager.js";
import { OrphanGuardTaskStore } from "./orphan-task-store.js";
import { createStorePublisherFactory } from "./store-publisher.js";

/** A message a test client sends. */
export interface TestMessageInit {
  text?: string;
  /** Message parts as the SDK models them (overrides `text`). */
  parts?: unknown[];
  contextId?: string;
  taskId?: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
  /** `queue`, `steer` or `interrupt`: sets the delivery metadata of the message (design doc 3.4). */
  delivery?: string;
}

/** What a stream delivered: the raw SDK events and how the stream ended. */
export interface StreamResult {
  events: any[];
  error?: unknown;
}

/** A running stream: `events` fills as they arrive, `done` settles when the stream ends. */
export interface LiveStream {
  readonly events: any[];
  readonly done: Promise<StreamResult>;
}

export interface TestServer {
  readonly handler: DefaultRequestHandler;
  readonly taskStore: InMemoryTaskStore;
  /** Blocking `message/send`: the Task or Message the SDK returns. */
  send(init: TestMessageInit): Promise<any>;
  /** `message/stream`, started and not awaited. */
  startStream(init: TestMessageInit): LiveStream;
  /** `message/stream` run to its end. */
  stream(init: TestMessageInit): Promise<StreamResult>;
  /** `tasks/cancel`. */
  cancel(taskId: string): Promise<any>;
  /** The stored task (what `tasks/get` returns), or `undefined`. */
  getTask(taskId: string): Promise<any | undefined>;
}

export interface TestServerOptions {
  /** Share a task store between two servers to simulate a restart. */
  taskStore?: InMemoryTaskStore;
  /** Owner of the call: an authenticated user name; absent is anonymous. */
  user?: string;
  /** The run registry, to install the core event bus manager and orphan guard (what `createA2AServer({ runRegistry })` does). */
  registry?: RunRegistry;
}

const agentCard: any = {
  name: "test-agent",
  description: "test",
  capabilities: { streaming: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [],
};

let seq = 0;

/** Build the SDK message for a test client. */
export function testMessage(init: TestMessageInit): any {
  const metadata = { ...(init.metadata ?? {}), ...(init.delivery ? { [DELIVERY_META_KEY]: init.delivery } : {}) };
  return {
    messageId: init.messageId ?? `test-msg-${++seq}`,
    contextId: init.contextId ?? "test-ctx",
    taskId: init.taskId ?? "",
    role: 1,
    parts:
      init.parts ??
      (init.text === undefined || init.text === ""
        ? []
        : [{ content: { $case: "text", value: init.text }, metadata: undefined, filename: "", mediaType: "text/plain" }]),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** Serve any executor (an `A2AExecutor`, in particular a `CoreExecutor`) through the real request handler. */
export function createTestServer(executor: A2AExecutor, options: TestServerOptions = {}): TestServer {
  const taskStore = options.taskStore ?? new InMemoryTaskStore();
  const registry = options.registry;
  const store = registry ? new OrphanGuardTaskStore(taskStore, registry) : taskStore;
  registry?.setDetachedPublisher(createStorePublisherFactory(taskStore));
  const handler = new DefaultRequestHandler(
    agentCard,
    store,
    executor as any,
    registry ? new RunEventBusManager(registry) : undefined,
  );
  const ctx = () => new ServerCallContext(options.user ? { user: { isAuthenticated: true, userName: options.user } as never } : {});
  const params = (init: TestMessageInit) => ({ tenant: "", message: testMessage(init), configuration: undefined, metadata: undefined }) as any;

  const startStream = (init: TestMessageInit): LiveStream => {
    const events: any[] = [];
    const done = (async (): Promise<StreamResult> => {
      try {
        for await (const e of handler.sendMessageStream(params(init), ctx())) events.push(e);
        return { events };
      } catch (error) {
        return { events, error };
      }
    })();
    return { events, done };
  };

  return {
    handler,
    taskStore,
    send: (init) => handler.sendMessage(params(init), ctx()) as Promise<any>,
    startStream,
    stream: (init) => startStream(init).done,
    cancel: (taskId) => handler.cancelTask({ tenant: "", id: taskId } as any, ctx()) as Promise<any>,
    getTask: async (taskId) => (await taskStore.load(taskId, ctx())) ?? undefined,
  };
}

/** What {@link createProviderTestServer} adds: the run runtime it built. */
export interface ProviderTestServer extends TestServer {
  readonly registry: RunRegistry;
  readonly runStore: RunStore;
  readonly provider: ProviderExecutor;
}

/**
 * Serve a provider the way `createProviderServer` does (run runtime, core executor, core bus manager, orphan guard),
 * without HTTP. Pass `runStore` and `taskStore` of an earlier server to simulate a process restart over the same stores.
 */
export function createProviderTestServer(
  provider: ProviderExecutor,
  options: TestServerOptions & { registry?: Omit<RunRegistryOptions, "provider"> } = {},
): ProviderTestServer {
  const { registry: registryOptions, ...rest } = options as TestServerOptions & { registry?: Omit<RunRegistryOptions, "provider"> };
  const runStore = registryOptions?.store ?? new InMemoryRunStore();
  const registry = new RunRegistry({ ...(registryOptions ?? {}), provider, store: runStore });
  const server = createTestServer(new CoreExecutor(registry), { ...rest, registry });
  return Object.assign(server, { registry, runStore, provider });
}

// ─── Plain-data summaries ───────────────────────────────────────────────────

/** `TASK_STATE_INPUT_REQUIRED` as `input-required`. */
export function stateName(state: number | string | undefined): string {
  if (state === undefined) return "";
  const name = typeof state === "number" ? (TaskState[state] ?? String(state)) : state;
  return name.replace(/^TASK_STATE_/, "").toLowerCase().replace(/_/g, "-");
}

const partSummary = (p: any): { text?: string; data?: unknown; mimeType?: string } => {
  const c = p?.content;
  if (c?.$case === "text") return { text: c.value };
  if (c?.$case === "data") return { data: c.value, ...(p.metadata?.mimeType ? { mimeType: p.metadata.mimeType } : {}) };
  return {};
};

const keysOf = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o as object).sort() : []);

/** One stream event or the Task / Message a blocking call returned, as plain data a golden file can hold. */
export type EventSummary =
  | { k: "task"; state: string }
  | { k: "message"; text: string; metaKeys: string[] }
  | { k: "status"; state: string; text?: string; metaKeys: string[]; messageMetaKeys?: string[]; usage?: unknown }
  | {
      k: "artifact";
      name: string;
      append: boolean;
      lastChunk: boolean;
      parts: Array<{ text?: string; data?: unknown; mimeType?: string }>;
      extensions: string[];
      metaKeys: string[];
      /** Artifact metadata when the artifact is a trace (`traceType`), without the volatile timestamp and ids. */
      traceType?: string;
    };

/**
 * Summarize one event of `message/stream` (the SDK's `{payload: {$case, value}}` envelope) or one event published on an
 * `ExecutionEventBus` (`{kind, data}`, what a bus-based executor publishes), so the two can be compared.
 */
export function summarizeEvent(e: any): EventSummary {
  const p = e?.payload ?? (e?.kind ? { $case: e.kind, value: e.data } : undefined);
  switch (p?.$case) {
    case "task":
      return { k: "task", state: stateName(p.value.status?.state) };
    case "message":
      return { k: "message", text: (p.value.parts ?? []).map((x: any) => partSummary(x).text ?? "").join(""), metaKeys: keysOf(p.value.metadata) };
    case "statusUpdate": {
      const v = p.value;
      const msg = v.status?.message;
      const text = msg ? (msg.parts ?? []).map((x: any) => partSummary(x).text ?? "").join("") : undefined;
      const metadata = v.metadata ?? undefined;
      return {
        k: "status",
        state: stateName(v.status?.state),
        ...(text ? { text } : {}),
        metaKeys: keysOf(metadata),
        ...(msg?.metadata ? { messageMetaKeys: keysOf(msg.metadata) } : {}),
        ...(metadata && "x-usage" in metadata ? { usage: metadata["x-usage"] } : {}),
      };
    }
    case "artifactUpdate": {
      const v = p.value;
      const a = v.artifact ?? {};
      return {
        k: "artifact",
        name: a.name ?? "",
        append: !!v.append,
        lastChunk: !!v.lastChunk,
        parts: (a.parts ?? []).map(partSummary),
        extensions: [...(a.extensions ?? [])],
        metaKeys: keysOf(a.metadata),
        ...(a.metadata?.traceType ? { traceType: a.metadata.traceType } : {}),
      };
    }
    default:
      return { k: "task", state: "?" };
  }
}

/** A stored or returned Task as plain data: state, the status message text, and the artifacts it holds. */
export function summarizeTask(task: any): {
  state: string;
  text?: string;
  artifacts: Array<{ name: string; text: string; parts: number }>;
  metaKeys: string[];
} {
  const msg = task?.status?.message;
  const text = msg ? (msg.parts ?? []).map((x: any) => partSummary(x).text ?? "").join("") : undefined;
  return {
    state: stateName(task?.status?.state),
    ...(text ? { text } : {}),
    artifacts: (task?.artifacts ?? []).map((a: any) => ({
      name: a.name ?? "",
      text: (a.parts ?? []).map((x: any) => partSummary(x).text ?? "").join(""),
      parts: (a.parts ?? []).length,
    })),
    metaKeys: keysOf(task?.metadata),
  };
}
