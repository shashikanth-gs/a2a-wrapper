/**
 * Permission requests and `AskUserQuestion` through core's interactions.
 *
 * Default (`interactions.mode: "auto"`, no rules): `canUseTool` is not installed at all, so the CLI behaves exactly as before
 * (`claude.permissionMode` decides, nobody is asked). With rules or `ask` it is installed: rules answer what they match, and
 * `ask` sends what no rule answers to the A2A client as `input-required`; the SDK's callback resumes on the reply. Only an
 * explicit allow approves; everything else denies, and the model is told.
 */

import { describe, expect, it, vi } from "vitest";
import { stateName, summarizeEvent } from "@a2a-wrapper/core";
import { interactionPolicyOf } from "../server/index.js";
import {
  UNAVAILABLE_MESSAGE,
  nobodyWasAsked,
  permissionInteraction,
  permissionResult,
  questionInteraction,
  questionItems,
  questionResult,
} from "../claude/interactions.js";
import type { CanUseToolLike } from "../claude/client-factory.js";
import { init, result, text, type ManualQuery } from "./helpers/manual-client.js";
import { serveManual, until, useWorkspace } from "./helpers/harness.js";
import type { InteractionsConfig } from "../config/types.js";

const ctx = useWorkspace();

function boot(interactions?: InteractionsConfig, permissionMode: "default" | "acceptEdits" = "default") {
  if (interactions) ctx.config.interactions = interactions;
  ctx.config.claude.permissionMode = permissionMode;
  return serveManual(ctx.config);
}
type H = ReturnType<typeof boot>;

const bashInput = { command: "echo hi > perm.txt", description: "Create perm.txt" };
const sdkOpts = (over: Record<string, unknown> = {}) => ({ signal: new AbortController().signal, toolUseID: "tu1", description: "Create perm.txt", ...over });

/** Start a task and wait until the CLI has its prompt; hand back the callback the SDK would call. */
async function running(h: H) {
  const live = h.server.startStream({ text: "do it", contextId: "ctx" });
  await until(() => h.client.queries.length === 1 && h.client.queries[0].inputs.length === 1);
  const q = h.client.queries[0];
  q.emit(init("sess-1"));
  await until(() => live.events.length >= 2);
  const taskId = (live.events[0] as any).payload.value.id as string;
  return { live, q, taskId, canUseTool: q.options.canUseTool as CanUseToolLike | undefined };
}

const finish = (q: ManualQuery) => q.emit(text("done"), result("done"));

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

describe("default policy (auto): the headless behaviour is unchanged", () => {
  it("installs no canUseTool, so the CLI behaves exactly as before", async () => {
    const h = boot(undefined, "acceptEdits");
    const { live, q, canUseTool } = await running(h);
    expect(canUseTool).toBeUndefined();
    expect(q.options.permissionMode).toBe("acceptEdits");
    finish(q);
    const { events } = await live.done;
    expect(inputRequired(events)).toBeUndefined();
    expect(summarizeEvent(events.at(-1))).toMatchObject({ state: "completed" });
  });

  it("an explicit auto mode with no rules is the same", async () => {
    const h = boot({ mode: "auto" }, "acceptEdits");
    const { live, q, canUseTool } = await running(h);
    expect(canUseTool).toBeUndefined();
    finish(q);
    await live.done;
  });

  it("autoAnswer rules install it: the rule answers what it matches, the rest is denied (nobody is asked)", async () => {
    const h = boot({ mode: "auto", autoAnswer: [{ match: { tool: "Bash", risk: "high" }, answer: { kind: "allow_once" } }, { match: { tool: "Write" }, answer: { decline: true } }] });
    const { live, q, canUseTool } = await running(h);
    expect(canUseTool).toBeTypeOf("function");

    expect(await canUseTool!("Bash", bashInput, sdkOpts())).toEqual({ behavior: "allow", updatedInput: bashInput });
    expect(await canUseTool!("Write", { file_path: "/w/a.txt" }, sdkOpts())).toMatchObject({ behavior: "deny" });
    // no rule: policy `auto` means nobody is asked; the request is denied, as the CLI's headless handling would
    expect(await canUseTool!("WebFetch", { url: "https://x" }, sdkOpts())).toEqual({ behavior: "deny", message: UNAVAILABLE_MESSAGE });
    finish(q);
    const { events } = await live.done;
    expect(inputRequired(events)).toBeUndefined();
  });
});

