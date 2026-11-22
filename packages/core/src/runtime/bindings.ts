/**
 * @module runtime/bindings
 *
 * The context-binding runtime (issue #110): everything core does with a `ContextBinding`, in one place and
 * SDK-free. A binding is the persisted `contextId -> provider session` link that lets a provider resume a
 * conversation after a restart (`CoreRequest.session`, written with `run.bind`).
 *
 * What lives here:
 *
 * - **resolve** (at turn start, AFTER the context's lane slot is held): load the binding and decide whether this caller
 *   may resume it. Another caller's context is refused (spec 13.1), a binding written by another provider or version is
 *   discarded and never replayed, an expired one is dropped, and only then is the session handed to the provider.
 * - **bind**: persist `run.bind`, replacing the previous binding, never from a stale turn and never over another
 *   caller's binding.
 * - **discard / forget**: clear a binding (an abort outcome of `discard`, a session the backend does not know).
 * - **sweep / validate**: the binding GC (`sweepBindings`) and the optional start-up probe (`probeSession`).
 *
 * Every operation on one context goes through one promise chain (`serial`), so a read-then-write never interleaves
 * with another write and a turn that starts reads what the previous turn bound. The only state kept in the
 * process is that chain and the last bind order per context (`lastBindSeq`); both are caches of ordering, the
 * bindings themselves live in the `RunStore`.
 *
 * Logging never includes a session `ref` or `meta` (they can be credentials-adjacent: a thread id, a resume token).
 *
 * @see docs/design/core-data-model.md sections 3.2, 3.5, 3.6, 3.8
 */

import {
  isJson,
  newRecordHeader,
  type ContextBinding,
  type CoreCaller,
  type CoreError,
  type SessionProbe,
  type SessionRef,
} from "../model/index.js";
import type { RunStore } from "./run-store.js";
import type { AuthTarget, RuntimeLogger } from "./types.js";

/** What {@link ContextBindings.resolve} decided for a turn that is about to start. */
export type BindingResolution =
  /** No usable binding: start a fresh session. */
  | { kind: "none" }
  /** Resume this session. */
  | { kind: "session"; session: SessionRef }
  /** Do not run the turn: it must be rejected with `error`. The binding was left untouched. */
  | { kind: "rejected"; error: CoreError };

/** What {@link ContextBindings.resolve} needs to know about the turn. */
export interface ResolveInput {
  contextId: string;
  taskId: string;
  /** Who is sending this turn. */
  caller: CoreCaller;
  tenant?: string;
}

/** What {@link ContextBindings.bind} needs to know about the bind. */
export interface BindInput {
  contextId: string;
  caller: CoreCaller;
  tenant?: string;
  session: SessionRef;
  /** The turn's start order (process-wide, increasing). A bind from an older turn than the last one that bound is dropped. */
  seq: number;
}

/** Result of `sweepBindings`. */
export interface BindingSweepReport {
  /** Contexts whose binding was removed. */
  removed: string[];
  /** Contexts whose binding was kept because a run (live, parked or orphaned) still needs it. */
  skippedBusy: string[];
  /** Bindings looked at and kept (not expired, or no TTL). */
  kept: number;
}

/** Result of the start-up validation. */
export interface BindingValidationReport {
  alive: string[];
  /** The backend does not have the session: the binding was deleted. */
  gone: string[];
  /** Kept: the provider cannot tell (no `probeSession`, it failed or timed out, or it said `unknown`). */
  unknown: string[];
  /** Not probed: the binding was written by another provider or version, or its context has a live run. */
  skipped: string[];
}

export interface ContextBindingsOptions {
  store: RunStore;
  log: RuntimeLogger;
  now(): string;
  /**
   * The issuer core stamps on a binding it writes now: `<provider id>@<ProviderInfo.sessionFormat ?? "1">` by default.
   * `provider.release` is only ever called for a binding whose issuer EQUALS this one.
   */
  issuer(): string;
  /** Drop provider state for a discarded session. Bounded, never rejects. */
  release(ref: string): Promise<void>;
  /** `provider.probeSession`, bounded: `"unknown"` on failure or timeout. Absent when the provider cannot probe. */
  probe?: (session: SessionRef) => Promise<SessionProbe>;
  /** The single authorization choke point. */
  authorize(by: CoreCaller, action: string, target: AuthTarget): boolean | Promise<boolean>;
  /** Does this process have a run (live, parked or waiting in the lane) for the context? */
  busy(contextId: string): boolean;
  /** Binding TTL in ms, measured from `lastUsedAt` (else `updatedAt`). `undefined`: bindings never expire. */
  ttlMs?: number;
}

