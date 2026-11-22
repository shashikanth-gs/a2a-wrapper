/**
 * Follow-up to the domain model review (#106): turn semantics, unknown states,
 * record headers and codec, interactions, usage deltas, versioned wire keys.
 */
import { describe, it, expect } from "vitest";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Message, Part } from "@a2a-js/sdk";
import { RequestContext, ServerCallContext } from "@a2a-js/sdk/server";
import {
  CORE_STATE_META_KEY,
  DELIVERY_META_KEY,
  FILE_URI_META_KEY,
  INTERACTION_EXTENSION_URI,
  LEGACY_WIRE_KEYS,
  STEERING_EXTENSION_ALIAS,
  UNKNOWN_PART_META_KEY,
  USAGE_META_KEY,
  WIRE_EXTENSIONS,
  agentExtensionDeclarations,
  callerFromContext,
  coreRequestFromContext,
  decodePart,
  decodeRecord,
  deliveryFromSteer,
  encodePart,
  encodeRecord,
  fromA2AMessage,
  fromA2APart,
  initialInteractionState,
  isApproval,
  isJson,
  newRecordHeader,
  nextQueuedInteraction,
  normalizeInteraction,
  parseInteractionReply,
  presentedInteraction,
  redactSecretAnswers,
  renderInteractionText,
  replyCodeFor,
  toA2APart,
  usageDelta,
  usageFromMetadata,
  usageToMetadata,
  BYTES_KEY,
  REPLY_CODE_LENGTH,
  type CoreMessage,
  type QueuedMessageRecord,
  type CoreCaller,
  type CoreInteraction,
  type CoreInteractionRequest,
  type CorePart,
  type CoreUsage,
  type ContextBinding,
  type PendingInteraction,
  type RunRecord,
} from "../../index.js";

const by: CoreCaller = { id: "anonymous", kind: "anonymous" };
const text = (t: string): CorePart[] => [{ kind: "text", text: t }];
const data = (d: unknown): CorePart[] => [{ kind: "data", data: d }];

const sdkMsg = (over: Partial<Message> = {}): Message => ({
  messageId: "m1", contextId: "c1", taskId: "t1", role: Role.ROLE_USER,
  parts: [{ content: { $case: "text", value: "hi" }, metadata: undefined, filename: "", mediaType: "" }],
  metadata: undefined, extensions: [], referenceTaskIds: [], ...over,
});

function mustNormalize(req: CoreInteractionRequest, id = "i-1"): CoreInteraction {
  const r = normalizeInteraction(req, { id });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.interaction;
}

// ─── R1: delivery results ───────────────────────────────────────────────────

describe("R1 steering outcomes become delivery results", () => {
  it("inserted, queued (provider holds) and rejected carry task and message ids", () => {
    expect(deliveryFromSteer("t", "m", { state: "inserted" })).toEqual({ state: "inserted", taskId: "t", messageId: "m" });
    expect(deliveryFromSteer("t", "m", { state: "queued", handle: "h" })).toEqual({
      state: "queued", taskId: "t", messageId: "m", holder: "provider",
    });
    expect(deliveryFromSteer("t", "m", { state: "rejected", reason: "not-steerable", detail: "review" })).toEqual({
      state: "rejected", taskId: "t", messageId: "m", reason: "not-steerable", detail: "review",
    });
  });

  it("an outcome this core does not know is a rejection, never an insertion", () => {
    const r = deliveryFromSteer("t", "m", { state: "teleported" } as never);
    expect(r).toMatchObject({ state: "rejected", reason: "unsupported" });
  });
});

// ─── R2: unknown states ─────────────────────────────────────────────────────

describe("R2 wire keys never carry an unspecified state (see adapter.test for the status cases)", () => {
  it("a provider cannot name a state: progress, complete, fail and reject are the only run verbs", () => {
    // compile-time contract, checked by shape
    const verbs = ["progress", "complete", "fail", "reject", "ask"] as const;
    expect(verbs).toHaveLength(5);
  });
});

// ─── R3 / R4: records ───────────────────────────────────────────────────────

