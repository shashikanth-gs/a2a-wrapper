/**
 * The interactions runtime (#108) through the real RunRegistry: a fake ProviderExecutor drives
 * `run.ask`, replies arrive as second `execute()` calls on the same task (what the SDK does).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ANONYMOUS_CALLER,
  InMemoryRunStore,
  RunRegistry,
  isApproval,
  newRecordHeader,
  replyCodeFor,
  type CoreInteractionRequest,
  type CoreInteractionResult,
  type InteractionPolicy,
  type RunRecord,
} from "../../index.js";
import { lastInteraction, makeInit, makePublisher, makeProvider, makeReply, tick, type FakeProvider, type FakePublisher } from "./harness.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  if (!cond()) throw new Error("timed out");
}

interface Setup {
  provider: FakeProvider;
  store: InMemoryRunStore;
  registry: RunRegistry;
  warn: ReturnType<typeof vi.fn>;
}

function setup(policy: Partial<InteractionPolicy> = { mode: "ask" }, extra: Partial<ConstructorParameters<typeof RunRegistry>[0]> = {}): Setup {
  const provider = makeProvider();
  const store = new InMemoryRunStore();
  const warn = vi.fn();
  const registry = new RunRegistry({ provider, store, interactionPolicy: policy, logger: { warn }, ...extra });
  return { provider, store, registry, warn };
}

/** Start a run and park it on its first ask. */
async function parkOn(s: Setup, request: CoreInteractionRequest, taskId = "t1") {
  const pub = makePublisher();
  const done = s.registry.execute(makeInit(taskId, "ctx", pub));
  await until(() => s.provider.runs.some((r) => r.req.taskId === taskId));
  const call = s.provider.runs.find((r) => r.req.taskId === taskId)!;
  const answer = call.view.ask(request);
  return { pub, done, call, answer };
}

const permission = (extra: Partial<Extract<CoreInteractionRequest, { kind: "permission" }>> = {}): CoreInteractionRequest => ({
  kind: "permission",
  title: "Run npm test?",
  subject: { tool: "bash", command: "npm test", risk: "low" },
  options: [
    { id: "once", label: "Allow once", kind: "allow_once" },
    { id: "always", label: "Always allow", kind: "allow_always", scope: "project" },
    { id: "no", label: "Reject", kind: "reject_once", allowsFeedback: true },
    { id: "stop", label: "Reject and stop", kind: "reject_once", interrupts: true },
  ],
  ...extra,
});

const reply = (pub: FakePublisher, data: Record<string, unknown>) => [{ kind: "data" as const, data: { interactionId: lastInteraction(pub).id, ...data } }];
const text = (t: string) => [{ kind: "text" as const, text: t }];

describe("run.ask: parking, ids and publication", () => {
  it("assigns id, seq and replyCode, publishes input-required through the publisher and parks the run", async () => {
    const s = setup();
    const { pub, done, answer, call } = await parkOn(s, permission());
    expect(await done).toBe("parked");
    const i = lastInteraction(pub);
    expect(i.kind).toBe("permission");
    expect(i.id).toEqual(expect.any(String));
    expect(i.replyCode).toBe(replyCodeFor(i.id, 1));
    expect(i.expiresAt).toEqual(expect.any(String));
    expect(pub.terminal()).toHaveLength(0);
    // the run record reads input-required, so a restart sweep recognises it as interrupted
    await s.registry.drain();
    expect((await s.store.getRun("t1"))?.state).toBe("input-required");
    // the record of the interaction
    const [rec] = await s.store.listPending("t1");
    expect(rec).toMatchObject({ taskId: "t1", contextId: "ctx", runId: call.req.runId, seq: 1, state: "presented", owner: { id: "anonymous" } });
    expect(rec.interaction.id).toBe(i.id);
    void answer;
  });

  it("an auth interaction publishes through the same call (the adapter picks auth-required)", async () => {
    const s = setup();
    const { pub } = await parkOn(s, { kind: "auth", title: "Sign in", auth: { service: "github", url: "https://x" } });
    expect(lastInteraction(pub).kind).toBe("auth");
    await s.registry.drain();
    expect((await s.store.getRun("t1"))?.state).toBe("auth-required");
  });

  it("an invalid request is answered unavailable and never parks", async () => {
    const s = setup();
    const { pub, answer, done } = await parkOn(s, { kind: "permission", title: "x", options: [] } as any);
    expect(await answer).toMatchObject({ outcome: "unavailable", reason: expect.stringContaining("at least one option") });
    expect(pub.calls.some((c) => c.k === "interaction")).toBe(false);
    s.provider.runs[0].view.complete({ text: "ok" });
    expect(await done).toBe("ended");
  });
});