/** Concurrent `probeSession` calls during start-up validation. */
const PROBE_CONCURRENCY = 4;

/** The one place a `session` supplied by a provider is checked: it must be storable. Throws `TypeError`. */
export function assertBindable(session: SessionRef): void {
  if (typeof session?.ref !== "string" || session.ref.length === 0) {
    throw new TypeError("bind: `ref` must be a non-empty string");
  }
  if (session.meta !== undefined && !isJson(session.meta)) {
    throw new TypeError("bind: `meta` must be JSON-safe (it is persisted with the binding)");
  }
}

function causeMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** See the module comment. Owned by `RunRegistry`. */
export class ContextBindings {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly lastBindSeq = new Map<string, number>();

  constructor(private readonly o: ContextBindingsOptions) {}

  /** Run `fn` after everything already queued for this context. A rejection reaches the caller, never the chain. */
  private serial<T>(contextId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(contextId) ?? Promise.resolve();
    const run = prev.then(fn);
    const link = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(contextId, link);
    void link.then(() => {
      if (this.chains.get(contextId) === link) {
        this.chains.delete(contextId);
        // Nothing is queued any more for this context.
      }
    });
    return run;
  }

  /** The context has no run in this process any more: its bind-order cache is no longer needed. */
  contextIdle(contextId: string): void {
    if (!this.chains.has(contextId)) this.lastBindSeq.delete(contextId);
  }

  private expired(b: ContextBinding, ttlMs: number | undefined): boolean {
    if (ttlMs === undefined) return false;
    const used = Date.parse(b.lastUsedAt ?? b.updatedAt);
    const now = Date.parse(this.o.now());
    return Number.isFinite(used) && Number.isFinite(now) && now - used > ttlMs;
  }

  /** The binding as stored, after everything queued before this call. No checks, no touch. */
  peek(contextId: string): Promise<ContextBinding | undefined> {
    return this.serial(contextId, () => this.o.store.getBinding(contextId)).catch(() => undefined);
  }

  /**
   * Decide what a turn that is about to start may resume. Call it after the context's lane slot is acquired, so the
   * previous turn's `bind` has been persisted (writes of one context are serialized) and no stale binding is read.
   *
   * In order:
   * 1. no binding, or a binding with no session: start fresh;
   * 2. **owner** (spec 13.1): the binding belongs to the caller (id, kind and tenant) that started the context. Anybody
   *    else is REFUSED (`forbidden`, detail `reason: "context-owner-mismatch"`), never silently given a fresh session on
   *    someone else's context id, and nothing is changed;
   * 3. **issuer**: a binding written by another provider, version or configured issuer is discarded (not replayed): the
   *    binding is deleted, `provider.release` is called only when the issuer names THIS provider (another version of
   *    it), and the turn starts fresh;
   * 4. **TTL** (`bindingTtlMs`): an expired binding is deleted and released, the turn starts fresh;
   * 5. `authorize(by, "resume", target)`: a denial refuses the turn (`forbidden`, detail `reason: "denied"`);
   * 6. the binding is touched (`lastUsedAt`) and its session returned.
   *
   * Never rejects: a store failure is logged and treated as "no binding".
   */
  async resolve(i: ResolveInput): Promise<BindingResolution> {
    let toRelease: string | undefined;
    const result = await this.serial(i.contextId, async (): Promise<BindingResolution> => {
      let b: ContextBinding | undefined;
      try {
        b = await this.o.store.getBinding(i.contextId);
      } catch (e) {
        this.o.log.warn(`reading the context binding failed: ${causeMessage(e)}`);
        return { kind: "none" };
      }
      const session = b?.session;
      if (!b || !session) return { kind: "none" };

      if (b.owner.id !== i.caller.id || b.owner.kind !== i.caller.kind || (b.tenant ?? "") !== (i.tenant ?? "")) {
        this.o.log.warn(`task ${i.taskId}: context binding belongs to another caller; refusing to resume it`);
        return {
          kind: "rejected",
          error: {
            code: "forbidden",
            message: "this context belongs to another caller",
            detail: { reason: "context-owner-mismatch" },
          },
        };
      }

      if (session.issuer !== this.o.issuer()) {
        // Another provider, or the same provider with another session FORMAT: never replayed, never released (the old format
        // may still own that session, and the new one may not understand the ref).
        this.o.log.warn(`task ${i.taskId}: discarding a context binding written by another provider or session format`);
        await this.deleteQuietly(i.contextId, session.ref);
        return { kind: "none" };
      }

      if (this.expired(b, this.o.ttlMs)) {
        this.o.log.warn(`task ${i.taskId}: context binding expired (bindingTtlMs); starting a fresh session`);
        await this.deleteQuietly(i.contextId, session.ref);
        toRelease = session.ref;
        return { kind: "none" };
      }

      let allowed = false;
      try {
        allowed = (await this.o.authorize(i.caller, "resume", {
          taskId: i.taskId,
          contextId: i.contextId,
          ownerId: b.owner.id,
        })) === true;
      } catch (e) {
        this.o.log.warn(`authorize(resume) threw: ${causeMessage(e)}`);
      }
      if (!allowed) {
        return {
          kind: "rejected",
          error: { code: "forbidden", message: "resuming this context is not allowed", detail: { reason: "denied" } },
        };
      }

      await this.o.store.touchBinding(i.contextId, this.o.now(), session.ref).catch((e) =>
        this.o.log.warn(`touching the context binding failed: ${causeMessage(e)}`),
      );
      return { kind: "session", session: { ref: session.ref, ...(session.meta ? { meta: session.meta } : {}) } };
    });
    if (toRelease) await this.o.release(toRelease);
    return result;
  }

