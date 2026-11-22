/**
 * Requests of the sub-sessions OpenCode creates for a task (its `task` tool) belong to the task: they carry the CHILD session id,
 * so a turn decides by the session's `parentID` chain (bounded, cycle-safe) whether it is its own. Own and child requests go
 * through `run.ask` exactly like the task's, tagged with the sub-agent, and are answered on the child's request id. A chain that
 * cannot be resolved is denied in ask mode (never approved); requests of unrelated sessions are ignored.
 */

import { describe, expect, it } from "vitest";
import { stateName } from "@a2a-wrapper/core";
import { FakeBackend, assistant, idle, text, type Script } from "./helpers/fake-backend.js";
import { serve, useConfig } from "./helpers/harness.js";
import { MAX_SESSION_DEPTH } from "../opencode/turn.js";
import type { InteractionsConfig } from "../config/types.js";

const ctx = useConfig();

const perm = (id: string, sessionID: string) => ({
  type: "permission.asked",
  properties: { id, sessionID, permission: "bash", patterns: ["echo hi"], metadata: { command: "echo hi" }, always: [] },
});
const question = (id: string, sessionID: string) => ({
  type: "question.asked",
  properties: { id, sessionID, questions: [{ question: "Which?", header: "H", options: [{ label: "A" }, { label: "B" }], multiple: false, custom: true }] },
});

const asking = (events: unknown[], n: number): Script => async ({ emit, backend, sleep: nap, sessionId }) => {
  emit(assistant("m1", {}, sessionId));
  for (const e of events) emit(e);
  const t0 = Date.now();
  while (backend.replies.length < n && Date.now() - t0 < 3000) await nap(5);
  emit(text("finished", sessionId));
  emit(idle(sessionId));
};

function boot(kind: "v1" | "v2", interactions: InteractionsConfig | undefined, script: Script, setup?: (b: FakeBackend) => void) {
  ctx.config.interactions = interactions as never;
  const backend = new FakeBackend({ kind, scripts: [script] });
  backend.sessions.set("ses_c1", { id: "ses_c1", title: "Explore (@explore subagent)" });
  backend.parents.set("ses_c1", "ses_1");
  setup?.(backend);
  return serve(ctx.config, backend);
}

function inputRequired(events: any[]) {
  const e = events.find((x: any) => x.payload.$case === "statusUpdate" && stateName(x.payload.value.status.state) === "input-required");
  if (!e) return undefined;
  const parts = e.payload.value.status.message.parts;
  const t = parts.map((p: any) => p.content?.value).find((v: any) => typeof v === "string") as string;
  const data = parts.map((p: any) => p.content?.value).find((v: any) => v && typeof v === "object")!;
  return { text: t, data, code: /`\d+ ([A-Z0-9]{4})`/.exec(t)?.[1] };
}
const taskIdOf = (events: any[]) => (events[0] as any).payload.value.id as string;
const ask = { mode: "ask", timeoutMs: 60_000 } as const;