describe("every kind, answered by a reply", () => {
  type Case = { name: string; request: CoreInteractionRequest; data: (id: string) => Record<string, unknown>; expected: Partial<CoreInteractionResult> };
  const cases: Case[] = [
    { name: "permission allow_once", request: permission(), data: () => ({ optionId: "once" }), expected: { outcome: "selected", optionId: "once" } },
    { name: "permission allow_always", request: permission(), data: () => ({ optionId: "always" }), expected: { outcome: "selected", optionId: "always" } },
    { name: "permission reject", request: permission(), data: () => ({ optionId: "no" }), expected: { outcome: "selected", optionId: "no" } },
    {
      name: "permission reject with feedback",
      request: permission(),
      data: () => ({ optionId: "no", feedback: "use pnpm" }),
      expected: { outcome: "selected", optionId: "no", feedback: "use pnpm" },
    },
    {
      name: "confirm (default options)",
      request: { kind: "confirm", title: "Proceed?" },
      data: () => ({ optionId: "allow" }),
      expected: { outcome: "selected", optionId: "allow" },
    },
    {
      name: "question, single choice",
      request: { kind: "question", title: "Pick", questions: [{ id: "q", prompt: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] },
      data: () => ({ answers: { q: { optionIds: ["b"] } } }),
      expected: { outcome: "answered", answers: { q: { optionIds: ["b"] } } },
    },
    {
      name: "question, multi choice",
      request: { kind: "question", title: "Pick", questions: [{ id: "q", prompt: "Which?", multi: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] },
      data: () => ({ answers: { q: { optionIds: ["a", "b"] } } }),
      expected: { outcome: "answered", answers: { q: { optionIds: ["a", "b"] } } },
    },
    {
      name: "question, free form",
      request: { kind: "question", title: "Name", questions: [{ id: "n", prompt: "Your name?" }] },
      data: () => ({ answers: { n: { text: "Ada" } } }),
      expected: { outcome: "answered", answers: { n: { text: "Ada" } } },
    },
    {
      name: "form",
      request: { kind: "form", title: "Deploy", schema: { properties: { env: { type: "string", enum: ["dev", "prod"] }, dry: { type: "boolean" } }, required: ["env"] } },
      data: () => ({ values: { env: "dev", dry: true } }),
      expected: { outcome: "submitted", values: { env: "dev", dry: true } },
    },
    {
      name: "auth, finished out of band",
      request: { kind: "auth", title: "Sign in", auth: { service: "github" } },
      data: () => ({ completed: true }),
      expected: { outcome: "completed" },
    },
    { name: "declined", request: permission(), data: () => ({ declined: true, feedback: "no" }), expected: { outcome: "declined", feedback: "no" } },
    { name: "dismissed", request: { kind: "confirm", title: "?" }, data: () => ({ dismissed: true }), expected: { outcome: "dismissed" } },
  ];

  for (const c of cases) {
    it(`${c.name}: the parked ask resolves, the SAME provider.run continues, one provider call`, async () => {
      const s = setup();
      const { pub, done, answer, call } = await parkOn(s, c.request);
      expect(await done).toBe("parked");
      const replyPub = makePublisher();
      const replied = s.registry.execute(makeReply("t1", reply(pub, c.data("")), replyPub));
      const result = await answer;
      expect(result).toMatchObject({ ...c.expected, by: ANONYMOUS_CALLER });
      expect(s.provider.run).toHaveBeenCalledTimes(1);
      // the reply's stream saw the task go back to working
      expect(replyPub.statuses().map((x) => x.state)).toEqual(["working"]);
      call.view.complete({ text: "done" });
      expect(await replied).toBe("ended");
      expect(replyPub.terminal().map((x) => x.state)).toEqual(["completed"]);
      await s.registry.drain();
      expect((await s.store.listPending("t1"))[0].state).toBe("answered");
    });
  }

  it("by records the CoreCaller that answered", async () => {
    const s = setup();
    const { pub, answer } = await parkOn(s, permission());
    const alice = { id: "alice", kind: "user" } as const;
    void s.registry.execute(makeReply("t1", reply(pub, { optionId: "once" }), makePublisher(), alice));
    expect(await answer).toMatchObject({ outcome: "selected", by: alice });
  });
});

describe("text replies and the reply code", () => {
  it("approving by text needs the presented interaction's code", async () => {
    const s = setup();
    const { pub, answer } = await parkOn(s, permission());
    const code = lastInteraction(pub).replyCode as string;

    const noCode = makePublisher();
    expect(await s.registry.execute(makeReply("t1", text("1"), noCode))).toBe("parked");
    expect(noCode.calls.find((c) => c.k === "interaction")?.v.options?.hint).toMatch(/could not be matched/);

    const wrong = makePublisher();
    await s.registry.execute(makeReply("t1", text("1 ZZZZ"), wrong));
    expect(wrong.calls.some((c) => c.k === "interaction")).toBe(true);

    let settled = false;
    void answer.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false); // still parked: nothing approved

    void s.registry.execute(makeReply("t1", text(`1 ${code}`), makePublisher()));
    expect(await answer).toMatchObject({ outcome: "selected", optionId: "once" });
  });

  it("a stale approval code from an earlier interaction cannot approve the next one", async () => {
    const s = setup();
    const { pub, call, answer } = await parkOn(s, permission());
    const first = lastInteraction(pub);
    const second = call.view.ask(permission({ title: "Second?" }));
    const rp = makePublisher();
    void s.registry.execute(makeReply("t1", text(`1 ${first.replyCode}`), rp));
    await answer;
    await tick();
    const next = lastInteraction(rp); // the next one is presented on the reply's own stream
    expect(next.id).not.toBe(first.id);
    expect(next.replyCode).not.toBe(first.replyCode);
    // the old code again, now aimed at the second interaction
    const stale = makePublisher();
    await s.registry.execute(makeReply("t1", text(`1 ${first.replyCode}`), stale));
    expect(stale.calls.find((c) => c.k === "interaction")?.v.options?.hint).toMatch(/could not be matched/); // re-prompt, not an approval
    let settled = false;
    void second.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
  });

  it("a text reject needs no code", async () => {
    const s = setup();
    const { answer } = await parkOn(s, permission());
    void s.registry.execute(makeReply("t1", text("no"), makePublisher()));
    expect(await answer).toMatchObject({ outcome: "selected", optionId: "no" });
  });

  it("a structured reply wins over the text beside it", async () => {
    const s = setup();
    const { pub, answer } = await parkOn(s, permission());
    void s.registry.execute(makeReply("t1", [...text("no"), ...reply(pub, { optionId: "once" })], makePublisher()));
    expect(await answer).toMatchObject({ outcome: "selected", optionId: "once" });
  });
});

describe("replies that are not answers (D5: unknown never approves)", () => {
  it("an unknown option id, an unknown outcome shape and a malformed payload are ignored with a re-prompt", async () => {
    const s = setup();
    const { pub, answer, done } = await parkOn(s, permission());
    await done;
    let settled = false;
    void answer.then(() => (settled = true));
    for (const data of [{ optionId: "nope" }, { approved: true }, { optionId: 7 }, {}]) {
      const p = makePublisher();
      expect(await s.registry.execute(makeReply("t1", reply(pub, data), p))).toBe("parked");
      expect(p.calls.filter((c) => c.k === "interaction")).toHaveLength(1);
    }
    await tick();
    expect(settled).toBe(false);
  });

  it("a structured reply for another interaction id is ignored", async () => {
    const s = setup();
    const { answer } = await parkOn(s, permission());
    const p = makePublisher();
    await s.registry.execute(makeReply("t1", [{ kind: "data", data: { interactionId: "some-other", optionId: "once" } }], p));
    expect(p.calls.some((c) => c.k === "interaction")).toBe(true);
    let settled = false;
    void answer.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
  });

  it("isApproval: only an explicit selected on an allow_* option approves", () => {
    const i = { options: [{ id: "a", label: "A", kind: "allow_once" }, { id: "x", label: "X", kind: "allow_everything" }] };
    expect(isApproval(i, { outcome: "selected", optionId: "a" } as any)).toBe(true);
    for (const r of [
      { outcome: "selected", optionId: "x" },
      { outcome: "selected", optionId: "zz" },
      { outcome: "weird" },
      { outcome: "expired" },
      { outcome: "unavailable", reason: "r" },
      { outcome: "withdrawn" },
      { outcome: "canceled" },
      { outcome: "declined" },
      { outcome: "completed" },
      null,
    ])
      expect(isApproval(i, r as any)).toBe(false);
  });

  it("an interaction of an unknown kind is only answered by selecting one of its options", async () => {
    const s = setup();
    const { pub, answer } = await parkOn(s, { kind: "teleport", title: "Beam up?", options: [{ id: "go", label: "Go", kind: "allow_once" }] } as any);
    const p = makePublisher();
    await s.registry.execute(makeReply("t1", text("yes"), p));
    expect(p.calls.some((c) => c.k === "interaction")).toBe(true);
    void s.registry.execute(makeReply("t1", reply(pub, { optionId: "go" }), makePublisher()));
    expect(await answer).toMatchObject({ outcome: "selected", optionId: "go" });
  });

  it("a duplicate structured reply after the answer is ignored without side effect", async () => {
    const s = setup();
    const { pub, answer, call } = await parkOn(s, permission());
    const data = reply(pub, { optionId: "once" });
    const r1 = s.registry.execute(makeReply("t1", data, makePublisher()));
    await answer;
    const p2 = makePublisher();
    const r2 = s.registry.execute(makeReply("t1", data, p2));
    await tick();
    expect(p2.calls).toHaveLength(0); // nothing published for the duplicate
    expect(s.provider.run).toHaveBeenCalledTimes(1); // and no queued turn became a provider call
    call.view.complete({ text: "done" });
    await Promise.all([r1, r2]);
    expect(s.provider.run).toHaveBeenCalledTimes(1);
  });
});

describe("per-task FIFO: one presented, the rest queued", () => {
  it("presents the second only when the first resolves; replies always match the presented one", async () => {
    const s = setup();
    const { pub, call, answer, done } = await parkOn(s, permission({ title: "first" }));
    await done;
    const second = call.view.ask(permission({ title: "second" }));
    const third = call.view.ask({ kind: "confirm", title: "third" });
    await tick();
    await s.registry.drain();
    const recs = await s.store.listPending("t1");
    expect(recs.map((r) => [r.seq, r.state])).toEqual([[1, "presented"], [2, "queued"], [3, "queued"]]);
    expect(pub.calls.filter((c) => c.k === "interaction")).toHaveLength(1); // only the presented one is on the wire

    const firstId = lastInteraction(pub).id;
    const rp = makePublisher();
    const replied = s.registry.execute(makeReply("t1", reply(pub, { optionId: "once" }), rp));
    expect(await answer).toMatchObject({ outcome: "selected" });
    expect(await replied).toBe("parked"); // the next one was presented on the reply's stream
    const secondIface = lastInteraction(rp);
    expect(secondIface.title).toBe("second");
    expect(secondIface.id).not.toBe(firstId);

    // a reply naming the first (stale) interaction is ignored; the second stays open
    const stale = makePublisher();
    await s.registry.execute(makeReply("t1", [{ kind: "data", data: { interactionId: firstId, optionId: "once" } }], stale));
    expect(stale.calls.filter((c) => c.k === "interaction")).toHaveLength(1);

    void s.registry.execute(makeReply("t1", [{ kind: "data", data: { interactionId: secondIface.id, optionId: "no" } }], makePublisher()));
    expect(await second).toMatchObject({ outcome: "selected", optionId: "no" });
    await tick();
    expect(lastInteraction(pub).title).not.toBe("third"); // the third went to the latest attachment
    await s.registry.drain();
    expect((await s.store.listPending("t1")).map((r) => r.state)).toEqual(["answered", "answered", "presented"]);
    void third;
  });

  it("a rebased expiry: a queued interaction's clock starts when it is presented", async () => {
    vi.useFakeTimers();
    const s = setup({ mode: "ask", timeoutMs: 1000, onTimeout: "deny" });
    const pub = makePublisher();
    void s.registry.execute(makeInit("t1", "ctx", pub));
    await flush();
    const view = s.provider.runs[0].view;
    const a = view.ask(permission({ title: "a" }));
    const b = view.ask(permission({ title: "b" }));
    await flush();
    await vi.advanceTimersByTimeAsync(900);
    void s.registry.execute(makeReply("t1", reply(pub, { optionId: "once" }), makePublisher()));
    await flush();
    await a;
    await vi.advanceTimersByTimeAsync(900); // 1800ms since b was asked, but only 900ms since it was presented
    let settled = false;
    void b.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await b).toEqual({ outcome: "expired" });
  });
});