  private async deleteQuietly(contextId: string, ref: string): Promise<void> {
    try {
      await this.o.store.deleteBinding(contextId, ref);
    } catch (e) {
      this.o.log.warn(`deleting the context binding failed: ${causeMessage(e)}`);
    }
  }

  /**
   * Persist `run.bind`. Replaces the previous binding (keeping its owner and `createdAt`). Dropped, with a debug log:
   * a bind from a turn older than the last one that bound this context (a stale turn must not overwrite a newer
   * binding) and a bind over a binding another caller owns. Never rejects.
   */
  bind(i: BindInput): Promise<void> {
    return this.serial(i.contextId, async () => {
      if ((this.lastBindSeq.get(i.contextId) ?? -1) > i.seq) {
        this.o.log.debug?.("dropping a bind from a turn older than the one that bound last");
        return;
      }
      const prev = await this.o.store.getBinding(i.contextId);
      if (prev && (prev.owner.id !== i.caller.id || prev.owner.kind !== i.caller.kind || (prev.tenant ?? "") !== (i.tenant ?? ""))) {
        this.o.log.warn("not binding: the context's binding belongs to another caller");
        return;
      }
      this.lastBindSeq.set(i.contextId, i.seq);
      const at = this.o.now();
      const header = prev ?? newRecordHeader({ id: i.caller.id, kind: i.caller.kind }, at, i.tenant);
      const binding: ContextBinding = {
        ...header,
        updatedAt: at,
        lastUsedAt: at,
        contextId: i.contextId,
        session: { ref: i.session.ref, ...(i.session.meta ? { meta: i.session.meta } : {}), issuer: this.o.issuer() },
      };
      await this.o.store.putBinding(binding);
    }).catch((e) => this.o.log.warn(`binding write failed: ${causeMessage(e)}`));
  }

  /** The last use of a binding (a turn that used it ended): keeps a long conversation from looking idle to the TTL. */
  touch(contextId: string, ref: string): Promise<void> {
    return this.serial(contextId, () => this.o.store.touchBinding(contextId, this.o.now(), ref))
      .then(() => undefined)
      .catch((e) => this.o.log.warn(`touching the context binding failed: ${causeMessage(e)}`));
  }

  /**
   * The backend does not know the session (`SESSION_NOT_FOUND`): delete the binding if it still names `ref`. Nothing to
   * release (the backend says it is gone). Never rejects.
   */
  forget(contextId: string, ref: string): Promise<void> {
    return this.serial(contextId, () => this.o.store.deleteBinding(contextId, ref))
      .then(() => undefined)
      .catch((e) => this.o.log.warn(`deleting the context binding failed: ${causeMessage(e)}`));
  }