describe("ask mode: permission requests reach the client", () => {
  const ask = { mode: "ask", timeoutMs: 60_000 } as const;

  it("parks the task as input-required (stream ends), and an allow reply resumes the SDK callback", async () => {
    const h = boot(ask);
    const { live, q, taskId, canUseTool } = await running(h);
    const decision = canUseTool!("Bash", bashInput, sdkOpts());

    const { events } = await live.done; // the stream ends at input-required
    const prompt = inputRequired(events)!;
    expect(prompt.text).toContain("Create perm.txt");
    expect(prompt.data.interaction).toMatchObject({ kind: "permission", subject: { tool: "Bash", action: "execute", command: "echo hi > perm.txt", risk: "high" } });
    expect(prompt.data.interaction.options.map((o: any) => o.kind)).toEqual(["allow_once", "reject_once"]);
    expect(prompt.code).toMatch(/^[A-Z0-9]{4}$/);

    const reply = h.server.send({ text: `1 ${prompt.code}`, contextId: "ctx", taskId });
    expect(await decision).toEqual({ behavior: "allow", updatedInput: bashInput });
    finish(q);
    expect(stateName((await reply).status.state)).toBe("completed");
  });

  it("a deny reply tells the model: with the client's feedback in a structured reply", async () => {
    const h = boot(ask);
    const { live, q, taskId, canUseTool } = await running(h);
    const decision = canUseTool!("Bash", bashInput, sdkOpts());
    await live.done;

    const reply1 = h.server.send({ text: "no", contextId: "ctx", taskId });
    expect(await decision).toEqual({ behavior: "deny", message: "The user denied this request." });
    const decision2 = canUseTool!("Bash", bashInput, sdkOpts());
    const second = await reply1;
    expect(stateName(second.status.state)).toBe("input-required");
    const parts = second.status.message.parts.map((p: any) => p.content?.value);
    const data = parts.find((v: any) => v && typeof v === "object");

    const reply2 = h.server.send({ contextId: "ctx", taskId, parts: dataReply({ interactionId: data.interactionId, optionId: "reject", feedback: "not in this directory" }) });
    expect(await decision2).toEqual({ behavior: "deny", message: "not in this directory" });
    finish(q);
    expect(stateName((await reply2).status.state)).toBe("completed");
  });

  it("canceling the task denies a pending request and tells the SDK to stop (interrupt)", async () => {
    const h = boot(ask);
    const { live, taskId, canUseTool } = await running(h);
    const decision = canUseTool!("Bash", bashInput, sdkOpts());
    await live.done;
    await h.server.cancel(taskId);
    expect(await decision).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("a request the SDK withdraws (its signal aborts: the turn was interrupted) ends withdrawn, not approved", async () => {
    const h = boot(ask);
    const { live, canUseTool } = await running(h);
    const ac = new AbortController();
    const decision = canUseTool!("Bash", bashInput, sdkOpts({ signal: ac.signal }));
    await live.done;
    ac.abort();
    expect(await decision).toEqual({ behavior: "deny", message: "The request was withdrawn." });
  });

  it("an expired request fails the task and denies without approving", async () => {
    const h = boot({ mode: "ask", timeoutMs: 30, onTimeout: "fail" });
    const { live, taskId, canUseTool } = await running(h);
    const decision = canUseTool!("Bash", bashInput, sdkOpts());
    await live.done;
    expect(await decision).toMatchObject({ behavior: "deny" });
    await vi.waitFor(async () => expect(stateName((await h.server.getTask(taskId)).status.state)).toBe("failed"));
  });

  it("with onTimeout deny the task goes on and the request is denied", async () => {
    const h = boot({ mode: "ask", timeoutMs: 30, onTimeout: "deny" });
    const { live, q, taskId, canUseTool } = await running(h);
    const decision = canUseTool!("Bash", bashInput, sdkOpts());
    await live.done;
    expect(await decision).toEqual({ behavior: "deny", message: "Nobody answered this request in time, so it was denied." });
    finish(q);
    await vi.waitFor(async () => expect(stateName((await h.server.getTask(taskId)).status.state)).toBe("completed"));
  });

  it("an autoAnswer rule answers without asking: low risk is allowed, a shell command still goes to the client", async () => {
    const h = boot({ mode: "ask", autoAnswer: [{ match: { risk: "low" }, answer: { kind: "allow_once" } }] });
    const { live, canUseTool } = await running(h);
    expect(await canUseTool!("Read", { file_path: "/etc/hosts" }, sdkOpts())).toEqual({ behavior: "allow", updatedInput: { file_path: "/etc/hosts" } });
    void canUseTool!("Bash", bashInput, sdkOpts());
    const { events } = await live.done;
    expect(inputRequired(events)?.text).toContain("Create perm.txt");
  });

  it("the prompt timeout does not run while a person decides, and starts again afterwards", async () => {
    ctx.config.timeouts.prompt = 120;
    const h = boot(ask);
    const { live, q, taskId, canUseTool } = await running(h);
    const decision = canUseTool!("Bash", bashInput, sdkOpts());
    const { events } = await live.done;
    await new Promise((r) => setTimeout(r, 250)); // longer than the prompt timeout: the task must not fail meanwhile
    const prompt = inputRequired(events)!;
    const reply = h.server.send({ text: `1 ${prompt.code}`, contextId: "ctx", taskId });
    expect(await decision).toMatchObject({ behavior: "allow" });
    finish(q);
    expect(stateName((await reply).status.state)).toBe("completed");
  });
});

describe("ask mode: AskUserQuestion", () => {
  const ask = { mode: "ask", timeoutMs: 60_000 } as const;
  const input = {
    questions: [
      { question: "Which colour do you prefer?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] },
    ],
  };

  it("becomes a question interaction and the answer goes back by question text with the questions", async () => {
    const h = boot(ask);
    const { live, q, taskId, canUseTool } = await running(h);
    const decision = canUseTool!("AskUserQuestion", input, sdkOpts());
    const prompt = inputRequired((await live.done).events)!;
    expect(prompt.data.interaction).toMatchObject({
      kind: "question",
      questions: [{ id: "q0", header: "Colour", prompt: "Which colour do you prefer?", options: [{ id: "0", label: "Red" }, { id: "1", label: "Blue" }], allowFreeform: true }],
    });

    const reply = h.server.send({ contextId: "ctx", taskId, parts: dataReply({ interactionId: prompt.data.interactionId, answers: { q0: { optionIds: ["1"] } } }) });
    expect(await decision).toEqual({ behavior: "allow", updatedInput: { questions: input.questions, answers: { "Which colour do you prefer?": "Blue" } } });
    finish(q);
    await reply;
  });

  it("a free-text answer wins over options; a multi-select joins the labels; an unanswered question is empty", async () => {
    const items = questionItems({
      questions: [
        { question: "A?", options: [{ label: "x" }, { label: "y" }, { label: "z" }], multiSelect: true },
        { question: "B?", options: [{ label: "p" }, { label: "q" }] },
        { question: "C?", options: [{ label: "m" }] },
      ],
    })!;
    const by = { id: "u", kind: "user" };
    const r = questionResult(
      { outcome: "answered", answers: { q0: { optionIds: ["0", "2"] }, q1: { optionIds: ["0"], freeText: "something else" } }, by },
      { questions: [] },
      items,
    );
    expect(r).toMatchObject({ behavior: "allow", updatedInput: { answers: { "A?": "x, z", "B?": "something else", "C?": "" } } });
  });

  it("nobody answering denies the tool call (the model is told); a canceled task interrupts", () => {
    const items = questionItems(input)!;
    expect(questionResult({ outcome: "expired" }, input, items)).toEqual({ behavior: "deny", message: "The user did not answer the question." });
    expect(questionResult({ outcome: "unavailable", reason: "x" }, input, items)).toMatchObject({ behavior: "deny" });
    expect(questionResult({ outcome: "canceled" }, input, items)).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("a malformed AskUserQuestion input is treated as an ordinary permission request", () => {
    expect(questionItems({ questions: [] })).toBeUndefined();
    expect(questionItems({ questions: [{ nope: 1 }] })).toBeUndefined();
    expect(questionItems({})).toBeUndefined();
  });
});

describe("the mapping", () => {
  it("tool calls become permission interactions with a risk and subject for rules to match", () => {
    expect(permissionInteraction("Bash", bashInput, sdkOpts())).toMatchObject({
      kind: "permission",
      title: "Use Bash",
      description: "Create perm.txt",
      subject: { tool: "Bash", action: "execute", command: "echo hi > perm.txt", risk: "high" },
    });
    expect(permissionInteraction("Write", { file_path: "/w/a.txt" }, sdkOpts({ title: "Claude wants to write /w/a.txt", description: undefined }))).toMatchObject({
      title: "Claude wants to write /w/a.txt",
      subject: { tool: "Write", action: "edit", resources: ["/w/a.txt"], risk: "high" },
    });
    expect(permissionInteraction("Read", { file_path: "/etc/hosts" }, sdkOpts())).toMatchObject({ subject: { action: "read", resources: ["/etc/hosts"], risk: "low" } });
    expect(permissionInteraction("WebFetch", { url: "https://x" }, sdkOpts())).toMatchObject({ subject: { action: "fetch", resources: ["https://x"], risk: "medium" } });
    expect(permissionInteraction("mcp__probe__secret_word", {}, sdkOpts())).toMatchObject({ subject: { tool: "mcp__probe__secret_word", action: "mcp", risk: "medium" } });
    expect(permissionInteraction("ExitPlanMode", { plan: "1. do it" }, sdkOpts({ description: undefined }))).toMatchObject({ description: "1. do it" });
    expect(permissionInteraction("Bash", bashInput, sdkOpts({ blockedPath: "/etc/passwd" }))).toMatchObject({ subject: { resources: ["/etc/passwd"] } });
  });

  it("only an explicit allow approves; everything else denies, and the model is told why", () => {
    const by = { id: "u", kind: "user" };
    const input = { a: 1 };
    expect(permissionResult({ outcome: "selected", optionId: "allow", by }, input)).toEqual({ behavior: "allow", updatedInput: input });
    expect(permissionResult({ outcome: "selected", optionId: "reject", feedback: "no", by }, input)).toEqual({ behavior: "deny", message: "no" });
    expect(permissionResult({ outcome: "selected", optionId: "something-else", by }, input)).toMatchObject({ behavior: "deny" });
    expect(permissionResult({ outcome: "declined", by }, input)).toMatchObject({ behavior: "deny" });
    expect(permissionResult({ outcome: "dismissed" }, input)).toMatchObject({ behavior: "deny" });
    expect(permissionResult({ outcome: "expired" }, input)).toMatchObject({ behavior: "deny" });
    expect(permissionResult({ outcome: "withdrawn" }, input)).toMatchObject({ behavior: "deny" });
    expect(permissionResult({ outcome: "canceled" }, input)).toMatchObject({ behavior: "deny", interrupt: true });
    for (const code of ["policy-auto", "interactions-disabled", "invalid-request", "internal", "something-new"]) {
      expect(permissionResult({ outcome: "unavailable", reason: "x", code }, input)).toEqual({ behavior: "deny", message: UNAVAILABLE_MESSAGE });
    }
    expect(nobodyWasAsked({ outcome: "unavailable", reason: "x", code: "policy-auto" })).toBe(true);
    expect(nobodyWasAsked({ outcome: "unavailable", reason: "x", code: "internal" })).toBe(false);
  });

  it("questions: one core question per SDK question with the options; a header is kept", () => {
    const q = questionInteraction(questionItems({ questions: [{ question: "Pick?", header: "H", multiSelect: true, options: [{ label: "a", description: "da" }, { label: "b" }] }] })!);
    expect(q).toMatchObject({
      kind: "question",
      title: "Pick?",
      questions: [{ id: "q0", header: "H", prompt: "Pick?", multi: true, allowFreeform: true, options: [{ id: "0", label: "a", description: "da" }, { id: "1", label: "b" }] }],
    });
  });

  it("the config section becomes core's policy (only what the operator set)", () => {
    expect(interactionPolicyOf(ctx.config ?? ({} as never))).toEqual({});
    const c = { ...(ctx.config ?? {}), interactions: { mode: "ask", timeoutMs: 5, onTimeout: "deny", autoAnswer: [{ match: {}, answer: { kind: "allow_once" } }] } } as never;
    expect(interactionPolicyOf(c)).toEqual({ mode: "ask", timeoutMs: 5, onTimeout: "deny", autoAnswer: [{ match: {}, answer: { kind: "allow_once" } }] });
  });
});