describe("expiry", () => {
  it("permission expires after 10 minutes (default); onTimeout fail ends the task failed through registry.expire", async () => {
    vi.useFakeTimers();
    const s = setup();
    const pub = makePublisher();
    const done = s.registry.execute(makeInit("t1", "ctx", pub));
    await flush();
    const answer = s.provider.runs[0].view.ask(permission());
    await flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(pub.terminal()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await s.registry.drain();
    // the provider never sees an approval (it sees the task stop)
    expect(isApproval(lastInteraction(pub), await answer)).toBe(false);
    expect(pub.terminal()).toMatchObject([{ state: "failed", text: expect.stringContaining("not answered in time"), metadata: { code: "timeout" } }]);
    expect(await done).toBe("parked"); // the first execute() returned at the park, long before
    expect((await s.store.getRun("t1"))?.state).toBe("failed");
    expect((await s.store.listPending("t1"))[0]).toMatchObject({ state: "expired", result: { outcome: "expired" } });
    expect(s.provider.abort).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("onTimeout deny: the provider sees expired (a denial) and the same run goes on, task back to working", async () => {
    vi.useFakeTimers();
    const s = setup({ mode: "ask", onTimeout: "deny", timeoutMs: 5_000 });
    const pub = makePublisher();
    void s.registry.execute(makeInit("t1", "ctx", pub));
    await flush();
    const call = s.provider.runs[0];
    const answer = call.view.ask(permission());
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await answer).toEqual({ outcome: "expired" });
    expect(pub.statuses().map((x) => x.state)).toContain("working");
    await s.registry.drain();
    expect((await s.store.getRun("t1"))?.state).toBe("working");
    expect(s.provider.run).toHaveBeenCalledTimes(1);
    call.view.complete({ text: "carried on" });
    expect(pub.terminal().map((x) => x.state)).toEqual(["completed"]);
  });

  it("auth waits 30 minutes, everything else 10", async () => {
    vi.useFakeTimers();
    const s = setup({ mode: "ask", onTimeout: "deny" });
    void s.registry.execute(makeInit("t1", "ctx", makePublisher()));
    await flush();
    const view = s.provider.runs[0].view;
    const auth = view.ask({ kind: "auth", title: "Sign in", auth: { service: "x" } });
    let settled = false;
    void auth.then(() => (settled = true));
    await flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(await auth).toEqual({ outcome: "expired" });
  });

  it("a provider-given expiresAt is kept; policy timeoutMs overrides the defaults", async () => {
    vi.useFakeTimers();
    const s = setup({ mode: "ask", onTimeout: "deny", timeoutMs: 60_000 });
    void s.registry.execute(makeInit("t1", "ctx", makePublisher()));
    await flush();
    const view = s.provider.runs[0].view;
    const soon = view.ask(permission({ expiresAt: new Date(Date.now() + 2_000).toISOString() }));
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await soon).toEqual({ outcome: "expired" });
  });

  it("timers do not keep the process alive and are cleared on cancel and on complete", async () => {
    vi.useFakeTimers();
    const created: Array<{ hasRef?: () => boolean }> = [];
    const fake = globalThis.setTimeout;
    globalThis.setTimeout = ((...a: Parameters<typeof setTimeout>) => {
      const t = fake(...a) as unknown as { hasRef?: () => boolean };
      created.push(t);
      return t;
    }) as typeof setTimeout;
    const s = setup();
    const done = s.registry.execute(makeInit("t1", "ctx", makePublisher()));
    await flush();
    const call = s.provider.runs[0];
    const a = call.view.ask(permission());
    await flush();
    globalThis.setTimeout = fake;
    const timers = created.filter((t) => typeof t?.hasRef === "function");
    expect(timers.length).toBeGreaterThan(0);
    expect(timers.every((t) => t.hasRef!() === false)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    expect(await a).toEqual({ outcome: "canceled" });
    expect(vi.getTimerCount()).toBe(0);
    await done;

    // complete while asking
    const s2 = setup();
    void s2.registry.execute(makeInit("t2", "ctx2", makePublisher()));
    await flush();
    const c2 = s2.provider.runs[0];
    const b = c2.view.ask(permission());
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    c2.view.complete({ text: "done" });
    expect(await b).toEqual({ outcome: "canceled" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("withdrawal (AskOptions.signal)", () => {
  it("withdrawing a QUEUED ask changes nothing on the wire", async () => {
    const s = setup();
    const { pub, call, done } = await parkOn(s, permission({ title: "a" }));
    await done;
    const ac = new AbortController();
    const queued = call.view.ask(permission({ title: "w" }), { signal: ac.signal });
    await tick();
    ac.abort();
    expect(await queued).toEqual({ outcome: "withdrawn" });
    expect(pub.calls.filter((c) => c.k === "interaction")).toHaveLength(1);
    await s.registry.drain();
    expect((await s.store.listPending("t1")).map((r) => r.state)).toEqual(["presented", "withdrawn"]);
  });

  it("withdrawing the PRESENTED ask presents the next queued one, or returns the task to working", async () => {
    const s = setup();
    const pub = makePublisher();
    void s.registry.execute(makeInit("t1", "ctx", pub));
    await until(() => s.provider.runs.length === 1);
    const view = s.provider.runs[0].view;
    const ac = new AbortController();
    const a = view.ask(permission({ title: "a" }), { signal: ac.signal });
    const b = view.ask(permission({ title: "b" }));
    await tick();
    ac.abort();
    expect(await a).toEqual({ outcome: "withdrawn" });
    expect(lastInteraction(pub).title).toBe("b"); // b is presented now
    await s.registry.drain();
    expect((await s.store.listPending("t1")).map((r) => r.state)).toEqual(["withdrawn", "presented"]);

    const ac2 = new AbortController();
    const c = view.ask(permission({ title: "c" }), { signal: ac2.signal });
    void c;
    void s.registry.execute(makeReply("t1", reply(pub, { optionId: "once" }), makePublisher()));
    await b;
    await tick();
    expect(lastInteraction(pub).title).toBe("b");
    ac2.abort();
    expect(await c).toEqual({ outcome: "withdrawn" });
    await s.registry.drain();
    expect((await s.store.getRun("t1"))?.state).toBe("working");
  });

  it("an already aborted signal is withdrawn at once and never published", async () => {
    const s = setup();
    const pub = makePublisher();
    void s.registry.execute(makeInit("t1", "ctx", pub));
    await until(() => s.provider.runs.length === 1);
    const ac = new AbortController();
    ac.abort();
    expect(await s.provider.runs[0].view.ask(permission(), { signal: ac.signal })).toEqual({ outcome: "withdrawn" });
    expect(pub.calls.some((c) => c.k === "interaction")).toBe(false);
  });
});

describe("cancel and completion while asking", () => {
  it("cancel while parked: exactly one terminal, the presented AND the queued asks are canceled", async () => {
    const s = setup();
    const { pub, call, answer, done } = await parkOn(s, permission());
    await done;
    const queued = call.view.ask(permission({ title: "queued" }));
    await tick();
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    expect(await answer).toEqual({ outcome: "canceled" });
    expect(await queued).toEqual({ outcome: "canceled" });
    expect(pub.terminal().map((x) => x.state)).toEqual(["canceled"]);
    await s.registry.drain();
    expect((await s.store.listPending("t1")).map((r) => r.state)).toEqual(["canceled", "canceled"]);
    // a reply after the cancel finds no run: it starts nothing parked
    expect(s.registry.isLive("t1")).toBe(false);
  });

  it("complete while an ask is queued: the task completes once and the asks are canceled, not left hanging", async () => {
    const s = setup();
    const { pub, call, answer, done } = await parkOn(s, permission());
    await done;
    const queued = call.view.ask(permission({ title: "queued" }));
    call.view.complete({ text: "finished anyway" });
    expect(await answer).toEqual({ outcome: "canceled" });
    expect(await queued).toEqual({ outcome: "canceled" });
    expect(pub.terminal().map((x) => x.state)).toEqual(["completed"]);
    await s.registry.drain();
    expect((await s.store.listPending("t1")).map((r) => r.state)).toEqual(["canceled", "canceled"]);
  });

  it("an ask after the run is over answers canceled", async () => {
    const s = setup();
    const { call, done } = await parkOn(s, { kind: "confirm", title: "?" });
    await done;
    await s.registry.cancel("t1", ANONYMOUS_CALLER);
    expect(await call.view.ask(permission())).toEqual({ outcome: "canceled" });
  });
});

describe("the same run resumes", () => {
  it("provider.run is called once across ask, reply, a second ask and its reply", async () => {
    const s = setup();
    const { pub, call, done } = await parkOn(s, permission());
    await done;
    const r1 = s.registry.execute(makeReply("t1", reply(pub, { optionId: "once" }), makePublisher()));
    await tick();
    const second = call.view.ask({ kind: "confirm", title: "again?" });
    expect(await r1).toBe("parked"); // the reply's attachment returns when the run parks again
    const pub2 = makePublisher();
    // the second ask was presented on the first reply's stream; find its id from the store
    await s.registry.drain();
    const open = (await s.store.listPending("t1")).find((r) => r.state === "presented")!;
    const r2 = s.registry.execute(makeReply("t1", [{ kind: "data", data: { interactionId: open.interaction.id, optionId: "allow" } }], pub2));
    expect(await second).toMatchObject({ outcome: "selected", optionId: "allow" });
    call.view.complete({ text: "done" });
    expect(await r2).toBe("ended");
    expect(s.provider.run).toHaveBeenCalledTimes(1);
  });

  it("the reply's attachment sees the events of the continued run, and it returns at the next park or end", async () => {
    const s = setup();
    const { pub, call, done } = await parkOn(s, permission());
    await done;
    const rp = makePublisher();
    const replied = s.registry.execute(makeReply("t1", reply(pub, { optionId: "once" }), rp));
    await tick();
    call.view.event({ type: "text", text: "after approval" });
    call.view.complete({});
    expect(await replied).toBe("ended");
    expect(rp.calls.filter((c) => c.k === "event").map((c) => c.v.text)).toEqual(["after approval"]);
    expect(pub.calls.filter((c) => c.k === "event")).toHaveLength(0); // not the dead first stream
  });

  it("the run parks again before the reply's attachment starts waiting: the boundary is not lost", async () => {
    const s = setup();
    const { pub, call, done } = await parkOn(s, permission());
    await done;
    // the provider re-asks the moment its first ask resolves
    const again = call.view.ask({ kind: "confirm", title: "second" });
    void again;
    const rp = makePublisher();
    const outcome = await s.registry.execute(makeReply("t1", reply(pub, { optionId: "once" }), rp));
    expect(outcome).toBe("parked");
    expect(lastInteraction(rp).title).toBe("second");
  });
});

describe("policy", () => {
  it('mode "auto" (default): core asks nobody; ask answers unavailable; nothing is published or stored', async () => {
    const s = setup({});
    const pub = makePublisher();
    const done = s.registry.execute(makeInit("t1", "ctx", pub));
    await until(() => s.provider.runs.length === 1);
    expect(await s.provider.runs[0].view.ask(permission())).toMatchObject({ outcome: "unavailable" });
    expect(pub.calls.some((c) => c.k === "interaction")).toBe(false);
    expect(await s.store.listPending("t1")).toEqual([]);
    s.provider.runs[0].view.complete({ text: "x" });
    expect(await done).toBe("ended");
  });

  it("with no policy at all the registry behaves as before (ask is unavailable)", async () => {
    const provider = makeProvider();
    const registry = new RunRegistry({ provider });
    void registry.execute(makeInit("t1"));
    await until(() => provider.runs.length === 1);
    expect(await provider.runs[0].view.ask(permission())).toMatchObject({ outcome: "unavailable" });
  });

  it("ask mode: autoAnswer rules answer without a person (by: policy), first match wins, others go to the client", async () => {
    const s = setup({
      mode: "ask",
      autoAnswer: [
        { match: { kind: "permission", risk: "low" }, answer: { kind: "allow_once" } },
        { match: { kind: "permission" }, answer: { decline: true } },
      ],
    });
    const pub = makePublisher();
    void s.registry.execute(makeInit("t1", "ctx", pub));
    await until(() => s.provider.runs.length === 1);
    const view = s.provider.runs[0].view;
    const low = await view.ask(permission());
    expect(low).toMatchObject({ outcome: "selected", optionId: "once", by: { id: "policy", kind: "service" } });
    expect(isApproval(permission() as any, low)).toBe(true);
    const high = await view.ask(permission({ subject: { risk: "high" } }));
    expect(high).toMatchObject({ outcome: "selected", optionId: "no", by: { id: "policy" } }); // decline picks a plain reject
    expect(pub.calls.some((c) => c.k === "interaction")).toBe(false); // nobody was asked
    await s.registry.drain();
    expect((await s.store.listPending("t1")).map((r) => r.state)).toEqual(["answered", "answered"]);
    // a question matches no rule: it goes to the client
    void view.ask({ kind: "question", title: "q", questions: [{ id: "q", prompt: "?" }] });
    await tick();
    expect(lastInteraction(pub).kind).toBe("question");
  });

  it("a rule asking for an option kind the interaction does not offer does not match", async () => {
    const s = setup({ mode: "ask", autoAnswer: [{ match: {}, answer: { kind: "allow_always" } }] });
    const pub = makePublisher();
    void s.registry.execute(makeInit("t1", "ctx", pub));
    await until(() => s.provider.runs.length === 1);
    void s.provider.runs[0].view.ask({ kind: "confirm", title: "?" });
    await tick();
    expect(lastInteraction(pub).kind).toBe("confirm");
  });

  it("a malformed policy is refused", () => {
    expect(() => new RunRegistry({ provider: makeProvider(), interactionPolicy: { mode: "yolo" as any } })).toThrow(/mode/);
    expect(() => new RunRegistry({ provider: makeProvider(), interactionPolicy: { mode: "ask", timeoutMs: -1 } })).toThrow(/timeoutMs/);
    expect(() => new RunRegistry({ provider: makeProvider(), interactionPolicy: { mode: "ask", autoAnswer: [{ match: {}, answer: {} as any }] } })).toThrow(/autoAnswer/);
  });
});

describe("authorize: the single choke point", () => {
  it("is asked with action answer and the caller; a denied reply is not an answer and re-prompts", async () => {
    const seen: unknown[] = [];
    const s = setup({ mode: "ask" }, { authorize: (by, action, target) => (seen.push([by.id, action, target.taskId]), by.id === "alice") });
    const { pub, answer, done } = await parkOn(s, permission());
    await done;
    const bob = makePublisher();
    await s.registry.execute(makeReply("t1", reply(pub, { optionId: "once" }), bob, { id: "bob", kind: "user" }));
    expect(bob.calls.find((c) => c.k === "interaction")?.v.options?.hint).toMatch(/not allowed/);
    let settled = false;
    void answer.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    void s.registry.execute(makeReply("t1", reply(pub, { optionId: "once" }), makePublisher(), { id: "alice", kind: "user" }));
    expect(await answer).toMatchObject({ outcome: "selected", by: { id: "alice" } });
    expect(seen).toContainEqual(["bob", "answer", "t1"]);
  });

  it("handleReply never throws: an authorizer that throws leaves the run parked and the message unused", async () => {
    const s = setup({ mode: "ask" }, { authorize: () => { throw new Error("policy backend down"); } });
    const { pub, answer, done } = await parkOn(s, permission());
    await done;
    const outcome = await s.registry.execute(makeReply("t1", reply(pub, { optionId: "once" }), makePublisher()));
    expect(outcome).toBe("parked");
    expect(s.provider.run).toHaveBeenCalledTimes(1);
    let settled = false;
    void answer.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
  });
});

describe("secrets", () => {
  it("the provider gets the secret answer, the stored record is redacted, and it is never logged", async () => {
    const s = setup();
    const { pub, answer, done } = await parkOn(s, {
      kind: "question",
      title: "Credentials",
      questions: [
        { id: "user", prompt: "User?" },
        { id: "token", prompt: "Token?", secret: true },
      ],
    });
    await done;
    const secret = "s3cr3t-hunter2";
    void s.registry.execute(makeReply("t1", reply(pub, { answers: { user: { text: "ada" }, token: { text: secret } } }), makePublisher()));
    const result = await answer;
    expect(result).toMatchObject({ outcome: "answered", answers: { token: { text: secret } } });
    await s.registry.drain();
    const [rec] = await s.store.listPending("t1");
    expect(rec.result).toMatchObject({ outcome: "answered", answers: { user: { text: "ada" }, token: {} }, redacted: ["answers.token.text"] });
    expect(JSON.stringify(rec)).not.toContain(secret);
    expect(JSON.stringify(s.warn.mock.calls)).not.toContain(secret);
  });
});

describe("restart sweep of interrupted records", () => {
  const owner = { id: "anonymous", kind: "anonymous" };
  const runRecord = (patch: Partial<RunRecord> = {}): RunRecord => ({
    ...newRecordHeader(owner, "t"),
    runId: "run-1",
    taskId: "t1",
    contextId: "ctx",
    turnId: "turn-1",
    state: "input-required",
    startedAt: "t",
    ...patch,
  });
  const pendingRec = (patch: Record<string, unknown> = {}) => ({
    ...newRecordHeader(owner, "t"),
    interaction: { kind: "permission", id: "i1", title: "Run?", replyCode: "AB23", options: [{ id: "once", label: "Yes", kind: "allow_once" }, { id: "no", label: "No", kind: "reject_once" }] },
    taskId: "t1",
    contextId: "ctx",
    runId: "run-1",
    seq: 1,
    state: "presented",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...patch,
  }) as any;

  it("fail path: no reattach (or no handle) fails the task with 'server restarted' and expires the pending records", async () => {
    const provider = makeProvider();
    const store = new InMemoryRunStore();
    await store.putRun(runRecord());
    await store.putPending(pendingRec()); // no handle: cannot be re-attached
    await store.putPending(pendingRec({ seq: 2, state: "queued", interaction: { ...pendingRec().interaction, id: "i2" } }));
    const registry = new RunRegistry({ provider, store, interactionPolicy: { mode: "ask" } });
    const endTask = vi.fn(async () => {});
    const report = await registry.sweep({ endTask });
    expect(report.entries).toMatchObject([{ taskId: "t1", action: "interrupted-failed" }]);
    expect(endTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1", state: "failed", reason: "server restarted" }));
    expect((await store.getRun("t1"))?.state).toBe("failed");
    expect((await store.listPending("t1")).map((r) => [r.state, r.result])).toEqual([["expired", { outcome: "expired" }], ["expired", { outcome: "expired" }]]);
    expect(provider.abortOrphan).not.toHaveBeenCalled();
  });

  it("fail path: a provider with reattach but a record with no handle still fails", async () => {
    const provider = makeProvider();
    (provider as any).reattach = vi.fn(async () => {});
    const store = new InMemoryRunStore();
    await store.putRun(runRecord());
    await store.putPending(pendingRec());
    const registry = new RunRegistry({ provider, store, interactionPolicy: { mode: "ask" } });
    await registry.sweep();
    expect((provider as any).reattach).not.toHaveBeenCalled();
    expect((await store.getRun("t1"))?.state).toBe("failed");
  });

  it("reattach path: the provider gets the records with a handle and the run's view, re-asks with the handle and continues; a reply then resolves the restored interaction", async () => {
    const provider = makeProvider();
    let continued: Promise<CoreInteractionResult> | undefined;
    (provider as any).reattach = vi.fn(async (pending: any[], runs: any) => {
      const view = runs.view(pending[0].taskId);
      continued = view.ask({ kind: "permission", title: "ignored: matched by handle", options: [{ id: "x", label: "x", kind: "allow_once" }] }, { handle: pending[0].handle });
    });
    const store = new InMemoryRunStore();
    await store.putRun(runRecord());
    await store.putPending(pendingRec({ handle: "copilot-req-9" }));
    const registry = new RunRegistry({ provider, store, interactionPolicy: { mode: "ask" } });
    const report = await registry.sweep();
    expect(report.entries).toMatchObject([{ taskId: "t1", action: "interrupted-reattached" }]);
    expect((provider as any).reattach).toHaveBeenCalledWith([expect.objectContaining({ handle: "copilot-req-9" })], expect.anything());
    expect(registry.isLive("t1")).toBe(true);
    expect(registry.isParked("t1")).toBe(true);
    expect(provider.run).not.toHaveBeenCalled(); // nothing is started: the provider resumed its own turn

    // a client replies to the restored interaction (same id, same code); the re-asked promise resolves
    const pub = makePublisher();
    const outcome = registry.execute(makeReply("t1", [{ kind: "data", data: { interactionId: "i1", optionId: "once" } }], pub));
    expect(await continued).toMatchObject({ outcome: "selected", optionId: "once" });
    expect(provider.run).not.toHaveBeenCalled();
    await registry.drain();
    expect((await store.listPending("t1"))).toHaveLength(1); // the same record, no new one
    expect((await store.listPending("t1"))[0]).toMatchObject({ state: "answered" });
    // the adopted run can be ended through its view
    registry.viewFor("t1")!.complete({ text: "resumed and done" });
    expect(await outcome).toBe("ended");
  });

  it("reattach path: an expiry that passed during the outage fires at once (the timer keeps the original deadline)", async () => {
    vi.useFakeTimers();
    const provider = makeProvider();
    let continued!: Promise<CoreInteractionResult>;
    (provider as any).reattach = vi.fn(async (pending: any[], runs: any) => {
      continued = runs.view("t1").ask({ kind: "permission", title: "x", options: [{ id: "x", label: "x", kind: "allow_once" }] }, { handle: pending[0].handle });
    });
    const store = new InMemoryRunStore();
    await store.putRun(runRecord());
    await store.putPending(pendingRec({ handle: "h", expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const registry = new RunRegistry({ provider, store, interactionPolicy: { mode: "ask", onTimeout: "deny" } });
    await registry.sweep();
    await vi.advanceTimersByTimeAsync(1);
    expect(await continued).toEqual({ outcome: "expired" });
  });

  it("reattach path: a provider whose reattach rejects gets the task failed", async () => {
    const provider = makeProvider();
    (provider as any).reattach = vi.fn(async () => {
      throw new Error("cannot resume");
    });
    const store = new InMemoryRunStore();
    await store.putRun(runRecord());
    await store.putPending(pendingRec({ handle: "h" }));
    const registry = new RunRegistry({ provider, store, interactionPolicy: { mode: "ask" }, logger: { warn: vi.fn() } });
    const endTask = vi.fn(async () => {});
    const report = await registry.sweep({ endTask });
    expect(report.entries[0].action).toBe("interrupted-failed");
    expect((await store.getRun("t1"))?.state).toBe("failed");
    expect((await store.listPending("t1"))[0].state).toBe("expired");
    expect(registry.isLive("t1")).toBe(false);
    expect(endTask).toHaveBeenCalled();
  });
});

describe("round 2: policy, timers, restart edge cases", () => {
  const owner = { id: "anonymous", kind: "anonymous" };
  const runRecord = (): RunRecord => ({
    ...newRecordHeader(owner, "t"),
    runId: "run-1",
    taskId: "t1",
    contextId: "ctx",
    turnId: "turn-1",
    state: "input-required",
    startedAt: "t",
  });
  const pendingRec = (patch: Record<string, unknown> = {}) =>
    ({
      ...newRecordHeader(owner, "t"),
      interaction: { kind: "permission", id: "i1", title: "Run?", replyCode: "AB23", options: [{ id: "once", label: "Yes", kind: "allow_once" }, { id: "no", label: "No", kind: "reject_once" }] },
      taskId: "t1",
      contextId: "ctx",
      runId: "run-1",
      seq: 1,
      state: "presented",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...patch,
    }) as any;

  it("N1: auto mode applies configured autoAnswer rules (a catch-all allow_once reproduces today's approve-everything); unmatched is unavailable", async () => {
    const s = setup({ mode: "auto", autoAnswer: [{ match: { kind: "permission" }, answer: { kind: "allow_once" } }] });
    const pub = makePublisher();
    void s.registry.execute(makeInit("t1", "ctx", pub));
    await until(() => s.provider.runs.length === 1);
    const view = s.provider.runs[0].view;
    expect(await view.ask(permission())).toMatchObject({ outcome: "selected", optionId: "once", by: { id: "policy" } });
    expect(await view.ask({ kind: "question", title: "q", questions: [{ id: "q", prompt: "?" }] })).toMatchObject({ outcome: "unavailable" });
    expect(pub.calls.some((c) => c.k === "interaction")).toBe(false); // auto never asks a person
  });

  it("N2: a timeout beyond the 2^31-1 ms timer limit does not expire early, and does expire at its deadline", async () => {
    vi.useFakeTimers();
    const total = 2 ** 31 + 5_000;
    const s = setup({ mode: "ask", onTimeout: "deny", timeoutMs: total });
    void s.registry.execute(makeInit("t1", "ctx", makePublisher()));
    await flush();
    const a = s.provider.runs[0].view.ask(permission());
    let settled = false;
    void a.then(() => (settled = true));
    await flush();
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1); // the capped timer fires here: far too early
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000); // the deadline is 5001 ms after that first (capped) timer
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await a).toEqual({ outcome: "expired" });
  });

  it("N5: a restored interaction answered before the provider re-asks hands the answer to the re-ask", async () => {
    const provider = makeProvider();
    let view: any;
    (provider as any).reattach = vi.fn(async (_p: any[], runs: any) => {
      view = runs.view("t1"); // the provider has the view but has not re-asked yet
    });
    const store = new InMemoryRunStore();
    await store.putRun(runRecord());
    await store.putPending(pendingRec({ handle: "h-1" }));
    const registry = new RunRegistry({ provider, store, interactionPolicy: { mode: "ask" } });
    await registry.sweep();
    const pub = makePublisher();
    const replied = registry.execute(makeReply("t1", [{ kind: "data", data: { interactionId: "i1", optionId: "once" } }], pub));
    await tick();
    expect(pub.statuses().map((x) => x.state)).toEqual(["working"]); // the answer was applied
    const late = await view.ask({ kind: "permission", title: "x", options: [{ id: "once", label: "x", kind: "allow_once" }] }, { handle: "h-1" });
    expect(late).toMatchObject({ outcome: "selected", optionId: "once" }); // not lost
    view.complete({ text: "done" });
    expect(await replied).toBe("ended");
  });

  it("N4: a duplicate structured reply is recognised from the STORE (an interaction answered before this process started)", async () => {
    const provider = makeProvider();
    let view: any;
    (provider as any).reattach = vi.fn(async (_p: any[], runs: any) => {
      view = runs.view("t1");
    });
    const store = new InMemoryRunStore();
    await store.putRun(runRecord());
    await store.putPending(pendingRec({ handle: "h-1" }));
    // answered in an earlier life of the process: only the store knows
    await store.putPending(pendingRec({ seq: 0, state: "answered", interaction: { ...pendingRec().interaction, id: "i0" }, result: { outcome: "selected", optionId: "once", by: owner } }));
    const registry = new RunRegistry({ provider, store, interactionPolicy: { mode: "ask" } });
    await registry.sweep();
    const first = registry.execute(makeReply("t1", [{ kind: "data", data: { interactionId: "i1", optionId: "once" } }], makePublisher()));
    await tick();
    const dupPub = makePublisher();
    const dup = registry.execute(makeReply("t1", [{ kind: "data", data: { interactionId: "i0", optionId: "once" } }], dupPub));
    await tick();
    expect(dupPub.calls).toHaveLength(0); // no side effect: nothing re-published, nothing resolved
    view.complete({ text: "done" });
    expect(await dup).toBe("ended"); // consumed as a duplicate (not queued as a turn: that would be "queued")
    await first;
    expect(provider.run).not.toHaveBeenCalled();
  });

  it("settle-once: a second settle of the same interaction (late timer, late abort) is refused and cannot rewrite the stored outcome", async () => {
    const s = setup();
    const { done, answer } = await parkOn(s, permission());
    await done;
    const runtime = (s.registry as any).interactions;
    const st = runtime.states.get(s.registry.get("t1"));
    const item = st.items[0];
    expect(runtime.settle(st, item, "expired", { outcome: "expired" })).toBe(true);
    // whatever reaches it afterwards (a reply that raced, an abort listener) must not flip a final record
    expect(runtime.settle(st, item, "answered", { outcome: "selected", optionId: "once", by: ANONYMOUS_CALLER })).toBe(false);
    expect(runtime.settle(st, item, "withdrawn", { outcome: "withdrawn" })).toBe(false);
    expect(await answer).toEqual({ outcome: "expired" });
    await s.registry.drain();
    expect((await s.store.listPending("t1"))[0]).toMatchObject({ state: "expired", result: { outcome: "expired" } });
  });
});