  /**
   * An abort outcome of `discard`: delete the binding (only when it still names `session.ref`, if one is known) and call
   * `provider.release` with the ref, unless the binding was written by another provider (its ref is not this provider's).
   * Never rejects.
   */
  async discard(contextId: string, ref: string | undefined): Promise<void> {
    let releaseRef = ref;
    let releasable = true;
    try {
      await this.serial(contextId, async () => {
        const b = await this.o.store.getBinding(contextId);
        if (b?.session && (!ref || b.session.ref === ref)) {
          releaseRef = b.session.ref;
          releasable = b.session.issuer === this.o.issuer();
          await this.o.store.deleteBinding(contextId, b.session.ref);
        }
      });
    } catch (e) {
      this.o.log.warn(`clearing the context binding failed: ${causeMessage(e)}`);
    }
    if (releaseRef && releasable) await this.o.release(releaseRef);
  }

  /**
   * Binding GC. Removes the bindings that were last used more than `olderThanMs` ago (default `bindingTtlMs`; with
   * neither, nothing is removed) AND whose context has no non-terminal run: not live or parked in this process, and no
   * `active`, `interrupted` or `unknown` run record in the store (an orphan still needs its session for `abortOrphan`).
   * `provider.release` is called for each removed session this provider wrote.
   */
  async sweep(options: { olderThanMs?: number } = {}): Promise<BindingSweepReport> {
    const report: BindingSweepReport = { removed: [], skippedBusy: [], kept: 0 };
    const ttl = options.olderThanMs ?? this.o.ttlMs;
    const all = await this.o.store.listBindings();
    if (ttl === undefined) {
      report.kept = all.length;
      return report;
    }
    const runContexts = new Set((await this.o.store.listNonTerminalRuns()).map((r) => r.contextId));
    for (const b of all) {
      if (!this.expired(b, ttl)) {
        report.kept++;
        continue;
      }
      if (this.o.busy(b.contextId) || runContexts.has(b.contextId)) {
        report.skippedBusy.push(b.contextId);
        continue;
      }
      let releaseRef: string | undefined;
      const removed = await this.serial(b.contextId, async () => {
        // Look again inside the context's queue: it may have been touched, rebound or started meanwhile.
        const cur = await this.o.store.getBinding(b.contextId);
        if (!cur || !this.expired(cur, ttl) || this.o.busy(b.contextId)) return false;
        const ok = cur.session ? await this.o.store.deleteBinding(b.contextId, cur.session.ref) : await this.o.store.deleteBinding(b.contextId);
        if (ok && cur.session && cur.session.issuer === this.o.issuer()) releaseRef = cur.session.ref;
        return ok;
      }).catch((e) => {
        this.o.log.warn(`removing an expired context binding failed: ${causeMessage(e)}`);
        return false;
      });
      if (removed) {
        report.removed.push(b.contextId);
        if (releaseRef) await this.o.release(releaseRef);
      } else report.kept++;
    }
    return report;
  }

  /**
   * Start-up validation: ask the provider (`probeSession`) whether each binding it wrote still resolves, and delete the
   * `gone` ones. `alive`, `unknown` (also: no `probeSession`, a failure, a timeout) keep the binding; the first resume
   * decides. A binding written by another provider or version is not probed (resume discards it), and a context with a
   * run in this process is skipped.
   */
  async validate(): Promise<BindingValidationReport> {
    const report: BindingValidationReport = { alive: [], gone: [], unknown: [], skipped: [] };
    const all = await this.o.store.listBindings();
    const todo: ContextBinding[] = [];
    for (const b of all) {
      if (!b.session || b.session.issuer !== this.o.issuer() || this.o.busy(b.contextId)) report.skipped.push(b.contextId);
      else todo.push(b);
    }
    if (!this.o.probe) {
      for (const b of todo) report.unknown.push(b.contextId);
      return report;
    }
    const probe = this.o.probe;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, todo.length) }, async () => {
        while (next < todo.length) {
          const b = todo[next++];
          const session = b.session!;
          let verdict: SessionProbe = "unknown";
          try {
            const v = await probe({ ref: session.ref, ...(session.meta ? { meta: session.meta } : {}) });
            verdict = v === "alive" || v === "gone" ? v : "unknown";
          } catch {
            verdict = "unknown";
          }
          if (verdict === "gone") {
            const removed = await this.serial(b.contextId, async () => {
              if (this.o.busy(b.contextId)) return false;
              return this.o.store.deleteBinding(b.contextId, session.ref);
            }).catch(() => false);
            if (removed) report.gone.push(b.contextId);
            else report.unknown.push(b.contextId);
          } else report[verdict].push(b.contextId);
        }
      }),
    );
    return report;
  }
}
