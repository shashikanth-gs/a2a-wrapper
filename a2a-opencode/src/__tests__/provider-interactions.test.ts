/**
 * Permission requests and questions through core's interactions.
 *
 * Default (`interactions.mode: "auto"`, no rules): nobody is asked and the wrapper answers as it always did (`always`, or reject
 * with `features.autoApprovePermissions: false`; the first option of every question, or reject). With rules or `ask` core decides:
 * rules answer what they match, and `ask` sends what no rule answers to the A2A client as `input-required`; the server's pending
 * request resumes on the reply. Only an explicit allow approves; everything else rejects, and the model is told.
 */

import { describe, expect, it } from "vitest";
import { stateName, summarizeEvent, summarizeTask } from "@a2a-wrapper/core";
import { FakeBackend, assistant, idle, text, type Script } from "./helpers/fake-backend.js";
import { serve, sleep, until, useConfig } from "./helpers/harness.js";
import { ASK_PERMISSIONS, AUTO_ALLOW_PERMISSIONS } from "../opencode/sessions.js";
import {
  ALWAYS,
  ONCE,
  REJECT,
  UNAVAILABLE_MESSAGE,
  legacyPermissionReply,
  legacyQuestionAnswers,
  nobodyWasAsked,
  permissionInteraction,
  permissionReply,
  questionAnswers,
  questionInteraction,
} from "../opencode/interactions.js";
import { interactionPolicyOf } from "../server/index.js";
import type { InteractionsConfig } from "../config/types.js";

const ctx = useConfig();

const perm = (id = "per_1", over: Record<string, unknown> = {}) => ({
  type: "permission.asked",
  properties: { id, sessionID: "ses_1", permission: "bash", patterns: ["echo hi > perm.txt"], metadata: { command: "echo hi > perm.txt" }, always: ["echo *"], ...over },
});
const question = (id = "que_1") => ({
  type: "question.asked",
  properties: {
    id,
    sessionID: "ses_1",
    questions: [{ question: "Which fruit?", header: "Fruit", options: [{ label: "Apple", description: "crisp" }, { label: "Banana", description: "soft" }], multiple: false, custom: true }],
  },
});

/** A script that raises `ask` events, waits until the server was answered `n` times, then answers. */
const asking = (events: unknown[], n = 1, answer = "finished"): Script => async ({ emit, backend, sleep: nap, sessionId }) => {
  emit(assistant("m1", {}, sessionId));
  for (const e of events) emit(e);
  const t0 = Date.now();
  while (backend.replies.length < n && Date.now() - t0 < 4000) await nap(5);
  emit(text(answer, sessionId));
  emit(idle(sessionId));
};

function boot(opts: { interactions?: InteractionsConfig; script: Script; kind?: "v1" | "v2" }) {
  if (opts.interactions) ctx.config.interactions = opts.interactions;
  return serve(ctx.config, new FakeBackend({ kind: opts.kind ?? "v1", scripts: [opts.script] }));
}