for (const kind of ["v1", "v2"] as const) {
  describe(`sub-session requests (${kind} server)`, () => {
    it("a child's permission request is asked through core, tagged with the sub-agent, and answered on the child's request id", async () => {
      const h = boot(kind, ask, asking([perm("per_c", "ses_c1")], 1));
      const { events } = await h.server.stream({ text: "go", contextId: "ctx" });
      const p = inputRequired(events)!;
      expect(p).toBeDefined();
      expect(p.data.interaction.title).toContain("sub-agent");
      expect(p.data.interaction.title).toContain("Explore");
      expect(p.data.interaction.subject.detail.subSession).toEqual({ id: "ses_c1", title: "Explore (@explore subagent)" });
      expect(h.backend.replies).toEqual([]);

      const done = await h.server.send({ text: `1 ${p.code}`, contextId: "ctx", taskId: taskIdOf(events) });
      expect(stateName(done.status.state)).toBe("completed");
      expect(h.backend.replies).toEqual([{ kind: "permission", id: "per_c", reply: "once" }]);
    });

    it("a deny reaches the child's request too", async () => {
      const h = boot(kind, ask, asking([perm("per_c", "ses_c1")], 1));
      const { events } = await h.server.stream({ text: "go", contextId: "ctx" });
      await h.server.send({ text: "no", contextId: "ctx", taskId: taskIdOf(events) });
      expect(h.backend.replies[0]).toMatchObject({ id: "per_c", reply: "reject" });
    });

    it("a child's question is asked through core and answered", async () => {
      const h = boot(kind, ask, asking([question("que_c", "ses_c1")], 1));
      const { events } = await h.server.stream({ text: "go", contextId: "ctx" });
      const q = inputRequired(events)!;
      expect(q.data.interaction.title).toContain("sub-agent");
      await h.server.send({
        parts: [{ content: { $case: "data", value: { interactionId: q.data.interactionId, outcome: "answered", answers: { q0: { optionIds: ["1"] } } } }, metadata: undefined, filename: "", mediaType: "application/json" }],
        contextId: "ctx",
        taskId: taskIdOf(events),
      } as never);
      expect(h.backend.replies).toEqual([{ kind: "question", id: "que_c", answers: [["B"]] }]);
    });

    it("a grandchild is followed up the parent chain to the task's session", async () => {
      const h = boot(kind, ask, asking([perm("per_g", "ses_g")], 1), (b) => {
        b.sessions.set("ses_g", { id: "ses_g", title: "Deep" });
        b.parents.set("ses_g", "ses_c1");
      });
      const { events } = await h.server.stream({ text: "go", contextId: "ctx" });
      expect(inputRequired(events)).toBeDefined();
    });

    it("a chain deeper than the bound cannot be confirmed: denied in ask mode, never approved", async () => {
      const h = boot(kind, ask, asking([perm("per_d", "d0")], 1), (b) => {
        for (let i = 0; i <= MAX_SESSION_DEPTH; i++) {
          b.sessions.set(`d${i}`, { id: `d${i}`, title: `d${i}` });
          b.parents.set(`d${i}`, i === MAX_SESSION_DEPTH ? "ses_1" : `d${i + 1}`);
        }
      });
      const { events } = await h.server.stream({ text: "go", contextId: "ctx" });
      expect(inputRequired(events)).toBeUndefined();
      expect(h.backend.replies).toMatchObject([{ id: "per_d", reply: "reject" }]);
    });

    it("a chain exactly at the bound is still routed", async () => {
      const h = boot(kind, ask, asking([perm("per_d", "d0")], 1), (b) => {
        for (let i = 0; i < MAX_SESSION_DEPTH; i++) {
          b.sessions.set(`d${i}`, { id: `d${i}`, title: `d${i}` });
          b.parents.set(`d${i}`, i === MAX_SESSION_DEPTH - 1 ? "ses_1" : `d${i + 1}`);
        }
      });
      const { events } = await h.server.stream({ text: "go", contextId: "ctx" });
      expect(inputRequired(events)).toBeDefined();
    });

    it("a parent chain that cannot be looked up is denied in ask mode (the model is told) and keeps today's answer in auto mode", async () => {
      const a = boot(kind, ask, asking([perm("per_u", "ses_c1")], 1), (b) => b.failLookup.add("ses_c1"));
      const first = await a.server.stream({ text: "go", contextId: "ctx" });
      expect(inputRequired(first.events)).toBeUndefined();
      expect(a.backend.replies).toMatchObject([{ id: "per_u", reply: "reject", message: expect.stringContaining("could not be matched") }]);

      const b = boot(kind, undefined, asking([perm("per_u", "ses_c1"), question("que_u", "ses_c1")], 2), (x) => x.failLookup.add("ses_c1"));
      await b.server.stream({ text: "go", contextId: "ctx" });
      expect(b.backend.replies).toEqual([{ kind: "permission", id: "per_u", reply: "always" }, { kind: "question", id: "que_u", answers: [["A"]] }]);
    });

    it("an unrelated session's request is ignored (not asked, not answered)", async () => {
      const h = boot(kind, ask, asking([perm("per_x", "ses_other"), question("que_x", "ses_other")], 0), (b) => {
        b.sessions.set("ses_other", { id: "ses_other", title: "someone else" });
        b.sessions.set("ses_p", { id: "ses_p", title: "parent" });
        b.parents.set("ses_other", "ses_p"); // a chain that ends elsewhere
      });
      const { events } = await h.server.stream({ text: "go", contextId: "ctx" });
      expect(inputRequired(events)).toBeUndefined();
      expect(h.backend.replies).toEqual([]);
    });

    it("a parent cycle ends the walk instead of looping", async () => {
      const h = boot(kind, ask, asking([perm("per_y", "ses_a")], 0), (b) => {
        b.sessions.set("ses_a", { id: "ses_a" });
        b.sessions.set("ses_b", { id: "ses_b" });
        b.parents.set("ses_a", "ses_b");
        b.parents.set("ses_b", "ses_a");
      });
      const { events } = await h.server.stream({ text: "go", contextId: "ctx" });
      expect(stateName((events.at(-1) as any).payload.value.status.state)).toBe("completed");
      expect(h.backend.replies).toEqual([]);
    });

    it("the start-up poll routes a child's pending request and leaves an unrelated one alone", async () => {
      const h = boot(kind, undefined, asking([], 1), (b) => {
        b.sessions.set("ses_other", { id: "ses_other" });
        b.pendingPermissions = [
          { id: "pc", sessionID: "ses_c1", permission: "bash", patterns: [], metadata: {}, always: [] },
          { id: "px", sessionID: "ses_other", permission: "bash", patterns: [], metadata: {}, always: [] },
        ];
      });
      await h.server.stream({ text: "go", contextId: "ctx" });
      expect(h.backend.replies.map((r) => r.id)).toEqual(["pc"]);
    });
  });
}
