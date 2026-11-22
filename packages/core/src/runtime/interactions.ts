/**
 * @module runtime/interactions
 *
 * The interactions runtime (issue #108): what `run.ask` does. SDK-free; it reaches an A2A
 * event bus only through {@link RunPublisher} and the task store only through
 * {@link RunStore}.
 *
 * ### Life of an interaction
 *
 * `run.ask(request, opts)` -> `normalizeInteraction` (core assigns id, `seq`, reply code and
 * expiry) -> a `PendingInteraction` record (`queued`, or `presented` when the task has no open
 * one: a per-task FIFO with exactly one presented) -> the presented one is published
 * (`input-required`, `auth-required` for an auth interaction) and the run PARKS: the provider's
 * `ask` promise stays pending, `provider.run` stays pending, the context lane stays held. A
 * reply is a new `execute()` on the same task; the registry routes it to {@link handleReply},
 * which parses it against the PRESENTED interaction only, resolves the parked promise and the
 * SAME `provider.run` continues (never a second run). Then the next queued interaction is
 * presented, or the task goes back to `working`.
 *
 * ### The ways an interaction ends
 *
 * answered (a reply), expired (timer, per kind, then the policy's `onTimeout`), canceled (the
 * task was canceled or ended: settled synchronously inside the registry's terminal claim),
 * withdrawn (`AskOptions.signal`). Unknown never approves (D5): a reply that cannot be parsed
 * is ignored with a re-prompt hint, never an approval.
 *
 * ### Secrets
 *
 * Answers to `secret` questions are allowed (owner decision; a deviation from MCP form-mode
 * elicitation, which forbids requesting secrets). The provider receives them; the stored
 * record keeps them REDACTED (`result.redacted` lists the removed paths) and nothing here ever
 * logs a result.
 *
 * @see docs/design/core-data-model.md sections 3.3, 3.9 and 3.10
 */

import {
  initialInteractionState,
  isOpenInteractionState,
  newRecordHeader,
  normalizeInteraction,
  parseInteractionReply,
  redactSecretAnswers,
  type AskOptions,
  type CoreInteraction,
  type CoreInteractionRequest,
  type CoreInteractionResult,
  type CorePart,
  type CoreTaskState,
  type PendingInteraction,
} from "../model/index.js";
import {
  matchAutoAnswer,
  MAX_TIMER_MS,
  resolveInteractionPolicy,
  timeoutFor,
  type InteractionPolicy,
} from "./interaction-policy.js";
import type { ExecuteInit, HandleReplyOptions, InteractionHost, InteractionRuntime, RunInteractionHandle } from "./types.js";

export interface InteractionsRuntimeOptions {
  policy?: Partial<InteractionPolicy>;
}

interface Item {
  rec: PendingInteraction;
  interaction: CoreInteraction;
  promise: Promise<CoreInteractionResult>;
  resolve(r: CoreInteractionResult): void;
  /** The provider gave `expiresAt` itself: keep it instead of starting the clock at presentation. */
  fixedExpiry: boolean;
  /** Restored after a restart and waiting for the provider to re-ask with the same handle. */
  restored: boolean;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  unregister?: () => void;
  offAbort?: () => void;
  /** Serializes the record writes of this interaction (a later state must not be overwritten by an earlier one). */
  chain: Promise<unknown>;
}

interface RunState {
  handle: RunInteractionHandle;
  /** Open interactions only, in `seq` order. */
  items: Item[];
  /**
   * Last `seq` handed out for this run: restored from the records on a restart, then counted up. The records themselves
   * (state, result, `seq`) live in the store; this is process-local, like the run handle it hangs on.
   */
  nextSeq: number;
  /** A cache in front of the store for "was this interaction already resolved?" (a duplicate or late structured reply). */
  settledIds: Set<string>;
  /** Answers given to a restored interaction before the provider re-asked with its handle, keyed by that handle. */
  restoredResults: Map<string, CoreInteractionResult>;
}

const hasSecretQuestion = (i: CoreInteraction): boolean =>
  ((i as { questions?: readonly { secret?: boolean }[] }).questions ?? []).some((q) => q.secret === true);

const stateFor = (kind: string): CoreTaskState => (kind === "auth" ? "auth-required" : "input-required");

const HINT_NO_MATCH = "That reply could not be matched to the open request.";
const HINT_DENIED = "You are not allowed to answer this request.";

