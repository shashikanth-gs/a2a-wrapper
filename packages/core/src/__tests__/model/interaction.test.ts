/** Interaction rendering, reply parsing and the "unknown never approves" rule. */
import { describe, it, expect } from "vitest";
import { TaskState, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import {
  INTERACTION_EXTENSION_URI,
  fromA2APart,
  interactionPayload,
  interactionTaskState,
  isApproval,
  parseInteractionReply,
  renderInteraction,
  renderInteractionText,
  toInteractionStatusUpdate,
  type CoreCaller,
  type CoreInteraction,
  type CoreInteractionResult,
  type CorePart,
} from "../../index.js";

const by: CoreCaller = { id: "anonymous", kind: "anonymous" };

const permission: CoreInteraction = {
  id: "i1",
  kind: "permission",
  title: "Run a command?",
  subject: { tool: "bash", command: "rm -rf build", resources: ["./build"], risk: "high" },
  options: [
    { id: "o-allow", label: "Allow once", kind: "allow_once", scope: "call" },
    { id: "o-always", label: "Always allow", kind: "allow_always", scope: "project" },
    { id: "o-deny", label: "Reject", kind: "reject_once", allowsFeedback: true },
    { id: "o-never", label: "Never", kind: "reject_always" },
  ],
  meta: { providerSecret: "x" },
};

const question: CoreInteraction = {
  id: "q1",
  kind: "question",
  title: "Pick",
  questions: [
    { id: "color", prompt: "Which color?", options: [{ id: "r", label: "Red" }, { id: "b", label: "Blue", description: "cool" }] },
  ],
};

const multiQuestion: CoreInteraction = {
  id: "q2",
  kind: "question",
  title: "Pick",
  questions: [
    { id: "a", prompt: "Pick some", multi: true, options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
    { id: "b", prompt: "Name?", allowFreeform: true, secret: true },
  ],
};

const form: CoreInteraction = {
  id: "f1",
  kind: "form",
  title: "Details",
  schema: {
    type: "object",
    properties: { name: { type: "string", title: "Name" }, age: { type: "integer" }, ok: { type: "boolean" }, size: { type: "string", enum: ["s", "m"] } },
    required: ["name"],
  },
};

const auth: CoreInteraction = {
  id: "a1",
  kind: "auth",
  title: "Sign in",
  auth: { service: "GitHub", url: "https://example.test/login", userCode: "ABCD-1234", instructions: "Enter the code." },
};

describe("isApproval: unknown never approves (D5)", () => {
  it("approves only a selected allow_once / allow_always option that exists", () => {
    expect(isApproval(permission, { outcome: "selected", optionId: "o-allow", by })).toBe(true);
    expect(isApproval(permission, { outcome: "selected", optionId: "o-always", by })).toBe(true);
  });

  it("denies reject options, unknown option ids and unknown option kinds", () => {
    expect(isApproval(permission, { outcome: "selected", optionId: "o-deny", by })).toBe(false);
    expect(isApproval(permission, { outcome: "selected", optionId: "o-never", by })).toBe(false);
    expect(isApproval(permission, { outcome: "selected", optionId: "nope", by })).toBe(false);
    const odd = { options: [{ id: "x", label: "X", kind: "allow_forever" }, { id: "y", label: "Y", kind: "ALLOW_ONCE" }] };
    expect(isApproval(odd, { outcome: "selected", optionId: "x", by })).toBe(false);
    expect(isApproval(odd, { outcome: "selected", optionId: "y", by })).toBe(false);
  });

  it("denies every non-selected outcome, including ones this core does not know", () => {
    const outcomes: CoreInteractionResult[] = [
      { outcome: "declined", by },
      { outcome: "canceled" },
      { outcome: "expired" },
      { outcome: "unavailable", reason: "no client" },
      { outcome: "completed", by },
      { outcome: "answered", answers: {}, by },
      { outcome: "submitted", values: {}, by },
    ];
    for (const r of outcomes) expect(isApproval(permission, r)).toBe(false);
    expect(isApproval(permission, { outcome: "approved-by-future-core" })).toBe(false);
  });

  it("denies malformed and missing results, and interactions with no options", () => {
    expect(isApproval(permission, undefined)).toBe(false);
    expect(isApproval(permission, null)).toBe(false);
    expect(isApproval(permission, "selected" as any)).toBe(false);
    expect(isApproval(permission, { outcome: "selected" } as any)).toBe(false);
    expect(isApproval(permission, { outcome: "selected", optionId: 1 } as any)).toBe(false);
    expect(isApproval({}, { outcome: "selected", optionId: "o-allow", by })).toBe(false);
  });
});

describe("rendering", () => {
  it("auth interactions park the task in auth-required; everything else in input-required", () => {
    expect(interactionTaskState(auth)).toBe("auth-required");
    for (const i of [permission, question, form]) expect(interactionTaskState(i)).toBe("input-required");
    expect(interactionTaskState({ kind: "something-new" })).toBe("input-required");
    expect(interactionTaskState({ kind: "confirm" })).toBe("input-required");
  });

  it("renders a permission as text with numbered options and the subject", () => {
    const t = renderInteractionText(permission);
    expect(t).toContain("Run a command?");
    expect(t).toContain("Tool: bash");
    expect(t).toContain("Command: rm -rf build");
    expect(t).toContain("Risk: high");
    expect(t).toContain("1. Allow once");
    expect(t).toContain("4. Never");
  });

  it("renders questions, form fields and auth challenge details", () => {
    const q = renderInteractionText(multiQuestion);
    expect(q).toContain("Question 1: Pick some");
    expect(q).toContain("1. X");
    expect(q).toContain("comma separated");
    expect(q).toContain("secret");
    expect(renderInteractionText(question)).toContain("2. Blue - cool");
    const f = renderInteractionText(form);
    expect(f).toContain("- name (string, required): Name");
    expect(f).toContain("- age (integer)");
    const a = renderInteractionText(auth);
    expect(a).toContain("https://example.test/login");
    expect(a).toContain("ABCD-1234");
    expect(a).toContain("Enter the code.");
  });

  it("structured rendering is text first, then the data part, and sets the extension", () => {
    const r = renderInteraction(permission);
    expect(r.state).toBe("input-required");
    expect(r.parts).toHaveLength(2);
    expect(r.parts[0]).toEqual({ kind: "text", text: r.text });
    const data = r.parts[1] as Extract<CorePart, { kind: "data" }>;
    expect(data.kind).toBe("data");
    expect(data.mediaType).toBe("application/json");
    expect((data.data as any).interactionId).toBe("i1");
    expect((data.data as any).version).toBe(1);
    expect((data.data as any).interaction.options).toHaveLength(4);
    expect(r.extensions).toEqual([INTERACTION_EXTENSION_URI]);
  });

  it("text-only rendering for a client that did not activate the extension", () => {
    const r = renderInteraction(permission, { structured: false });
    expect(r.parts).toEqual([{ kind: "text", text: r.text }]);
    expect(r.extensions).toEqual([]);
    expect(r.text).toContain("1. Allow once");
  });

  it("never sends provider-internal meta on the wire", () => {
    expect(JSON.stringify(interactionPayload(permission))).not.toContain("providerSecret");
    expect((interactionPayload(permission).interaction as any).meta).toBeUndefined();
  });

  it("builds an SDK status update the codec accepts, for input and auth", () => {
    const ev = toInteractionStatusUpdate("t", "c", permission, { timestamp: "T" });
    expect(ev.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(ev.status?.message?.extensions).toEqual([INTERACTION_EXTENSION_URI]);
    const wire = TaskStatusUpdateEvent.fromJSON(JSON.parse(JSON.stringify(TaskStatusUpdateEvent.toJSON(ev))));
    const parts = wire.status!.message!.parts.map(fromA2APart);
    expect(parts[0]!.kind).toBe("text");
    expect((parts[1] as any).data.interactionId).toBe("i1");

    const a = toInteractionStatusUpdate("t", "c", auth);
    expect(a.status?.state).toBe(TaskState.TASK_STATE_AUTH_REQUIRED);
  });
});

describe("parseInteractionReply: structured", () => {
  const data = (d: unknown): CorePart[] => [{ kind: "data", data: d }];

  it("selects an option by id, with feedback", () => {
    const r = parseInteractionReply(permission, data({ interactionId: "i1", optionId: "o-deny", feedback: "too risky" }), by);
    expect(r).toEqual({ outcome: "selected", optionId: "o-deny", feedback: "too risky", by });
    expect(isApproval(permission, r)).toBe(false);
  });

  it("ignores a reply for a different interaction id (stale or unknown)", () => {
    expect(parseInteractionReply(permission, data({ interactionId: "old", optionId: "o-allow" }), by)).toBeUndefined();
    expect(parseInteractionReply(permission, [...data({ interactionId: "i1", optionId: "o-allow" }), ...data({ interactionId: "other", optionId: "x" })], by)).toBeUndefined();
  });

  it("ignores an unknown option id", () => {
    expect(parseInteractionReply(permission, data({ interactionId: "i1", optionId: "o-root" }), by)).toBeUndefined();
  });

  it("does not fall back to text when a structured part is present but invalid", () => {
    const parts: CorePart[] = [{ kind: "text", text: "approve" }, ...data({ interactionId: "i1", optionId: "bogus" })];
    expect(parseInteractionReply(permission, parts, by)).toBeUndefined();
  });

  it("accepts a valid answer map and rejects bad ones", () => {
    expect(parseInteractionReply(question, data({ interactionId: "q1", answers: { color: { optionIds: ["b"] } } }), by)).toEqual({
      outcome: "answered", answers: { color: { optionIds: ["b"] } }, by,
    });
    expect(parseInteractionReply(question, data({ interactionId: "q1", answers: { color: { optionIds: ["green"] } } }), by)).toBeUndefined();
    expect(parseInteractionReply(question, data({ interactionId: "q1", answers: { color: { optionIds: ["r", "b"] } } }), by)).toBeUndefined(); // not multi
    expect(parseInteractionReply(question, data({ interactionId: "q1", answers: { color: { text: "green" } } }), by)).toBeUndefined(); // no freeform
    expect(parseInteractionReply(question, data({ interactionId: "q1", answers: { other: { text: "x" } } }), by)).toBeUndefined();
    expect(parseInteractionReply(question, data({ interactionId: "q1", answers: {} }), by)).toBeUndefined(); // incomplete
    expect(parseInteractionReply(multiQuestion, data({ interactionId: "q2", answers: { a: { optionIds: ["x", "y"] }, b: { text: "n" } } }), by)).toMatchObject({ outcome: "answered" });
  });

  it("validates form values against the schema", () => {
    expect(parseInteractionReply(form, data({ interactionId: "f1", values: { name: "Al", age: 3, size: "m" } }), by)).toEqual({
      outcome: "submitted", values: { name: "Al", age: 3, size: "m" }, by,
    });
    for (const values of [{ age: 3 }, { name: 5 }, { name: "a", age: 1.5 }, { name: "a", ok: "yes" }, { name: "a", size: "xl" }, { name: "a", extra: 1 }]) {
      expect(parseInteractionReply(form, data({ interactionId: "f1", values }), by)).toBeUndefined();
    }
  });

  it("handles declined and auth completed", () => {
    expect(parseInteractionReply(form, data({ interactionId: "f1", declined: true, feedback: "no" }), by)).toEqual({ outcome: "declined", feedback: "no", by });
    expect(parseInteractionReply(auth, data({ interactionId: "a1", completed: true }), by)).toEqual({ outcome: "completed", by });
    expect(parseInteractionReply(permission, data({ interactionId: "i1", completed: true }), by)).toBeUndefined();
  });

  it("returns undefined for an empty structured payload", () => {
    expect(parseInteractionReply(permission, data({ interactionId: "i1" }), by)).toBeUndefined();
  });
});

describe("parseInteractionReply: text fallback", () => {
  const text = (t: string): CorePart[] => [{ kind: "text", text: t }];

  it("matches option number, id and label (case-insensitive)", () => {
    expect(parseInteractionReply(permission, text("1"), by)).toMatchObject({ outcome: "selected", optionId: "o-allow" });
    expect(parseInteractionReply(permission, text("  3 "), by)).toMatchObject({ optionId: "o-deny" });
    expect(parseInteractionReply(permission, text("always allow"), by)).toMatchObject({ optionId: "o-always" });
    expect(parseInteractionReply(permission, text("O-NEVER"), by)).toMatchObject({ optionId: "o-never" });
  });

  it("approve/allow/yes select allow_once only, never allow_always", () => {
    for (const w of ["approve", "Allow", "YES", "y"]) {
      expect(parseInteractionReply(permission, text(w), by)).toMatchObject({ optionId: "o-allow" });
    }
    const onlyAlways = { ...permission, options: [permission.options![1]!, permission.options![2]!] };
    expect(parseInteractionReply(onlyAlways, text("approve"), by)).toBeUndefined();
  });

  it("deny/reject/no select reject_once, else decline", () => {
    expect(parseInteractionReply(permission, text("no"), by)).toMatchObject({ outcome: "selected", optionId: "o-deny" });
    const noReject = { ...permission, options: [permission.options![0]!] };
    expect(parseInteractionReply(noReject, text("deny"), by)).toEqual({ outcome: "declined", by });
  });

  it("is undefined for out-of-range numbers, ambiguous or unrelated text", () => {
    for (const t of ["0", "9", "-1", "sure thing", "maybe", "", "   ", "approve it please"]) {
      expect(parseInteractionReply(permission, text(t), by)).toBeUndefined();
    }
    expect(parseInteractionReply(permission, [], by)).toBeUndefined();
  });

  it("a text reply never approves an interaction without an allow option", () => {
    const noAllow = { ...permission, options: [permission.options![2]!, permission.options![3]!] };
    expect(parseInteractionReply(noAllow, text("yes"), by)).toBeUndefined();
    expect(parseInteractionReply({ ...permission, options: undefined }, text("yes"), by)).toBeUndefined();
  });

  it("answers a single question by number, label or free text, and multi by list", () => {
    expect(parseInteractionReply(question, text("2"), by)).toEqual({ outcome: "answered", answers: { color: { optionIds: ["b"] } }, by });
    expect(parseInteractionReply(question, text("red"), by)).toEqual({ outcome: "answered", answers: { color: { optionIds: ["r"] } }, by });
    expect(parseInteractionReply(question, text("green"), by)).toBeUndefined(); // no freeform
    const single = { ...question, questions: [{ ...question.questions![0]!, allowFreeform: true }] };
    expect(parseInteractionReply(single, text("green"), by)).toEqual({ outcome: "answered", answers: { color: { text: "green" } }, by });
    const multi = { ...question, questions: [{ ...question.questions![0]!, multi: true }] };
    expect(parseInteractionReply(multi, text("1, blue"), by)).toEqual({ outcome: "answered", answers: { color: { optionIds: ["r", "b"] } }, by });
    expect(parseInteractionReply(multi, text("1, purple"), by)).toBeUndefined();
  });

  it("does not guess answers for several questions or forms from text", () => {
    expect(parseInteractionReply(multiQuestion, text("1"), by)).toBeUndefined();
    expect(parseInteractionReply(form, text("Alice"), by)).toBeUndefined();
    expect(parseInteractionReply(form, text("no"), by)).toEqual({ outcome: "declined", by });
  });

  it("completes an auth challenge on 'done'", () => {
    expect(parseInteractionReply(auth, text("done"), by)).toEqual({ outcome: "completed", by });
    expect(parseInteractionReply(auth, text("whatever"), by)).toBeUndefined();
  });

  it("ignores non-text parts when reading text", () => {
    expect(parseInteractionReply(permission, [{ kind: "file", uri: "x" }, { kind: "text", text: "1" }], by)).toMatchObject({ optionId: "o-allow" });
  });

  it("unknown interaction kinds only accept explicit option selection", () => {
    const odd: CoreInteraction = { id: "z", kind: "hologram", title: "?", options: [{ id: "a", label: "A", kind: "allow_once" }] };
    expect(parseInteractionReply(odd, text("approve"), by)).toMatchObject({ optionId: "a" }); // has an explicit allow option
    expect(parseInteractionReply({ id: "z", kind: "hologram", title: "?" }, text("approve"), by)).toBeUndefined();
  });
});