/** The text and structured part of the input-required status a stream carries. */
function inputRequired(events: any[]) {
  const e = events.find((x: any) => x.payload.$case === "statusUpdate" && stateName(x.payload.value.status.state) === "input-required");
  if (!e) return undefined;
  const parts = e.payload.value.status.message.parts;
  const t = parts.map((p: any) => p.content?.value).find((v: any) => typeof v === "string") as string;
  const data = parts.map((p: any) => p.content?.value).find((v: any) => v && typeof v === "object")!;
  return { text: t, data, code: /`\d+ ([A-Z0-9]{4})`/.exec(t)?.[1] };
}
const dataReply = (value: unknown) => [{ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" }];
const taskIdOf = (events: any[]) => (events[0] as any).payload.value.id as string;

describe("default policy (auto): the headless behaviour is unchanged", () => {
  it("replies `always` to a permission request and nobody is asked", async () => {
    const h = boot({ script: asking([perm()]) });
    const { events } = await h.server.stream({ text: "do it", contextId: "ctx" });
    expect(inputRequired(events)).toBeUndefined();
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
    expect(h.backend.replies).toEqual([{ kind: "permission", id: "per_1", reply: "always" }]);
  });

  it("features.autoApprovePermissions false rejects", async () => {
    ctx.config.features.autoApprovePermissions = false;
    const h = boot({ script: asking([perm()]) });
    await h.server.stream({ text: "do it", contextId: "ctx" });
    expect(h.backend.replies).toEqual([{ kind: "permission", id: "per_1", reply: "reject" }]);
  });

  it("answers a question with the first option of every question; features.autoAnswerQuestions false rejects it", async () => {
    const a = boot({ script: asking([question()]) });
    await a.server.stream({ text: "do it", contextId: "ctx" });
    expect(a.backend.replies).toEqual([{ kind: "question", id: "que_1", answers: [["Apple"]] }]);

    ctx.config.features.autoAnswerQuestions = false;
    const b = boot({ script: asking([question()]) });
    await b.server.stream({ text: "do it", contextId: "ctx" });
    expect(b.backend.replies).toEqual([{ kind: "question", id: "que_1", rejected: true }]);
  });

  it("an explicit auto mode with no rules is the same", async () => {
    const h = boot({ interactions: { mode: "auto" }, script: asking([perm()]) });
    const { events } = await h.server.stream({ text: "do it", contextId: "ctx" });
    expect(inputRequired(events)).toBeUndefined();
    expect(h.backend.replies[0]).toMatchObject({ reply: "always" });
  });

  it("new sessions allow every tool up front (so nothing asks), as they always did; none when auto-approve is off", async () => {
    const a = boot({ script: asking([], 0) });
    await a.server.stream({ text: "x", contextId: "ctx" });
    expect(a.backend.sessions.get("ses_1")?.opts?.permission).toEqual(AUTO_ALLOW_PERMISSIONS);

    ctx.config.features.autoApprovePermissions = false;
    const b = boot({ script: asking([], 0) });
    await b.server.stream({ text: "x", contextId: "ctx" });
    expect(b.backend.sessions.get("ses_1")?.opts?.permission).toBeUndefined();
  });

  it("autoAnswer rules answer what they match even in auto mode; the rest keeps the wrapper's own answer", async () => {
    const h = boot({
      interactions: { mode: "auto", autoAnswer: [{ match: { tool: "bash", risk: "high" }, answer: { kind: "allow_once" } }, { match: { tool: "webfetch" }, answer: { decline: true } }] },
      script: asking([perm("p1"), perm("p2", { permission: "webfetch", patterns: ["https://x"], metadata: {} }), perm("p3", { permission: "read", patterns: ["a.txt"] })], 3),
    });
    const { events } = await h.server.stream({ text: "do it", contextId: "ctx" });
    expect(inputRequired(events)).toBeUndefined();
    const by = Object.fromEntries(h.backend.replies.map((r) => [r.id, r.reply]));
    expect(by).toEqual({ p1: "once", p2: "reject", p3: "always" });
  });
});

describe("ask mode: permission requests reach the client", () => {
  const ask = { mode: "ask", timeoutMs: 60_000 } as const;

  it("new sessions ask for what has side effects (reads stay allowed), instead of allowing everything", async () => {
    const h = boot({ interactions: ask, script: asking([], 0) });
    await h.server.stream({ text: "x", contextId: "ctx" });
    expect(h.backend.sessions.get("ses_1")?.opts?.permission).toEqual(ASK_PERMISSIONS);
    expect(ASK_PERMISSIONS.filter((r) => r.action === "ask").map((r) => r.permission)).toEqual(["edit", "bash", "task", "mcp", "fetch"]);
    expect(ASK_PERMISSIONS.filter((r) => r.action === "allow").map((r) => r.permission)).toEqual(["read", "glob", "grep", "list"]);
  });

  it("parks the task as input-required (stream ends), and an allow-once reply resumes the server request", async () => {
    const h = boot({ interactions: ask, script: asking([perm()]) });
    const { events } = await h.server.stream({ text: "do it", contextId: "ctx" });
    const taskId = taskIdOf(events);
    const prompt = inputRequired(events)!;
    expect(prompt.data.interaction).toMatchObject({ kind: "permission", title: "Allow bash?", subject: { tool: "bash", action: "execute", command: "echo hi > perm.txt", risk: "high" } });
    expect(prompt.data.interaction.options.map((o: any) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    expect(prompt.text).toContain("echo *"); // what "always" would save
    expect(h.backend.replies).toEqual([]);

    const done = await h.server.send({ text: `1 ${prompt.code}`, contextId: "ctx", taskId });
    expect(stateName(done.status.state)).toBe("completed");
    expect(h.backend.replies).toEqual([{ kind: "permission", id: "per_1", reply: "once" }]);
  });

  it("`always allow` is a reply the client must choose", async () => {
    const h = boot({ interactions: ask, script: asking([perm()]) });
    const { events } = await h.server.stream({ text: "do it", contextId: "ctx" });
    const prompt = inputRequired(events)!;
    await h.server.send({ text: `2 ${prompt.code}`, contextId: "ctx", taskId: taskIdOf(events) });
    expect(h.backend.replies).toEqual([{ kind: "permission", id: "per_1", reply: "always" }]);
  });

  it("a text deny rejects with the fixed message; a structured deny carries the client's feedback to the model", async () => {
    const a = boot({ interactions: ask, script: asking([perm()]) });
    const first = await a.server.stream({ text: "do it", contextId: "ctx" });
    await a.server.send({ text: "no", contextId: "ctx", taskId: taskIdOf(first.events) });
    expect(a.backend.replies).toEqual([{ kind: "permission", id: "per_1", reply: "reject", message: "The user denied this request." }]);

    const b = boot({ interactions: ask, script: asking([perm()]) });
    const second = await b.server.stream({ text: "do it", contextId: "ctx" });
    const p = inputRequired(second.events)!;
    await b.server.send({ parts: dataReply({ interactionId: p.data.interactionId, outcome: "selected", optionId: "reject", feedback: "use the staging server instead" }), contextId: "ctx", taskId: taskIdOf(second.events) } as never);
    expect(b.backend.replies).toEqual([{ kind: "permission", id: "per_1", reply: "reject", message: "use the staging server instead" }]);
  });

  it("an unanswered request expires (onTimeout deny): rejected, and the turn goes on", async () => {
    const h = boot({ interactions: { mode: "ask", timeoutMs: 80, onTimeout: "deny" }, script: asking([perm()]) });
    const { events } = await h.server.stream({ text: "do it", contextId: "ctx" });
    // the stream ends at input-required; the expiry rejects the request on the server
    expect(inputRequired(events)).toBeDefined();
    await until(() => h.backend.replies.length === 1, 2000, "the expiry");
    expect(h.backend.replies[0]).toMatchObject({ reply: "reject", message: "Nobody answered this request in time, so it was denied." });
    await h.server.registry.drain();
  });

  it("the default `fail` timeout fails the task and rejects the server request", async () => {
    const h = boot({ interactions: { mode: "ask", timeoutMs: 80 }, script: asking([perm()]) });
    const { events } = await h.server.stream({ text: "do it", contextId: "ctx" });
    const taskId = taskIdOf(events);
    await until(() => h.backend.replies.length === 1, 2000, "the expiry");
    expect(h.backend.replies[0]).toMatchObject({ reply: "reject" });
    await sleep(50);
    expect(summarizeTask(await h.server.getTask(taskId)).state).toBe("failed");
  });

  it("a request answered elsewhere (a rejection cancels every pending request of the session) withdraws the ask: no second reply", async () => {
    const h = boot({ interactions: ask, script: asking([perm("p1"), perm("p2")], 1) });
    const { events } = await h.server.stream({ text: "do it", contextId: "ctx" });
    const taskId = taskIdOf(events);
    const prompt = inputRequired(events)!;
    // the server drops p2 when someone rejects it in the TUI: it says so with a `replied` event
    h.backend.emit({ type: "permission.replied", properties: { sessionID: "ses_1", requestID: "p2", reply: "reject" } });
    await sleep(30);
    await h.server.send({ text: `1 ${prompt.code}`, contextId: "ctx", taskId });
    await sleep(30);
    expect(h.backend.replies.map((r) => r.id)).toEqual(["p1"]); // p2 was withdrawn, never replied to by us
  });

  it("pending requests of another session are not ours to answer", async () => {
    const h = boot({ script: asking([], 0) });
    h.backend.pendingPermissions = [{ id: "other", sessionID: "ses_99", permission: "bash", patterns: [], metadata: {}, always: [] }, { id: "mine", sessionID: "ses_1", permission: "bash", patterns: [], metadata: {}, always: [] }];
    await h.server.stream({ text: "do it", contextId: "ctx" });
    expect(h.backend.replies.map((r) => r.id)).toEqual(["mine"]);
  });

  it("the prompt timeout does not run while a person decides", async () => {
    ctx.config.timeouts.prompt = 120;
    const h = boot({ interactions: ask, script: asking([perm()]) });
    const { events } = await h.server.stream({ text: "do it", contextId: "ctx" });
    const prompt = inputRequired(events)!;
    await sleep(400); // longer than the prompt timeout
    const done = await h.server.send({ text: `1 ${prompt.code}`, contextId: "ctx", taskId: taskIdOf(events) });
    expect(stateName(done.status.state)).toBe("completed");
    expect(JSON.stringify(summarizeTask(done))).toContain("finished");
  });
});

describe("ask mode: questions reach the client", () => {
  const ask = { mode: "ask", timeoutMs: 60_000 } as const;

  it("a question becomes a question interaction; the picked option goes back as the answer", async () => {
    const h = boot({ interactions: ask, script: asking([question()]) });
    const { events } = await h.server.stream({ text: "do it", contextId: "ctx" });
    const p = inputRequired(events)!;
    expect(p.data.interaction).toMatchObject({
      kind: "question",
      questions: [{ id: "q0", header: "Fruit", prompt: "Which fruit?", options: [{ id: "0", label: "Apple" }, { id: "1", label: "Banana" }], allowFreeform: true }],
    });
    const done = await h.server.send({
      parts: dataReply({ interactionId: p.data.interactionId, outcome: "answered", answers: { q0: { optionIds: ["1"] } } }),
      contextId: "ctx",
      taskId: taskIdOf(events),
    } as never);
    expect(stateName(done.status.state)).toBe("completed");
    expect(h.backend.replies).toEqual([{ kind: "question", id: "que_1", answers: [["Banana"]] }]);
  });

  it("free text wins over options; a declined question is rejected on the server", async () => {
    const a = boot({ interactions: ask, script: asking([question()]) });
    const first = await a.server.stream({ text: "do it", contextId: "ctx" });
    const p = inputRequired(first.events)!;
    await a.server.send({ parts: dataReply({ interactionId: p.data.interactionId, outcome: "answered", answers: { q0: { freeText: "Mango" } } }), contextId: "ctx", taskId: taskIdOf(first.events) } as never);
    expect(a.backend.replies).toEqual([{ kind: "question", id: "que_1", answers: [["Mango"]] }]);

    const b = boot({ interactions: ask, script: asking([question()]) });
    const second = await b.server.stream({ text: "do it", contextId: "ctx" });
    const q = inputRequired(second.events)!;
    await b.server.send({ parts: dataReply({ interactionId: q.data.interactionId, declined: true }), contextId: "ctx", taskId: taskIdOf(second.events) } as never);
    expect(b.backend.replies).toEqual([{ kind: "question", id: "que_1", rejected: true }]);
  });

  it("works the same against a 2.x server (the client turns a form into a question)", async () => {
    const h = boot({ kind: "v2", interactions: ask, script: asking([perm()]) });
    const { events } = await h.server.stream({ text: "do it", contextId: "ctx" });
    expect(inputRequired(events)).toBeDefined();
  });
});

describe("the mapping", () => {
  it("permissionInteraction describes the request: tool, resources, what `always` saves, and the three options", () => {
    const i = permissionInteraction({ id: "p", sessionID: "s", permission: "edit", patterns: ["src/a.ts"], metadata: {}, always: ["src/*"] } as never) as any;
    expect(i).toMatchObject({ kind: "permission", title: "Allow edit?", subject: { tool: "edit", action: "edit", risk: "high", resources: ["src/a.ts"] }, options: [ONCE, ALWAYS, REJECT] });
    expect(i.description).toContain("src/*");
    expect((permissionInteraction({ id: "p", sessionID: "s", permission: "read", patterns: [], metadata: {}, always: [] } as never) as any).subject).toMatchObject({ action: "read", risk: "low" });
    expect((permissionInteraction({ id: "p", sessionID: "s", permission: "mcp", patterns: [], metadata: {}, always: [] } as never) as any).subject).toMatchObject({ action: "mcp" });
  });

  it("only an explicit selection of an allow option approves; everything else rejects with a message", () => {
    expect(permissionReply({ outcome: "selected", optionId: "once", by: { id: "u", kind: "user" } })).toEqual({ reply: "once" });
    expect(permissionReply({ outcome: "selected", optionId: "always", by: { id: "u", kind: "user" } })).toEqual({ reply: "always" });
    expect(permissionReply({ outcome: "selected", optionId: "reject", feedback: "no", by: { id: "u", kind: "user" } })).toEqual({ reply: "reject", message: "no" });
    for (const outcome of ["declined", "dismissed", "canceled", "expired", "withdrawn"] as const) {
      expect(permissionReply({ outcome } as never).reply).toBe("reject");
    }
    expect(permissionReply({ outcome: "unavailable", reason: "x" })).toEqual({ reply: "reject", message: UNAVAILABLE_MESSAGE });
  });

  it("nobodyWasAsked reads the typed code, not the text", () => {
    expect(nobodyWasAsked({ outcome: "unavailable", reason: "whatever", code: "policy-auto" })).toBe(true);
    expect(nobodyWasAsked({ outcome: "unavailable", reason: "whatever", code: "interactions-disabled" })).toBe(true);
    expect(nobodyWasAsked({ outcome: "unavailable", reason: "malformed", code: "invalid-request" })).toBe(false);
    expect(nobodyWasAsked({ outcome: "unavailable", reason: "nobody is asked" })).toBe(false);
    expect(nobodyWasAsked({ outcome: "canceled" })).toBe(false);
  });

  it("the wrapper's own answers when nobody is asked", () => {
    expect(legacyPermissionReply(true)).toBe("always");
    expect(legacyPermissionReply(false)).toBe("reject");
    expect(legacyQuestionAnswers({ id: "q", sessionID: "s", questions: [{ question: "a", header: "h", options: [{ label: "x", description: "" }] }, { question: "b", header: "h", options: [] }] } as never)).toEqual([["x"], [""]]);
  });

  it("questionAnswers maps options to labels, several picks to several labels, nothing to undefined", () => {
    const req = { id: "q", sessionID: "s", questions: [{ question: "a", header: "h", options: [{ label: "x" }, { label: "y" }], multiple: true }] } as never;
    expect(questionAnswers({ outcome: "answered", answers: { q0: { optionIds: ["0", "1"] } }, by: { id: "u", kind: "user" } }, req)).toEqual([["x", "y"]]);
    expect(questionAnswers({ outcome: "answered", answers: {}, by: { id: "u", kind: "user" } }, req)).toEqual([[]]);
    expect(questionAnswers({ outcome: "declined", by: { id: "u", kind: "user" } }, req)).toBeUndefined();
    const i = questionInteraction({ id: "q", sessionID: "s", questions: [{ question: "a", header: "", options: [], custom: false }] } as never) as any;
    expect(i.questions[0]).toMatchObject({ allowFreeform: false });
  });

  it("interactionPolicyOf passes on only what the operator set", () => {
    ctx.config.interactions = { mode: "ask", timeoutMs: 5, onTimeout: "deny", autoAnswer: [{ match: { tool: "read" }, answer: { kind: "allow_once" } }] };
    expect(interactionPolicyOf(ctx.config)).toEqual({ mode: "ask", timeoutMs: 5, onTimeout: "deny", autoAnswer: [{ match: { tool: "read" }, answer: { kind: "allow_once" } }] });
    ctx.config.interactions = undefined as never;
    expect(interactionPolicyOf(ctx.config)).toEqual({});
  });
});