export class InteractionsRuntime implements InteractionRuntime {
  readonly policy: InteractionPolicy;
  private host?: InteractionHost;
  private readonly states = new WeakMap<RunInteractionHandle, RunState>();

  constructor(options: InteractionsRuntimeOptions = {}) {
    this.policy = resolveInteractionPolicy(options.policy);
  }

  bind(host: InteractionHost): void {
    this.host = host;
  }

  // ─── run.ask ────────────────────────────────────────────────────────────────

  ask(handle: RunInteractionHandle, request: CoreInteractionRequest, options?: AskOptions): Promise<CoreInteractionResult> {
    try {
      return this.doAsk(handle, request, options);
    } catch (e) {
      this.host?.log.warn("run.ask failed", e instanceof Error ? e.message : String(e));
      return Promise.resolve({ outcome: "unavailable", reason: "interactions failed internally", code: "internal" });
    }
  }

  /** Synchronous up to the returned promise, so the queue stays consistent when a provider asks twice in a row. */
  private doAsk(handle: RunInteractionHandle, request: CoreInteractionRequest, options?: AskOptions): Promise<CoreInteractionResult> {
    const host = this.host;
    if (!host) return Promise.resolve({ outcome: "unavailable", reason: "interactions are not enabled", code: "interactions-disabled" });
    if (options?.signal?.aborted) return Promise.resolve({ outcome: "withdrawn" });
    const st = this.stateOf(handle);

    // A provider re-attaching after a restart asks again with the handle of a restored interaction.
    if (options?.handle !== undefined) {
      const restored = st.items.find((i) => i.restored && i.rec.handle === options.handle);
      if (restored) {
        restored.restored = false;
        this.watch(st, restored, options.signal);
        return restored.promise;
      }
      // Answered (or ended) while no provider was waiting: the re-ask gets that outcome.
      const early = st.restoredResults.get(options.handle);
      if (early) {
        st.restoredResults.delete(options.handle);
        return Promise.resolve(early);
      }
    }

    // `auto` asks nobody: without autoAnswer rules there is nothing to do. With rules (an operator reproducing today's
    // behaviour with a catch-all allow_once, say) they still apply; whatever they do not answer is unavailable.
    if (this.policy.mode !== "ask" && this.policy.autoAnswer.length === 0) {
      return Promise.resolve({ outcome: "unavailable", reason: 'core does not ask a person (interactions.mode is "auto")', code: "policy-auto" });
    }

    const kind = String((request as { kind?: unknown }).kind ?? "");
    const given = typeof request.expiresAt === "string" ? Date.parse(request.expiresAt) : Number.NaN;
    const fixedExpiry = Number.isFinite(given);
    const expiresAt = fixedExpiry
      ? new Date(given).toISOString()
      : new Date(Date.parse(host.now()) + timeoutFor(this.policy, kind)).toISOString();
    const seq = st.nextSeq + 1;
    const id = host.newId();
    const normalized = normalizeInteraction(request, { id, seq, expiresAt });
    if (!normalized.ok) return Promise.resolve({ outcome: "unavailable", reason: `invalid interaction: ${normalized.errors.join("; ")}`, code: "invalid-request" });
    const interaction = normalized.interaction;
    st.nextSeq = seq;

    const now = host.now();
    const header = newRecordHeader({ id: handle.owner.id, kind: handle.owner.kind }, now);
    const base = {
      ...header,
      interaction,
      taskId: handle.taskId,
      contextId: handle.contextId,
      runId: handle.runId,
      seq,
      expiresAt,
      ...(options?.handle !== undefined ? { handle: options.handle } : {}),
    };

    const answeredByPolicy = matchAutoAnswer(this.policy, interaction);
    if (answeredByPolicy) {
      // Answered without a person: recorded (who answered), never published, the run never parks.
      const rec: PendingInteraction = { ...base, state: "answered", result: answeredByPolicy };
      host.track(host.store.putPending(rec).catch((e) => host.log.warn("pending record write failed", String(e))));
      return Promise.resolve(answeredByPolicy);
    }
    if (this.policy.mode !== "ask") {
      return Promise.resolve({ outcome: "unavailable", reason: 'core does not ask a person (interactions.mode is "auto")', code: "policy-auto" });
    }

    let resolve!: (r: CoreInteractionResult) => void;
    const promise = new Promise<CoreInteractionResult>((r) => (resolve = r));
    const item: Item = {
      rec: { ...base, state: initialInteractionState(st.items.map((i) => i.rec)) },
      interaction,
      promise,
      resolve,
      fixedExpiry,
      restored: false,
      settled: false,
      chain: Promise.resolve(),
    };
    st.items.push(item);
    item.unregister = handle.registerPending({ cancel: () => void this.settle(st, item, "canceled", { outcome: "canceled" }) });
    this.watch(st, item, options?.signal);
    if (item.rec.state === "presented") this.present(st, item);
    else this.persist(item);
    return promise;
  }

