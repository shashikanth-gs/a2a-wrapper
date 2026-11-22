/**
 * Context binding end to end through the real SDK `DefaultRequestHandler` (1.3): two requests on one contextId across a
 * simulated restart, per-caller scoping (spec 13.1) and `session-not-found` recovery. A restart is a NEW registry, bus
 * manager, executor and handler over the SAME `RunStore` and task store: nothing in memory survives but what core persisted.
 */

import { describe, it, expect } from "vitest";
import { TaskState } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore, ServerCallContext } from "@a2a-js/sdk/server";
import {
  CoreExecutor,
  InMemoryRunStore,
  OrphanGuardTaskStore,
  RunEventBusManager,
  RunRegistry,
  SESSION_NOT_FOUND,
  type CoreRequest,
  type CoreTaskRun,
} from "../../index.js";
import { makeProvider } from "../runtime/harness.js";

const agentCard: any = { name: "t", description: "t", capabilities: { streaming: true }, defaultInputModes: [], defaultOutputModes: [], skills: [] };
const as = (userName?: string) =>
  new ServerCallContext(userName ? { user: { isAuthenticated: true, userName } as never } : {});

function message(contextId: string, taskId = "", text = "hello") {
  return {
    messageId: `m-${Math.random()}`,
    contextId,
    taskId,
    role: 1,
    parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  } as any;
}

type RunFn = (req: CoreRequest, view: CoreTaskRun, seen: CoreRequest[]) => Promise<void>;

/** One "process": a fresh provider, registry, bus manager and handler over the given stores. */
function boot(runStore: InMemoryRunStore, taskStore: InMemoryTaskStore, run: RunFn) {
  const seen: CoreRequest[] = [];
  const provider = makeProvider({
    run: async (req, view) => {
      seen.push(req);
      await run(req, view, seen);
    },
  });
  const registry = new RunRegistry({ provider, store: runStore });
  const handler = new DefaultRequestHandler(
    agentCard,
    new OrphanGuardTaskStore(taskStore, registry),
    new CoreExecutor(registry) as any,
    new RunEventBusManager(registry),
  );
  const send = (m: any, ctx = as()) => handler.sendMessage({ tenant: "", message: m, configuration: undefined, metadata: undefined } as any, ctx) as Promise<any>;
  return { provider, registry, handler, seen, send };
}