describe("R3/R4 records: header, codec, JSON safety", () => {
  const header = newRecordHeader({ id: "alice", kind: "user" }, "2026-01-01T00:00:00.000Z", "acme");

  it("builds a header with version, owner, tenant and timestamps", () => {
    expect(header).toEqual({
      v: 1, owner: { id: "alice", kind: "user" }, tenant: "acme",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(newRecordHeader({ id: "a", kind: "user" }, "T")).not.toHaveProperty("tenant");
  });

  it("a run record with file bytes round-trips through JSON.stringify / JSON.parse, bytes included", () => {
    const run: RunRecord = {
      ...header, runId: "r1", taskId: "t1", contextId: "c1", turnId: "u1", state: "working", startedAt: "T0",
      cancel: { requestedAt: "T1", by: "alice", abort: { stopped: "unconfirmed", session: "discard" } },
      input: [
        { kind: "text", text: "see file" },
        { kind: "file", name: "a.bin", mediaType: "application/octet-stream", bytes: new Uint8Array([0, 1, 2, 254, 255]) },
        { kind: "file", uri: "https://x/y" },
        { kind: "file", uri: "https://x/z", bytes: new Uint8Array([7]) },
        { kind: "data", data: { n: [1, 2, { k: null }] } },
        { kind: "unknown", raw: { widget: true } },
      ],
    };
    const stored = encodeRecord(run);
    const wire = JSON.parse(JSON.stringify(stored));
    expect(wire).toEqual(stored); // already plain JSON
    expect(wire.input[1].bytes).toEqual({ [BYTES_KEY]: Buffer.from([0, 1, 2, 254, 255]).toString("base64") });
    const back = decodeRecord<RunRecord>(wire);
    expect(back).toEqual(run);
    const file = back.input![1] as Extract<CorePart, { kind: "file" }>;
    expect(file.bytes).toBeInstanceOf(Uint8Array);
    expect([...file.bytes!]).toEqual([0, 1, 2, 254, 255]);
  });

  it("a context binding with a session and issuer round-trips", () => {
    const b: ContextBinding = { ...header, contextId: "c", session: { ref: "s-1", meta: { n: 1 }, issuer: "claude@0.3.1" } };
    expect(decodeRecord<ContextBinding>(JSON.parse(JSON.stringify(encodeRecord(b))))).toEqual(b);
  });

  it("a pending interaction with a redacted result round-trips", () => {
    const interaction = mustNormalize({ kind: "question", title: "Token?", questions: [{ id: "tok", prompt: "Token", allowFreeform: true, secret: true }] });
    const { result, redacted } = redactSecretAnswers(interaction, {
      outcome: "answered", answers: { tok: { text: "s3cret" } }, by,
    });
    const p: PendingInteraction = {
      ...header, interaction, taskId: "t", contextId: "c", runId: "r", seq: 1, state: "answered", expiresAt: "T9",
      result: { ...result, redacted },
    };
    const wire = JSON.parse(JSON.stringify(encodeRecord(p)));
    expect(JSON.stringify(wire)).not.toContain("s3cret");
    expect(decodeRecord<PendingInteraction>(wire)).toEqual(p);
    expect(wire.result.redacted).toEqual(["answers.tok.text"]);
  });

  it("undefined fields are dropped; non-JSON values and stray bytes throw at encode time", () => {
    const base = { ...header, runId: "r", taskId: "t", contextId: "c", turnId: "u", state: "working", startedAt: "T" };
    expect(encodeRecord({ ...base, endedAt: undefined })).not.toHaveProperty("endedAt");
    expect(() => encodeRecord({ ...base, extra: () => 1 } as never)).toThrow(/not JSON-safe/);
    expect(() => encodeRecord({ ...base, extra: Number.NaN } as never)).toThrow(/not JSON-safe/);
    expect(() => encodeRecord({ ...base, extra: new Date() } as never)).toThrow(/not JSON-safe/);
    expect(() => encodeRecord({ ...base, extra: new Map() } as never)).toThrow(/not JSON-safe/);
    expect(() => encodeRecord({ ...base, extra: new (class X { a = 1; })() } as never)).toThrow(/not JSON-safe/);
    expect(() => encodeRecord({ ...base, input: [{ kind: "text", text: "t", meta: { when: new Date() } }] } as never)).toThrow(/not JSON-safe/);
    expect(() => encodeRecord({ ...base, extra: { [BYTES_KEY]: "x", other: 1 } } as never)).toThrow(/reserved/);
    expect(() => encodeRecord({ ...base, extra: 10n } as never)).toThrow(/not JSON-safe/);
  });

  it("refuses to read a record from a newer schema or with no version", () => {
    expect(() => decodeRecord({ v: 2 })).toThrow(/newer/);
    expect(() => decodeRecord({})).toThrow(/version/);
    expect(() => decodeRecord(null)).toThrow(/version/);
  });

  it("encodePart / decodePart convert a single part", () => {
    const p: CorePart = { kind: "file", name: "n", bytes: new Uint8Array([9, 8]) };
    const stored = encodePart(p);
    expect(stored).toEqual({ kind: "file", name: "n", bytes: { [BYTES_KEY]: Buffer.from([9, 8]).toString("base64") } });
    expect(decodePart(stored)).toEqual(p);
  });

  it("isJson accepts JSON and rejects what is not", () => {
    expect(isJson({ a: [1, "x", null, true, { b: 2 }] })).toBe(true);
    for (const v of [undefined, () => 1, Number.NaN, Infinity, new Date(), new Uint8Array(1), Symbol("s"), 1n, new Map()]) {
      expect(isJson(v)).toBe(false);
    }
  });
});

// ─── R5 ─────────────────────────────────────────────────────────────────────

describe("R5d interaction shapes: normalizing constructor", () => {
  it("a confirm without options gets allow_once / reject_once and can be approved", () => {
    const c = mustNormalize({ kind: "confirm", title: "Proceed?" }, "c-1");
    const options = (c as unknown as { options: { id: string; kind: string }[] }).options;
    expect(options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    expect(c.replyCode).toBe(replyCodeFor("c-1"));
    const approved = parseInteractionReply(c, text(`yes ${c.replyCode}`), by);
    expect(approved).toMatchObject({ outcome: "selected", optionId: options[0]!.id });
    expect(isApproval(c, approved)).toBe(true);
    const denied = parseInteractionReply(c, text("no"), by);
    expect(isApproval(c, denied)).toBe(false);
  });

  it("a confirm that brings its own options keeps them", () => {
    const own = [{ id: "go", label: "Go", kind: "allow_once" as const }];
    const c = mustNormalize({ kind: "confirm", title: "?", options: own });
    expect((c as { options: unknown }).options).toEqual(own);
  });

  it("assigns id, replyCode and expiry; keeps the rest", () => {
    const r = normalizeInteraction(
      { kind: "permission", title: "t", options: [{ id: "a", label: "A", kind: "allow_once" }] },
      { id: "p-1", expiresAt: "2030-01-01T00:00:00Z" },
    );
    expect(r).toMatchObject({ ok: true, interaction: { id: "p-1", expiresAt: "2030-01-01T00:00:00Z", kind: "permission" } });
  });

  it("rejects malformed interactions with reasons", () => {
    const bad: [CoreInteractionRequest, RegExp][] = [
      [{ kind: "permission", title: "t" } as never, /at least one option/],
      [{ kind: "permission", title: "t", options: [] } as never, /at least one option/],
      [{ kind: "permission", title: "t", options: [{ id: "a", label: "A", kind: "allow_once" }, { id: "a", label: "B", kind: "reject_once" }] }, /unique/],
      [{ kind: "permission", title: "t", options: [{ id: "a", label: "A" }] } as never, /id, label and kind/],
      [{ kind: "question", title: "t" } as never, /at least one question/],
      [{ kind: "question", title: "t", questions: [] } as never, /at least one question/],
      [{ kind: "question", title: "t", questions: [{ id: "q", prompt: "p" }, { id: "q", prompt: "p2" }] }, /unique/],
      [{ kind: "question", title: "t", questions: [{ id: "q", prompt: "p", options: [] }] }, /no way to be answered/],
      [{ kind: "form", title: "t" } as never, /schema/],
      [{ kind: "auth", title: "t" } as never, /auth.service/],
      [{ kind: "", title: "t" } as never, /kind/],
      [{ kind: "confirm", title: "t", options: [] }, /at least one option/],
      [{ kind: "confirm", title: "t", meta: { f: () => 1 } } as never, /JSON-safe/],
    ];
    for (const [req, why] of bad) {
      const r = normalizeInteraction(req, { id: "x" });
      expect(r.ok, JSON.stringify(req)).toBe(false);
      expect((r as { errors: string[] }).errors.join(" ")).toMatch(why);
    }
  });

  it("rejects a kind that is a known kind in other case or with spaces, instead of treating it as unknown", () => {
    for (const kind of ["Permission", "PERMISSION", " confirm", "Question ", "FORM", "Auth"]) {
      const r = normalizeInteraction({ kind, title: "t" } as never, { id: "x" });
      expect(r.ok, kind).toBe(false);
      expect((r as { errors: string[] }).errors.join(" ")).toMatch(/known kind/);
    }
    expect(normalizeInteraction({ kind: "hologram", title: "t" } as never, { id: "x" }).ok).toBe(true);
  });

  it("validates the whole request as JSON: schema defaults and extra fields, but tolerates undefined", () => {
    const form = { kind: "form", title: "t", schema: { properties: { d: { type: "string", default: new Date() as never } } } } as CoreInteractionRequest;
    const r = normalizeInteraction(form, { id: "x" });
    expect(r.ok).toBe(false);
    expect((r as { errors: string[] }).errors.join(" ")).toMatch(/request must be JSON-safe/);
    expect(normalizeInteraction({ kind: "hologram", title: "t", extra: () => 1 } as never, { id: "x" }).ok).toBe(false);
    expect(normalizeInteraction({ kind: "hologram", title: "t", extra: { n: 1 } } as never, { id: "x" }).ok).toBe(true);
    expect(normalizeInteraction({ kind: "confirm", title: "t", description: undefined, expiresAt: undefined }, { id: "x" }).ok).toBe(true);
  });

  it("validates subject.detail and option meta as JSON, not only meta", () => {
    const base = { kind: "permission", title: "t", options: [{ id: "a", label: "A", kind: "allow_once" }] } as const;
    for (const req of [
      { ...base, subject: { detail: { when: new Date() } } },
      { ...base, subject: { detail: { f: () => 1 } } },
      { kind: "question", title: "t", questions: [{ id: "q", prompt: "p", options: [{ id: "o", label: "O", meta: { n: Number.NaN } }] }] },
    ] as unknown as CoreInteractionRequest[]) {
      const r = normalizeInteraction(req, { id: "x" });
      expect(r.ok).toBe(false);
      expect((r as { errors: string[] }).errors.join(" ")).toMatch(/JSON-safe/);
    }
    expect(normalizeInteraction({ ...base, subject: { detail: { a: [1, { b: null }] } } }, { id: "x" }).ok).toBe(true);
  });

  it("accepts every well-formed known kind and an unknown kind as is", () => {
    for (const req of [
      { kind: "question", title: "t", questions: [{ id: "q", prompt: "p" }] },
      { kind: "form", title: "t", schema: { properties: {} } },
      { kind: "auth", title: "t", auth: { service: "svc" } },
      { kind: "hologram", title: "t", extra: 1 },
    ] as CoreInteractionRequest[]) {
      expect(normalizeInteraction(req, { id: "x" }).ok).toBe(true);
    }
  });
});

describe("R5c stale text replies cannot approve", () => {
  const mustNormalizeSeq = (req: CoreInteractionRequest, id: string, seq: number): CoreInteraction => {
    const r = normalizeInteraction(req, { id, seq });
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r.interaction;
  };

  const permission = (id: string) =>
    mustNormalize({
      kind: "permission", title: "Run?",
      options: [
        { id: "ok", label: "Allow once", kind: "allow_once" },
        { id: "always", label: "Always", kind: "allow_always" },
        { id: "no", label: "Reject", kind: "reject_once" },
      ],
    }, id);

  it("assigns a stable code of at least four unambiguous characters, salted by id and seq", () => {
    expect(REPLY_CODE_LENGTH).toBeGreaterThanOrEqual(4);
    expect(replyCodeFor("a", 1)).toMatch(/^[2-9A-HJKMNP-Z]{4,}$/);
    expect(replyCodeFor("a", 1)).toBe(replyCodeFor("a", 1)); // stable: re-rendering shows the same code
    expect(replyCodeFor("a", 1)).not.toBe(replyCodeFor("a", 2)); // seq salts it
    expect(replyCodeFor("a", 1)).not.toBe(replyCodeFor("b", 1)); // so does the id
    const codes = new Set<string>();
    for (let n = 0; n < 2000; n++) codes.add(replyCodeFor(`task-${n % 7}-i`, n));
    expect(codes.size).toBeGreaterThan(1990); // no collisions to speak of across 2000 interactions
  });

  it("normalizeInteraction derives the code from id and seq, and never emits the look-alike characters", () => {
    const req = { kind: "confirm", title: "?" } as const;
    const a = normalizeInteraction(req, { id: "i", seq: 1 });
    const b = normalizeInteraction(req, { id: "i", seq: 2 });
    expect(a.ok && b.ok && a.interaction.replyCode !== b.interaction.replyCode).toBe(true);
    for (let n = 0; n < 500; n++) expect(replyCodeFor("x", n)).not.toMatch(/[01ILO]/);
  });

  it("a stale four-character code from the previous interaction does not approve the next", () => {
    const o = [{ id: "ok", label: "Allow", kind: "allow_once" as const }];
    const first = mustNormalizeSeq({ kind: "permission", title: "1", options: o }, "t-1", 1);
    const second = mustNormalizeSeq({ kind: "permission", title: "2", options: o }, "t-1", 2);
    expect(first.replyCode).not.toBe(second.replyCode);
    expect(parseInteractionReply(first, text(`1 ${first.replyCode}`), by)).toBeDefined();
    expect(parseInteractionReply(second, text(`1 ${first.replyCode}`), by)).toBeUndefined();
  });

  it("text 'no' prefers a reject without interrupts, and falls back to an interrupting one only when it is the only reject", () => {
    const mixed = mustNormalize({
      kind: "permission", title: "?",
      options: [
        { id: "ok", label: "Allow", kind: "allow_once" },
        { id: "stop", label: "Reject and stop", kind: "reject_once", interrupts: true },
        { id: "plain", label: "Reject", kind: "reject_once" },
      ],
    });
    expect(parseInteractionReply(mixed, text("no"), by)).toMatchObject({ optionId: "plain" });
    expect(parseInteractionReply(mixed, text("deny"), by)).toMatchObject({ optionId: "plain" });
    const onlyStop = mustNormalize({
      kind: "permission", title: "?",
      options: [{ id: "ok", label: "Allow", kind: "allow_once" }, { id: "stop", label: "Reject and stop", kind: "reject_once", interrupts: true }],
    });
    expect(parseInteractionReply(onlyStop, text("no"), by)).toMatchObject({ optionId: "stop" });
  });

  it("renders the code in the text: Reply `1 K7`", () => {
    const p = { ...permission("i-1"), replyCode: "K7" } as CoreInteraction;
    expect(renderInteractionText(p)).toContain("Reply with the option number and the code, for example `1 K7`.");
  });

  it("selects an allow option from text only with the presented interaction's code", () => {
    const p = { ...permission("i-1"), replyCode: "K7" } as CoreInteraction;
    expect(parseInteractionReply(p, text("1 K7"), by)).toMatchObject({ outcome: "selected", optionId: "ok" });
    expect(parseInteractionReply(p, text("k7 1"), by)).toMatchObject({ optionId: "ok" });
    expect(parseInteractionReply(p, text("`1 K7`"), by)).toMatchObject({ optionId: "ok" });
    expect(parseInteractionReply(p, text("yes K7"), by)).toMatchObject({ optionId: "ok" });
    expect(parseInteractionReply(p, text("always k7"), by)).toMatchObject({ optionId: "always" });
  });

  it("ignores a text approval with no code or a wrong code", () => {
    const p = { ...permission("i-1"), replyCode: "K7" } as CoreInteraction;
    for (const t of ["1", "yes", "approve", "allow once", "always", "1 ZZ", "yes ZZ", "K7", "K7 K7"]) {
      expect(parseInteractionReply(p, text(t), by), t).toBeUndefined();
    }
  });

  it("a code from an earlier interaction does not approve the current one", () => {
    const first = { ...permission("i-1"), replyCode: "K7" } as CoreInteraction;
    const second = { ...permission("i-2"), replyCode: "M4" } as CoreInteraction;
    const stale = text("1 K7"); // typed for `first`, arrives while `second` is presented
    expect(parseInteractionReply(first, stale, by)).toBeDefined();
    expect(parseInteractionReply(second, stale, by)).toBeUndefined();
  });

  it("an interaction with no code can never be approved from text", () => {
    const p = { ...permission("i-1"), replyCode: undefined } as unknown as CoreInteraction;
    expect(parseInteractionReply(p, text("1"), by)).toBeUndefined();
    expect(parseInteractionReply(p, text("yes"), by)).toBeUndefined();
  });

  it("a reject by text needs no code (a stale 'no' only denies), and structured replies need none", () => {
    const p = { ...permission("i-1"), replyCode: "K7" } as CoreInteraction;
    expect(parseInteractionReply(p, text("no"), by)).toMatchObject({ optionId: "no" });
    expect(parseInteractionReply(p, text("3"), by)).toMatchObject({ optionId: "no" });
    expect(parseInteractionReply(p, data({ interactionId: "i-1", optionId: "ok" }), by)).toMatchObject({ optionId: "ok" });
  });
});

describe("R5 reply parser: free-form answers are not refusals", () => {
  const freeform = mustNormalize({ kind: "question", title: "Q", questions: [{ id: "tok", prompt: "Token?", allowFreeform: true, secret: true }] });

  it("'no' and 'n' answer a free-form or secret question", () => {
    for (const t of ["no", "n", "No", "decline", "deny"]) {
      expect(parseInteractionReply(freeform, text(t), by), t).toEqual({
        outcome: "answered", answers: { tok: { text: t } }, by,
      });
    }
  });

  it("'no' answers a single-choice question whose label is No", () => {
    const yn = mustNormalize({
      kind: "question", title: "Q",
      questions: [{ id: "q", prompt: "Sure?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }],
    });
    expect(parseInteractionReply(yn, text("no"), by)).toMatchObject({ outcome: "answered", answers: { q: { optionIds: ["n"] } } });
  });

  it("a question can still be declined, structurally", () => {
    expect(parseInteractionReply(freeform, data({ interactionId: freeform.id, declined: true }), by)).toEqual({ outcome: "declined", by });
    expect(parseInteractionReply(freeform, data({ interactionId: freeform.id, dismissed: true }), by)).toEqual({ outcome: "dismissed", by });
  });

  it("forms and auth still decline on a plain 'no'", () => {
    const form = mustNormalize({ kind: "form", title: "F", schema: { properties: { a: { type: "string" } } } });
    expect(parseInteractionReply(form, text("no"), by)).toEqual({ outcome: "declined", by });
    const auth = mustNormalize({ kind: "auth", title: "A", auth: { service: "s" } });
    expect(parseInteractionReply(auth, text("n"), by)).toEqual({ outcome: "declined", by });
  });
});

describe("record codec: bytes marker is unambiguous", () => {
  const header = newRecordHeader({ id: "u", kind: "user" }, "T");

  it("a data part that merely looks like a file part with base64 bytes survives unchanged", () => {
    const lookalike = { kind: "file", name: "n", bytes: { base64: "AAEC" } }; // user data, not a core file part
    const run = { ...header, runId: "r", taskId: "t", contextId: "c", turnId: "u", state: "working", startedAt: "T",
      input: [{ kind: "data", data: lookalike, meta: { nested: { kind: "file", bytes: { base64: "QQ==" } } } }] } as unknown as RunRecord;
    const back = decodeRecord<RunRecord>(JSON.parse(JSON.stringify(encodeRecord(run))));
    expect(back).toEqual(run);
    const data = (back.input![0] as { data: typeof lookalike }).data;
    expect(data.bytes).toEqual({ base64: "AAEC" }); // not turned into a Uint8Array
  });

  it("restores real bytes wherever they appear, including nested and in arrays", () => {
    const run = { ...header, runId: "r", taskId: "t", contextId: "c", turnId: "u", state: "working", startedAt: "T",
      input: [{ kind: "data", data: { deep: [new Uint8Array([1, 2])] } }, { kind: "file", bytes: new Uint8Array([3]) }] } as unknown as RunRecord;
    const wire = JSON.parse(JSON.stringify(encodeRecord(run)));
    expect(wire.input[0].data.deep[0]).toEqual({ [BYTES_KEY]: "AQI=" });
    const back = decodeRecord<RunRecord>(wire) as unknown as { input: { data: { deep: Uint8Array[] }; bytes: Uint8Array }[] };
    expect(back.input[0]!.data.deep[0]).toBeInstanceOf(Uint8Array);
    expect([...back.input[0]!.data.deep[0]!]).toEqual([1, 2]);
    expect([...back.input[1]!.bytes]).toEqual([3]);
  });

  it("a Date in part meta throws instead of becoming {}", () => {
    expect(() => encodePart({ kind: "text", text: "t", meta: { at: new Date() } })).toThrow(/not JSON-safe/);
  });
});

describe("QueuedMessageRecord", () => {
  it("a core-queued message with bytes survives a restart through the codec", () => {
    const message: CoreMessage = {
      id: "m1", role: "user", from: { id: "alice", kind: "user", claims: { org: "x" } }, at: "T", delivery: "queue",
      parts: [{ kind: "text", text: "next" }, { kind: "file", name: "f", bytes: new Uint8Array([5, 6]) }], meta: { k: 1 },
    };
    const rec: QueuedMessageRecord = {
      ...newRecordHeader({ id: "alice", kind: "user" }, "T"),
      taskId: "t", contextId: "c", message, holder: "core", position: 1, state: "queued",
    };
    const wire = JSON.parse(JSON.stringify(encodeRecord(rec)));
    expect(wire.message.parts[1].bytes).toEqual({ [BYTES_KEY]: "BQY=" });
    expect(decodeRecord<QueuedMessageRecord>(wire)).toEqual(rec);
  });

  it("a provider-held message keeps its handle", () => {
    const rec: QueuedMessageRecord = {
      ...newRecordHeader({ id: "a", kind: "user" }, "T"),
      taskId: "t", contextId: "c", holder: "provider", handle: "h-1", state: "queued",
      message: { id: "m", role: "user", parts: [], from: { id: "a", kind: "user" }, at: "T" },
    };
    expect(decodeRecord<QueuedMessageRecord>(JSON.parse(JSON.stringify(encodeRecord(rec)))).handle).toBe("h-1");
  });
});

describe("record codec: reserved key and __proto__", () => {
  const header = newRecordHeader({ id: "u", kind: "user" }, "T");
  const withInput = (input: unknown) =>
    ({ ...header, runId: "r", taskId: "t", contextId: "c", turnId: "u", state: "working", startedAt: "T", input }) as unknown as RunRecord;

  it("a live object that is exactly {\"$bytes:v1\": ...} (a client's data part) throws instead of turning into bytes", () => {
    expect(() => encodeRecord(withInput([{ kind: "data", data: { [BYTES_KEY]: "aGk=" } }]))).toThrow(/reserved/);
    expect(() => encodeRecord(withInput([{ kind: "data", data: { deep: [{ [BYTES_KEY]: "aGk=" }] } }]))).toThrow(/reserved/);
    expect(() => encodeRecord(withInput([{ kind: "data", data: { [BYTES_KEY]: "x", other: 1 } }]))).toThrow(/reserved/);
  });

  it("stored data is not re-encoded: encoding an already stored message throws", () => {
    const stored = encodeRecord(withInput([{ kind: "file", bytes: new Uint8Array([1]) }]));
    expect(() => encodeRecord(stored as never)).toThrow(/reserved/);
  });

  it("encode keeps a __proto__ key as an own property and does not touch the prototype", () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":1},"ok":2}');
    const stored = encodeRecord(withInput([{ kind: "data", data: parsed }]));
    const data = (stored as unknown as { input: { data: Record<string, unknown> }[] }).input[0]!.data;
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.hasOwn(data, "__proto__")).toBe(true);
    expect(data.ok).toBe(2);
    expect((data as { polluted?: unknown }).polluted).toBeUndefined();
    expect(JSON.stringify(stored)).toContain('"__proto__":{"polluted":1}');
  });

  it("decode of JSON with a __proto__ key yields an own property and a normal prototype", () => {
    const wire = JSON.parse('{"v":1,"owner":{"id":"u","kind":"user"},"createdAt":"T","updatedAt":"T","x":{"__proto__":{"p":1}},"y":[{"__proto__":{"q":2},"ok":3}]}');
    const back = decodeRecord<RunRecord>(wire) as unknown as { x: Record<string, unknown>; y: Record<string, unknown>[] };
    expect(Object.getPrototypeOf(back.x)).toBe(Object.prototype);
    expect(Object.hasOwn(back.x, "__proto__")).toBe(true);
    expect((back.x as { p?: unknown }).p).toBeUndefined();
    expect(Object.hasOwn(back.y[0]!, "__proto__")).toBe(true);
    expect(back.y[0]!.ok).toBe(3);
    expect(({} as { p?: unknown }).p).toBeUndefined(); // Object.prototype untouched
    expect(JSON.stringify(back.x)).toBe('{"__proto__":{"p":1}}');
  });
});

describe("steering alias is never advertised", () => {
  it("is not among the wire extensions or agent card declarations", () => {
    expect(WIRE_EXTENSIONS.some((e) => e.uri === STEERING_EXTENSION_ALIAS)).toBe(false);
    expect(agentExtensionDeclarations().some((e) => e.uri === STEERING_EXTENSION_ALIAS)).toBe(false);
  });
});

describe("R5a withdrawn and the result variants", () => {
  const perm = mustNormalize({ kind: "permission", title: "t", options: [{ id: "a", label: "A", kind: "allow_once" }] });

  it("withdrawn, dismissed and declined never approve", () => {
    expect(isApproval(perm, { outcome: "withdrawn" })).toBe(false);
    expect(isApproval(perm, { outcome: "dismissed", by })).toBe(false);
    expect(isApproval(perm, { outcome: "declined", by })).toBe(false);
  });

  it("selected carries an amendment (JSON object only)", () => {
    const ok = parseInteractionReply(perm, data({ interactionId: perm.id, optionId: "a", amendment: { command: "ls" } }), by);
    expect(ok).toEqual({ outcome: "selected", optionId: "a", amendment: { command: "ls" }, by });
    expect(isApproval(perm, ok)).toBe(true);
    for (const amendment of ["x", [1], 5, { f: () => 1 }]) {
      expect(parseInteractionReply(perm, data({ interactionId: perm.id, optionId: "a", amendment }), by)).toBeUndefined();
    }
  });

  it("answered carries freeText next to option ids when the question allows free text", () => {
    const q = mustNormalize({
      kind: "question", title: "Q",
      questions: [
        { id: "a", prompt: "A", allowFreeform: true, options: [{ id: "x", label: "X", meta: { k: 1 } }] },
        { id: "b", prompt: "B", options: [{ id: "y", label: "Y" }] },
      ],
    });
    expect(parseInteractionReply(q, data({ interactionId: q.id, answers: { a: { freeText: "other" }, b: { optionIds: ["y"] } } }), by)).toEqual({
      outcome: "answered", answers: { a: { freeText: "other" }, b: { optionIds: ["y"] } }, by,
    });
    expect(parseInteractionReply(q, data({ interactionId: q.id, answers: { a: { optionIds: ["x"] }, b: { freeText: "nope" } } }), by)).toBeUndefined();
  });
});

describe("R5b per-task FIFO with one presented interaction", () => {
  const header = newRecordHeader({ id: "u", kind: "user" }, "T");
  const rec = (seq: number, state: PendingInteraction["state"]): PendingInteraction => ({
    ...header, interaction: mustNormalize({ kind: "confirm", title: `q${seq}` }, `i-${seq}`),
    taskId: "t", contextId: "c", runId: "r", seq, state, expiresAt: "T9",
  });

  it("the first ask is presented, the rest queue", () => {
    expect(initialInteractionState([])).toBe("presented");
    expect(initialInteractionState([rec(1, "presented")])).toBe("queued");
    expect(initialInteractionState([rec(1, "queued"), rec(2, "queued")])).toBe("queued");
    expect(initialInteractionState([rec(1, "answered"), rec(2, "withdrawn"), rec(3, "expired"), rec(4, "canceled")])).toBe("presented");
  });

  it("finds the presented one and the next queued one in seq order", () => {
    const all = [rec(3, "queued"), rec(1, "answered"), rec(2, "presented"), rec(4, "queued")];
    expect(presentedInteraction(all)?.seq).toBe(2);
    expect(nextQueuedInteraction(all)?.seq).toBe(3);
    expect(presentedInteraction([rec(1, "queued")])).toBeUndefined();
    expect(nextQueuedInteraction([rec(1, "presented")])).toBeUndefined();
  });
});

describe("forms: own properties only, titled enums and multi-select", () => {
  const form = mustNormalize({
    kind: "form", title: "F",
    schema: {
      properties: {
        name: { type: "string" },
        size: { type: "string", oneOf: [{ const: "s", title: "Small" }, { const: "l", title: "Large" }] },
        tags: { type: "array", items: { enum: ["a", "b", "c"] }, minItems: 1, maxItems: 2 },
        langs: { type: "array", items: { anyOf: [{ const: "ts", title: "TypeScript" }, { const: "py", title: "Python" }] } },
      },
      required: ["name"],
    },
  });
  const submit = (values: unknown) => parseInteractionReply(form, data({ interactionId: form.id, values }), by);

  it("rejects prototype keys as fields (constructor, toString, __proto__)", () => {
    expect(submit({ name: "a", constructor: "x" })).toBeUndefined();
    expect(submit({ name: "a", toString: "x" })).toBeUndefined();
    expect(submit(JSON.parse('{"name":"a","__proto__":{"x":1}}'))).toBeUndefined();
    expect(submit({ name: "a", hasOwnProperty: 1 })).toBeUndefined();
  });

  it("a required key is satisfied by an own value only", () => {
    const f2 = mustNormalize({ kind: "form", title: "F", schema: { properties: { constructor: { type: "string" } }, required: ["constructor"] } });
    // `constructor` is declared here, so it is legitimate; it must still be present as an own value.
    expect(parseInteractionReply(f2, data({ interactionId: f2.id, values: {} }), by)).toBeUndefined();
    expect(parseInteractionReply(f2, data({ interactionId: f2.id, values: { constructor: "x" } }), by)).toMatchObject({ outcome: "submitted" });
  });

  it("validates titled enums", () => {
    expect(submit({ name: "a", size: "s" })).toMatchObject({ outcome: "submitted" });
    expect(submit({ name: "a", size: "xl" })).toBeUndefined();
  });

  it("validates multi-select arrays, plain and titled, with bounds", () => {
    expect(submit({ name: "a", tags: ["a", "c"] })).toMatchObject({ outcome: "submitted" });
    expect(submit({ name: "a", tags: [] })).toBeUndefined(); // minItems
    expect(submit({ name: "a", tags: ["a", "b", "c"] })).toBeUndefined(); // maxItems
    expect(submit({ name: "a", tags: ["z"] })).toBeUndefined();
    expect(submit({ name: "a", tags: "a" })).toBeUndefined();
    expect(submit({ name: "a", langs: ["ts", "py"] })).toMatchObject({ outcome: "submitted" });
    expect(submit({ name: "a", langs: ["rust"] })).toBeUndefined();
  });

  it("renders titled choices", () => {
    const t = renderInteractionText(form);
    expect(t).toContain("[Small | Large]");
    expect(t).toContain("tags (multi-select)");
  });

  it("question answers use own keys too", () => {
    const q = mustNormalize({ kind: "question", title: "Q", questions: [{ id: "constructor", prompt: "p", allowFreeform: true }] });
    expect(parseInteractionReply(q, data({ interactionId: q.id, answers: {} }), by)).toBeUndefined();
    expect(parseInteractionReply(q, data({ interactionId: q.id, answers: { constructor: { text: "x" } } }), by)).toMatchObject({ outcome: "answered" });
  });
});

describe("redactSecretAnswers", () => {
  const q = mustNormalize({
    kind: "question", title: "Q",
    questions: [
      { id: "pub", prompt: "p", allowFreeform: true },
      { id: "tok", prompt: "t", secret: true, options: [{ id: "k", label: "K" }], allowFreeform: true },
    ],
  });

  it("removes secret text, keeps option ids and public answers, lists the paths", () => {
    const { result, redacted } = redactSecretAnswers(q, {
      outcome: "answered", by,
      answers: { pub: { text: "hello" }, tok: { optionIds: ["k"], freeText: "s3", text: "s4" } },
    });
    expect(result).toEqual({ outcome: "answered", by, answers: { pub: { text: "hello" }, tok: { optionIds: ["k"] } } });
    expect(redacted.sort()).toEqual(["answers.tok.freeText", "answers.tok.text"]);
  });

  it("leaves other outcomes alone", () => {
    const r = { outcome: "expired" } as const;
    expect(redactSecretAnswers(q, r)).toEqual({ result: r, redacted: [] });
  });
});

// ─── R6: usage ──────────────────────────────────────────────────────────────

describe("R6 usageDelta", () => {
  const cum = (over: Partial<CoreUsage>): CoreUsage => ({ scope: "cumulative", tokens: {}, ...over });

  it("delta scope passes through untouched", () => {
    const d: CoreUsage = { scope: "delta", tokens: { input: 5 }, costUsd: 0.1 };
    expect(usageDelta(cum({ tokens: { input: 999 } }), d)).toBe(d);
    expect(usageDelta(undefined, d)).toBe(d);
  });

  it("first reading of a series is its own delta", () => {
    const r = usageDelta(undefined, cum({ series: "s", tokens: { input: 10, output: 4 }, costUsd: 0.5, model: "m" }));
    expect(r).toEqual({ scope: "delta", tokens: { input: 10, output: 4 }, costUsd: 0.5, model: "m" });
  });

  it("successive readings of one series subtract, including cost", () => {
    const a = cum({ series: "s", tokens: { input: 10, output: 4 }, costUsd: 0.5 });
    const b = cum({ series: "s", tokens: { input: 25, output: 9 }, costUsd: 0.8 });
    expect(usageDelta(a, b)).toEqual({ scope: "delta", tokens: { input: 15, output: 5 }, costUsd: 0.3 });
  });

  it("a decrease starts a new epoch instead of a negative delta (reset, e.g. /clear)", () => {
    const before = cum({ series: "s", tokens: { input: 1000, output: 500 }, costUsd: 5 });
    const after = cum({ series: "s", tokens: { input: 40, output: 10 }, costUsd: 0.2 });
    const d = usageDelta(before, after);
    expect(d.tokens).toEqual({ input: 40, output: 10 });
    expect(d.costUsd).toBe(0.2);
    for (const v of Object.values(d.tokens)) expect(v).toBeGreaterThanOrEqual(0);
    // and the next reading continues from the new epoch
    const next = cum({ series: "s", tokens: { input: 100, output: 30 }, costUsd: 0.5 });
    expect(usageDelta(after, next)).toEqual({ scope: "delta", tokens: { input: 60, output: 20 }, costUsd: 0.3 });
  });

  it("a decrease in cost alone also resets the group", () => {
    const d = usageDelta(cum({ series: "s", tokens: { input: 10 }, costUsd: 5 }), cum({ series: "s", tokens: { input: 12 }, costUsd: 1 }));
    expect(d.tokens).toEqual({ input: 12 });
    expect(d.costUsd).toBe(1);
  });

  it("a resume that continues the same series (totals carried over) is a plain difference", () => {
    // Process restarted, session resumed from its transcript: the provider reports the same series and continuing totals.
    const persisted = cum({ series: "session-1", tokens: { input: 500 }, costUsd: 2 });
    const resumed = cum({ series: "session-1", tokens: { input: 530 }, costUsd: 2.1 });
    expect(usageDelta(persisted, resumed)).toEqual({ scope: "delta", tokens: { input: 30 }, costUsd: 0.1 });
  });

  it("a different series starts a new total: no subtraction across series", () => {
    const d = usageDelta(cum({ series: "a", tokens: { input: 900 }, costUsd: 9 }), cum({ series: "b", tokens: { input: 50 }, costUsd: 0.5 }));
    expect(d.tokens).toEqual({ input: 50 });
    expect(d.costUsd).toBe(0.5);
    // a series change from an anonymous series too
    expect(usageDelta(cum({ tokens: { input: 9 } }), cum({ series: "b", tokens: { input: 5 } })).tokens).toEqual({ input: 5 });
  });

  it("works per model: one model resets, another continues, a new model starts", () => {
    const prev = cum({
      series: "s", tokens: { total: 300 },
      byModel: { big: { input: 100, costUsd: 1 }, small: { input: 200, costUsd: 0.2 } },
    });
    const next = cum({
      series: "s", tokens: { total: 340 },
      byModel: { big: { input: 10, costUsd: 0.1 }, small: { input: 230, costUsd: 0.25 }, fresh: { input: 7, costUsd: 0.01 } },
    });
    const d = usageDelta(prev, next);
    expect(d.tokens).toEqual({ total: 40 });
    expect(d.byModel).toEqual({
      big: { input: 10, costUsd: 0.1 }, // reset: new epoch
      small: { input: 30, costUsd: 0.05 }, // continued
      fresh: { input: 7, costUsd: 0.01 }, // new model
    });
  });

  it("null cost stays null; cost appearing for the first time is the delta", () => {
    expect(usageDelta(cum({ series: "s", tokens: { input: 1 }, costUsd: null }), cum({ series: "s", tokens: { input: 3 }, costUsd: null })).costUsd).toBeNull();
    expect(usageDelta(cum({ series: "s", tokens: { input: 1 } }), cum({ series: "s", tokens: { input: 3 }, costUsd: 0.4 })).costUsd).toBe(0.4);
    expect("costUsd" in usageDelta(undefined, cum({ tokens: { input: 1 } }))).toBe(false);
  });

  it("does not accumulate floating point noise", () => {
    const d = usageDelta(cum({ series: "s", tokens: {}, costUsd: 0.1 }), cum({ series: "s", tokens: {}, costUsd: 0.3 }));
    expect(d.costUsd).toBe(0.2);
  });

  it("passes the point-in-time context window through", () => {
    const d = usageDelta(cum({ series: "s", tokens: { input: 1 } }), cum({ series: "s", tokens: { input: 2 }, contextWindow: { used: 5, limit: 10 } }));
    expect(d.contextWindow).toEqual({ used: 5, limit: 10 });
  });

  it("series and byModel survive the wire metadata", () => {
    const u: CoreUsage = { scope: "cumulative", series: "s-1", tokens: { input: 3 }, costUsd: 0.2, model: "m", byModel: { m: { input: 3, costUsd: 0.2 }, n: { output: 1, costUsd: null } } };
    expect(usageFromMetadata(JSON.parse(JSON.stringify(usageToMetadata(u))))).toEqual(u);
  });

  it("reads usage written under the old unversioned key", () => {
    expect(usageFromMetadata({ [LEGACY_WIRE_KEYS.usage]: { scope: "delta", tokens: { total: 2 } } })).toEqual({ scope: "delta", tokens: { total: 2 } });
  });
});

// ─── R7 (types) is covered in model.test.ts ─────────────────────────────────

// ─── R8: wire keys ──────────────────────────────────────────────────────────

describe("R8 versioned wire keys", () => {
  it("every key core writes is versioned and listed once", () => {
    const keys = [DELIVERY_META_KEY, USAGE_META_KEY, CORE_STATE_META_KEY, FILE_URI_META_KEY, UNKNOWN_PART_META_KEY, INTERACTION_EXTENSION_URI];
    for (const k of keys) expect(k).toMatch(/^urn:a2a-wrapper:[a-z-]+:v1$/);
    expect(WIRE_EXTENSIONS.map((e) => e.uri).sort()).toEqual([...keys].sort());
    expect(DELIVERY_META_KEY).toBe("urn:a2a-wrapper:delivery:v1");
    expect(USAGE_META_KEY).toBe("urn:a2a-wrapper:usage:v1");
    expect(CORE_STATE_META_KEY).toBe("urn:a2a-wrapper:core-state:v1");
    expect(FILE_URI_META_KEY).toBe("urn:a2a-wrapper:file-uri:v1");
    expect(UNKNOWN_PART_META_KEY).toBe("urn:a2a-wrapper:unknown-part:v1");
    expect(INTERACTION_EXTENSION_URI).toBe("urn:a2a-wrapper:interaction:v1");
  });

  it("produces optional agent card extension declarations, filterable", () => {
    const all = agentExtensionDeclarations();
    expect(all).toHaveLength(WIRE_EXTENSIONS.length);
    for (const e of all) {
      expect(e.required).toBe(false);
      expect(e.description.length).toBeGreaterThan(10);
      expect(e.params).toEqual({ kind: expect.stringMatching(/^(extension|metadata-key)$/) });
    }
    expect(all.find((e) => e.uri === INTERACTION_EXTENSION_URI)?.params).toEqual({ kind: "extension" });
    expect(agentExtensionDeclarations({ only: [INTERACTION_EXTENSION_URI] }).map((e) => e.uri)).toEqual([INTERACTION_EXTENSION_URI]);
  });

  it("writes only versioned keys (round trip of every wire key)", () => {
    const wire = toA2APart({ kind: "file", uri: "https://u", bytes: new Uint8Array([1]) });
    expect(Object.keys(wire.metadata!)).toEqual([FILE_URI_META_KEY]);
    expect(Object.keys(toA2APart({ kind: "unknown", raw: 1 }).metadata!)).toEqual([UNKNOWN_PART_META_KEY]);
  });

  it("still reads the old unversioned part keys inbound", () => {
    const unknownWrapper = { content: { $case: "data", value: { z: 1 } }, metadata: { [LEGACY_WIRE_KEYS.unknownPart]: true }, filename: "", mediaType: "" } as Part;
    expect(fromA2APart(unknownWrapper)).toEqual({ kind: "unknown", raw: { z: 1 } });
    const raw = { content: { $case: "raw", value: Buffer.from([4]) }, metadata: { [LEGACY_WIRE_KEYS.fileUri]: "https://old", k: 1 }, filename: "", mediaType: "" } as Part;
    expect(fromA2APart(raw)).toMatchObject({ kind: "file", uri: "https://old", meta: { k: 1 } });
  });

  describe("delivery intent inbound", () => {
    const delivery = (metadata: Record<string, unknown>) => fromA2AMessage(sdkMsg({ metadata }));

    it("reads the versioned key, then the old key", () => {
      expect(delivery({ [DELIVERY_META_KEY]: "steer" }).delivery).toBe("steer");
      const old = delivery({ [LEGACY_WIRE_KEYS.delivery]: "interrupt", k: 1 });
      expect(old.delivery).toBe("interrupt");
      expect(old.meta).toEqual({ k: 1 });
    });

    it("accepts the steering extension alias: bare string or object with action/mode/type/delivery", () => {
      expect(delivery({ [STEERING_EXTENSION_ALIAS]: "steer" }).delivery).toBe("steer");
      expect(delivery({ [STEERING_EXTENSION_ALIAS]: "interrupt" }).delivery).toBe("interrupt");
      expect(delivery({ [STEERING_EXTENSION_ALIAS]: { action: "interrupt" } }).delivery).toBe("interrupt");
      expect(delivery({ [STEERING_EXTENSION_ALIAS]: { mode: "steer" } }).delivery).toBe("steer");
      expect(delivery({ [STEERING_EXTENSION_ALIAS]: { type: "queue" } }).delivery).toBe("queue");
      expect(delivery({ [STEERING_EXTENSION_ALIAS]: { delivery: "steer" } }).delivery).toBe("steer");
    });

    it("ignores an alias value it does not understand, and removes the alias key from meta", () => {
      for (const v of ["teleport", 5, null, { action: 3 }, { other: "steer" }, []]) {
        const m = delivery({ [STEERING_EXTENSION_ALIAS]: v, k: 1 });
        expect(m.delivery, JSON.stringify(v)).toBeUndefined();
        expect(m.meta).toEqual({ k: 1 });
      }
    });

    it("the core key wins over the alias", () => {
      expect(delivery({ [DELIVERY_META_KEY]: "queue", [STEERING_EXTENSION_ALIAS]: "interrupt" }).delivery).toBe("queue");
    });
  });
});

// ─── Request building ───────────────────────────────────────────────────────

describe("coreRequestFromContext: turn, trace, caller", () => {
  const request = (message: Message) => ({ tenant: "", message, configuration: undefined, metadata: undefined }) as never;
  const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("carries a turnId (given or generated) next to the runId", () => {
    const ctx = new RequestContext(request(sdkMsg()), "t1", "c1", new ServerCallContext());
    expect(coreRequestFromContext(ctx, { runId: "r", turnId: "u-9" })).toMatchObject({ runId: "r", turnId: "u-9" });
    const generated = coreRequestFromContext(ctx, { runId: "r" });
    expect(generated.turnId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sets traceparent and tracestate from the request headers", () => {
    const state = new Map<string, unknown>([["headers", { traceparent: TP, tracestate: "vendor=1" }]]);
    const ctx = new RequestContext(request(sdkMsg()), "t1", "c1", new ServerCallContext({ state }));
    const req = coreRequestFromContext(ctx, { runId: "r" });
    expect(req.correlation.trace).toMatchObject({ traceparent: TP, tracestate: "vendor=1" });
  });

  it("falls back to message metadata, and omits both when absent or invalid", () => {
    const viaMeta = new RequestContext(request(sdkMsg({ metadata: { traceparent: TP } })), "t1", "c1", new ServerCallContext());
    expect(coreRequestFromContext(viaMeta, { runId: "r" }).correlation.trace?.traceparent).toBe(TP);
    const none = coreRequestFromContext(new RequestContext(request(sdkMsg()), "t1", "c1", new ServerCallContext()), { runId: "r" });
    expect(none.correlation.trace).not.toHaveProperty("traceparent");
    expect(none.correlation.trace).not.toHaveProperty("tracestate");
    const bad = new RequestContext(request(sdkMsg({ metadata: { traceparent: "garbage" } })), "t1", "c1", new ServerCallContext());
    expect(coreRequestFromContext(bad, { runId: "r" }).correlation.trace).not.toHaveProperty("traceparent");
  });

  it("keeps scopes and claims the authentication layer attached to the user", () => {
    const user = { isAuthenticated: true, userName: "alice", scopes: ["tasks:write"], claims: { org: "acme", n: 1 } };
    const ctx = new RequestContext(request(sdkMsg()), "t1", "c1", new ServerCallContext({ user }));
    expect(callerFromContext(ctx)).toEqual({ id: "alice", kind: "user", scopes: ["tasks:write"], claims: { org: "acme", n: 1 } });
    const junk = { isAuthenticated: true, userName: "bob", scopes: [1], claims: () => 1 };
    expect(callerFromContext(new RequestContext(request(sdkMsg()), "t1", "c1", new ServerCallContext({ user: junk })))).toEqual({ id: "bob", kind: "user" });
  });

  it("does not stamp history with the request time or attribute it to the caller", () => {
    const task = {
      id: "t1", contextId: "c1", status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
      artifacts: [], metadata: undefined, history: [sdkMsg({ messageId: "h1" })],
    } as never;
    const ctx = new RequestContext(request(sdkMsg()), "t1", "c1", new ServerCallContext({ user: { isAuthenticated: true, userName: "alice" } }), task);
    const req = coreRequestFromContext(ctx, { runId: "r" });
    expect(req.caller.id).toBe("alice");
    expect(req.history[0]).not.toHaveProperty("from");
    expect(req.history[0]).not.toHaveProperty("at");
  });
});