  private stateOf(handle: RunInteractionHandle): RunState {
    let st = this.states.get(handle);
    if (!st) {
      st = { handle, items: [], nextSeq: 0, settledIds: new Set(), restoredResults: new Map() };
      this.states.set(handle, st);
    }
    return st;
  }

  /** Withdrawal: `AskOptions.signal` aborting before an answer. */
  private watch(st: RunState, item: Item, signal: AbortSignal | undefined): void {
    if (!signal) return;
    const onAbort = () => {
      const wasPresented = item.rec.state === "presented";
      if (!this.settle(st, item, "withdrawn", { outcome: "withdrawn" })) return;
      if (wasPresented) this.advance(st);
    };
    if (signal.aborted) return void queueMicrotask(onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    item.offAbort = () => signal.removeEventListener("abort", onAbort);
  }

  // ─── Presentation ───────────────────────────────────────────────────────────

  /** Present `item`: state, expiry clock, record, A2A task state, the status message; the run parks. */
  private present(st: RunState, item: Item): void {
    const host = this.host!;
    const now = host.now();
    if (!item.fixedExpiry) {
      const expiresAt = new Date(Date.parse(now) + timeoutFor(this.policy, item.interaction.kind)).toISOString();
      item.interaction = { ...item.interaction, expiresAt } as CoreInteraction;
      item.rec = { ...item.rec, interaction: item.interaction, expiresAt };
    }
    item.rec = { ...item.rec, state: "presented", updatedAt: now };
    this.persist(item);
    this.armTimer(st, item);
    host.setRunState(st.handle.taskId, stateFor(item.interaction.kind));
    try {
      st.handle.sink?.interaction(item.interaction);
    } catch (e) {
      host.log.warn("publishing an interaction failed", e instanceof Error ? e.message : String(e));
    }
    st.handle.signalParked();
  }

  private armTimer(st: RunState, item: Item): void {
    clearTimeout(item.timer);
    const delay = Math.min(Math.max(0, Date.parse(item.rec.expiresAt) - Date.parse(this.host!.now())), MAX_TIMER_MS);
    const timer = setTimeout(() => this.onExpire(st, item), delay);
    timer.unref?.(); // an unanswered interaction must not keep the process alive
    item.timer = timer;
  }

  /** The presented interaction ended and the run goes on: present the next queued one, or back to `working`. */
  private advance(st: RunState, publisher?: { status(u: { state: CoreTaskState }): void }): void {
    const host = this.host!;
    const next = st.items.filter((i) => i.rec.state === "queued").sort((a, b) => a.rec.seq - b.rec.seq)[0];
    if (next) return this.present(st, next);
    st.handle.signalResumed();
    host.setRunState(st.handle.taskId, "working");
    try {
      (publisher ?? st.handle.sink)?.status({ state: "working" });
    } catch (e) {
      host.log.warn("publishing the resume failed", e instanceof Error ? e.message : String(e));
    }
  }

  // ─── Ending an interaction ──────────────────────────────────────────────────

  /**
   * End one interaction exactly once: clear its timer and listeners, store the outcome (secrets
   * redacted) and resolve the provider's promise. Synchronous, so it can run inside the
   * registry's terminal claim.
   */
  private settle(st: RunState, item: Item, final: "answered" | "expired" | "canceled" | "withdrawn", result: CoreInteractionResult): boolean {
    if (item.settled) return false;
    item.settled = true;
    clearTimeout(item.timer);
    item.unregister?.();
    item.offAbort?.();
    st.items = st.items.filter((i) => i !== item);
    st.settledIds.add(item.interaction.id);
    if (item.restored && item.rec.handle !== undefined) st.restoredResults.set(item.rec.handle, result);
    const { result: stored, redacted } = redactSecretAnswers(item.interaction, result);
    item.rec = {
      ...item.rec,
      state: final,
      updatedAt: this.host!.now(),
      result: redacted.length > 0 ? { ...stored, redacted } : stored,
    };
    this.persist(item);
    item.resolve(result);
    return true;
  }

  private onExpire(st: RunState, item: Item): void {
    if (item.settled) return;
    const host = this.host!;
    // A timer is capped at 2^31-1 ms (and may fire a hair early): until the deadline has really passed, wait on.
    if (Date.parse(host.now()) < Date.parse(item.rec.expiresAt)) return this.armTimer(st, item);
    const title = item.interaction.title;
    this.settle(st, item, "expired", { outcome: "expired" });
    if (this.policy.onTimeout === "fail") {
      void host
        .expire(st.handle.taskId, { message: `The request "${title}" was not answered in time.`, code: "timeout" })
        .catch((e) => host.log.warn("expire failed", e instanceof Error ? e.message : String(e)));
      return;
    }
    this.advance(st);
  }

  private persist(item: Item): void {
    const host = this.host!;
    const snapshot = { ...item.rec };
    item.chain = item.chain
      .then(() => host.store.putPending(snapshot))
      .catch((e) => host.log.warn("pending record write failed", e instanceof Error ? e.message : String(e)));
    host.track(item.chain);
  }

  // ─── Replies ────────────────────────────────────────────────────────────────

  /**
   * A new `execute()` for a task with a live run. When the task has a presented interaction the
   * message is a reply attempt: consumed here, never started as a turn. NEVER throws.
   */
  async handleReply(handle: RunInteractionHandle, init: ExecuteInit, options: HandleReplyOptions = {}): Promise<boolean> {
    const st = this.states.get(handle);
    const reprompt = options.reprompt !== false;
    try {
      const presented = () => st?.items.find((i) => i.rec.state === "presented");
      const first = presented();
      const parts = init.message?.parts ?? [];
      if (!st || !first) {
        // Nothing is open. A late or duplicate structured reply for an interaction that already ended is ignored. The
        // store is the authority (it still knows after a restart); the in-process set is only a cache in front of it.
        if (!st) return false;
        for (const p of parts) {
          const id = p.kind === "data" ? (p.data as { interactionId?: unknown } | null)?.interactionId : undefined;
          if (typeof id !== "string") continue;
          if (st.settledIds.has(id)) return true;
          const rec = await this.host!.store.getPending(handle.taskId, id).catch(() => undefined);
          if (rec && !isOpenInteractionState(rec.state)) return true;
        }
        return false;
      }
      // A request with a private stream cannot carry the run on, so it cannot be the reply to the presented one.
      if (options.carriesStream === false) return false;
      const host = this.host!;
      const allowed = await host.authorize(init.caller, "answer", {
        taskId: handle.taskId,
        contextId: handle.contextId,
        ownerId: handle.owner.id,
      });
      const item = presented(); // the world may have moved while authorize was pending
      if (!item) return reprompt;
      let result: CoreInteractionResult | undefined;
      if (allowed) {
        try {
          result = parseInteractionReply(item.interaction, parts, init.caller);
        } catch {
          result = undefined; // a reply that crashes the parser is not a reply (D5)
        }
      }
      // An explicit `delivery: "queue"` that is not a usable reply is not consumed (and does not take the run's
      // stream over): the registry queues it behind the interaction.
      if (!reprompt && !result) return false;
      handle.setPublisher(init.publisher);
      if (!allowed) return this.reprompt(init, item, HINT_DENIED);
      if (!result) return this.reprompt(init, item, HINT_NO_MATCH);

      this.settle(st, item, "answered", result);
      this.advance(st, init.publisher);
      return true;
    } catch (e) {
      this.host?.log.warn("handleReply failed", e instanceof Error ? e.message : String(e));
      // Anything open means the message was meant as a reply: consume it rather than run it as a turn.
      return !!st && st.items.length > 0;
    }
  }

  /** Re-publish the presented interaction with a hint; the run stays parked. */
  private reprompt(init: ExecuteInit, item: Item, hint: string): boolean {
    try {
      init.publisher.interaction(item.interaction, { hint });
    } catch (e) {
      this.host?.log.warn("re-prompt failed", e instanceof Error ? e.message : String(e));
    }
    return true;
  }

  // ─── Secrets in the A2A history ─────────────────────────────────────────────

  /** Message ids recognised as answers to a secret question (bounded; a task store may save the same history again later). */
  private readonly secretMessageIds = new Set<string>();

  /**
   * The SDK appends a reply to the task's `history` and saves it BEFORE `execute()` runs, so a secret answer would sit in
   * the stored task in clear (`tasks/get`). The task store wrapper asks here for every user message it persists and stores
   * what comes back: the same parts with the answers to `secret` questions removed.
   *
   * - A structured answer (`{interactionId, answers}`) is judged by the stored interaction it names, so it needs no live run
   *   and survives a restart: the `text` / `freeText` of its secret questions are dropped.
   * - A text-only reply cannot name its interaction. It is replaced entirely when it is the message the SDK just appended
   *   (`isNew`) and the PRESENTED interaction has a secret question (the text may be the secret), and remembered by message id,
   *   so a later save of the same history (the reply's Task snapshot) hides it too.
   *
   * The provider is unaffected (it reads the message from the request, not from the store). Never mutates `parts`.
   */
  async redactReply(
    target: { taskId: string; handle?: RunInteractionHandle },
    messageId: string,
    parts: readonly CorePart[],
    isNew: boolean,
  ): Promise<readonly CorePart[] | undefined> {
    try {
      let changed = false;
      const out: CorePart[] = [];
      let hasStructured = false;
      for (const p of parts) {
        const d = p.kind === "data" && p.data && typeof p.data === "object" ? (p.data as { interactionId?: unknown; answers?: unknown }) : undefined;
        if (!d || typeof d.interactionId !== "string") {
          out.push(p);
          continue;
        }
        hasStructured = true;
        const rec = d.answers && typeof d.answers === "object" ? await this.host?.store.getPending(target.taskId, d.interactionId) : undefined;
        const secretIds = new Set(
          ((rec?.interaction as { questions?: readonly { id: string; secret?: boolean }[] } | undefined)?.questions ?? []).filter((q) => q.secret).map((q) => q.id),
        );
        if (secretIds.size === 0) {
          out.push(p);
          continue;
        }
        const answers: Record<string, unknown> = {};
        for (const [qid, a] of Object.entries(d.answers as Record<string, unknown>)) {
          if (secretIds.has(qid) && a && typeof a === "object") {
            const { text, freeText, ...rest } = a as { text?: unknown; freeText?: unknown };
            if (text !== undefined || freeText !== undefined) changed = true;
            answers[qid] = rest;
          } else answers[qid] = a;
        }
        out.push({ ...(p as Extract<CorePart, { kind: "data" }>), data: { ...d, answers } as never });
      }
      if (!hasStructured) {
        const st = target.handle ? this.states.get(target.handle) : undefined;
        const presentedSecret = isNew && !!st?.items.some((i) => i.rec.state === "presented" && hasSecretQuestion(i.interaction));
        if (presentedSecret) {
          if (this.secretMessageIds.size >= 1000) this.secretMessageIds.delete(this.secretMessageIds.values().next().value!);
          this.secretMessageIds.add(messageId);
        }
        if (this.secretMessageIds.has(messageId)) {
          return parts.map((p) => (p.kind === "text" && p.text.trim() !== "" ? { ...p, text: "[answer to a secret question removed]" } : p));
        }
        return undefined;
      }
      return changed ? out : undefined;
    } catch {
      return undefined;
    }
  }

  // ─── Restart ────────────────────────────────────────────────────────────────

  /** The sweep re-created the run: put its open interactions (those with a provider handle) back in front of it. */
  restore(handle: RunInteractionHandle, records: readonly PendingInteraction[]): void {
    const st = this.stateOf(handle);
    for (const rec of [...records].sort((a, b) => a.seq - b.seq)) {
      if (rec.state !== "queued" && rec.state !== "presented") continue;
      let resolve!: (r: CoreInteractionResult) => void;
      const promise = new Promise<CoreInteractionResult>((r) => (resolve = r));
      const item: Item = {
        rec: { ...rec },
        interaction: rec.interaction,
        promise,
        resolve,
        fixedExpiry: true,
        restored: true,
        settled: false,
        chain: Promise.resolve(),
      };
      st.items.push(item);
      st.nextSeq = Math.max(st.nextSeq, rec.seq);
      item.unregister = handle.registerPending({ cancel: () => void this.settle(st, item, "canceled", { outcome: "canceled" }) });
    }
    const shown = st.items.find((i) => i.rec.state === "presented") ?? st.items.filter((i) => i.rec.state === "queued")[0];
    if (!shown) return;
    if (shown.rec.state === "presented") {
      this.armTimer(st, shown);
      handle.signalParked(); // the A2A task already reads input-required; nothing to publish
    } else {
      this.present(st, shown);
    }
  }
}