describe("context binding through DefaultRequestHandler", () => {
  it("two requests on one contextId across a restart: the second provider run gets request.session from the first's bind", async () => {
    const runStore = new InMemoryRunStore();
    const taskStore = new InMemoryTaskStore();

    const before = boot(runStore, taskStore, async (req, view) => {
      view.bind({ ref: "thread-A", meta: { cwd: "/work" } });
      view.complete({ text: "first answer" });
    });
    const t1 = await before.send(message("ctx-1"));
    expect(t1.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(before.seen[0].session).toBeUndefined();
    await before.registry.drain();
    await before.registry.shutdown();

    // restart
    const after = boot(runStore, taskStore, async (_req, view) => {
      view.complete({ text: "second answer" });
    });
    const t2 = await after.send(message("ctx-1", "", "follow up"));
    expect(t2.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(t2.id).not.toBe(t1.id); // a new task in the same context
    expect(after.seen).toHaveLength(1);
    expect(after.seen[0].contextId).toBe("ctx-1");
    expect(after.seen[0].session).toEqual({ ref: "thread-A", meta: { cwd: "/work" } });

    // a different context is a different conversation
    const t3 = await after.send(message("ctx-2"));
    expect(t3.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(after.seen[1].session).toBeUndefined();
  });

  it("per-caller scoping over the wire: bob sending alice's contextId gets a rejected task and alice's session is never handed to him", async () => {
    const runStore = new InMemoryRunStore();
    const taskStore = new InMemoryTaskStore();
    const p = boot(runStore, taskStore, async (_req, view) => {
      view.bind({ ref: "alice-thread" });
      view.complete({ text: "hi alice" });
    });
    expect((await p.send(message("alice-ctx"), as("alice"))).status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    await p.registry.drain();

    const bob = await p.send(message("alice-ctx", "", "let me in"), as("bob"));
    expect(bob.status.state).toBe(TaskState.TASK_STATE_REJECTED);
    expect(p.seen).toHaveLength(1); // the provider only ever ran alice's turn
    expect(JSON.stringify(bob)).not.toContain("alice-thread");

    // alice still resumes it, after a restart too
    const restarted = boot(runStore, taskStore, async (_req, view) => view.complete({ text: "welcome back" }));
    expect((await restarted.send(message("alice-ctx"), as("alice"))).status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(restarted.seen[0].session?.ref).toBe("alice-thread");
  });

  it("a session the backend no longer knows: core forgets it and retries the same turn once with no session, so the caller just gets an answer", async () => {
    const runStore = new InMemoryRunStore();
    const taskStore = new InMemoryTaskStore();
    const first = boot(runStore, taskStore, async (_req, view) => {
      view.bind({ ref: "dead-thread" });
      view.complete({ text: "ok" });
    });
    await first.send(message("ctx-x"));
    await first.registry.drain();

    const second = boot(runStore, taskStore, async (req, view) => {
      if (req.session) return void view.fail({ code: SESSION_NOT_FOUND, message: "no such thread" });
      view.bind({ ref: "new-thread" });
      view.complete({ text: "fresh start" });
    });
    const t = await second.send(message("ctx-x", "", "again"));
    expect(t.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(second.seen.map((r) => r.session?.ref)).toEqual(["dead-thread", undefined]);
    expect(second.seen[1].turnId).toBe(second.seen[0].turnId);
    await second.registry.drain();
    expect((await runStore.getBinding("ctx-x"))?.session?.ref).toBe("new-thread");
  });

  it("session-not-found twice in a row fails the task instead of looping", async () => {
    const runStore = new InMemoryRunStore();
    const taskStore = new InMemoryTaskStore();
    const first = boot(runStore, taskStore, async (_req, view) => {
      view.bind({ ref: "dead-thread" });
      view.complete({});
    });
    await first.send(message("ctx-y"));
    await first.registry.drain();

    const second = boot(runStore, taskStore, async (_req, view) => void view.fail({ code: SESSION_NOT_FOUND, message: "nope" }));
    const t = await second.send(message("ctx-y"));
    expect(t.status.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(second.seen).toHaveLength(2);
  });

  it("a cancel of a task whose provider discards its session clears the binding (full path through tasks/cancel)", async () => {
    const runStore = new InMemoryRunStore();
    const taskStore = new InMemoryTaskStore();
    const seen: CoreRequest[] = [];
    let view!: CoreTaskRun;
    const provider = makeProvider({
      run: (req, v) => {
        seen.push(req);
        view = v;
        v.bind({ ref: "to-discard" });
        return new Promise<void>(() => {});
      },
      abort: async () => ({ stopped: "confirmed", session: "discard" }),
    });
    const registry = new RunRegistry({ provider, store: runStore });
    const handler = new DefaultRequestHandler(
      agentCard,
      new OrphanGuardTaskStore(taskStore, registry),
      new CoreExecutor(registry) as any,
      new RunEventBusManager(registry),
    );
    void (handler.sendMessage({ tenant: "", message: message("ctx-c"), configuration: undefined, metadata: undefined } as any, as()) as Promise<any>).catch(() => {});
    for (let i = 0; i < 100 && !view; i++) await new Promise((r) => setTimeout(r, 1));
    await registry.drain();
    expect((await runStore.getBinding("ctx-c"))?.session?.ref).toBe("to-discard");

    const task = await handler.cancelTask({ tenant: "", id: seen[0].taskId, metadata: undefined } as any, as());
    expect(task.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    await registry.drain();
    expect(await runStore.getBinding("ctx-c")).toBeUndefined();
    expect(provider.release).toHaveBeenCalledWith({ ref: "to-discard" });
  });
});
