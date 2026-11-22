/**
 * @module runtime/run-store
 *
 * Where the run runtime keeps its records: one {@link RunRecord} per task, one
 * {@link ContextBinding} per context and the {@link QueuedMessageRecord}s of a
 * task. An interface plus an in-memory implementation; persistent stores come
 * with the persistence work (#69) and implement the same interface.
 *
 * Every operation is async so a database can implement it. The in-memory store
 * stores the ENCODED form of each record (`encodeRecord`), so a record that is
 * not JSON-safe fails at write time, exactly as a persistent store would, and a
 * reader never shares mutable state with the writer. Only live records are
 * encoded: re-encoding stored JSON throws (`$bytes:v1` is reserved), so the store
 * decodes on read and callers hand it live records.
 *
 * @see docs/design/core-data-model.md section 3.6
 */

import {
  classifyState,
  decodeRecord,
  encodeRecord,
  type ContextBinding,
  type PendingInteraction,
  type QueuedMessageRecord,
  type QueuedMessageState,
  type RunRecord,
  type StoredRecord,
} from "../model/index.js";

/** Storage for the run runtime. Implementations must make {@link RunStore.claimQueued} atomic. */
export interface RunStore {
  /** The record of a task, if any. */
  getRun(taskId: string): Promise<RunRecord | undefined>;
  /** Insert or replace the record of `record.taskId`. */
  putRun(record: RunRecord): Promise<void>;
  /** Records whose state is not terminal (`classifyState` is `active`, `interrupted` or `unknown`). */
  listNonTerminalRuns(): Promise<RunRecord[]>;

  getBinding(contextId: string): Promise<ContextBinding | undefined>;
  /**
   * Insert or replace the binding of `binding.contextId`. A SQL store (#69) should add a compare-and-set (for example
   * `putBinding(binding, { ifUnchanged: updatedAt })`) so two core processes cannot both pass the owner check and overwrite
   * each other's binding: core orders writes only inside one process.
   */
  putBinding(binding: ContextBinding): Promise<void>;
  /**
   * Remove the binding of a context. With `ifRef`, only when its session `ref` is that one (a compare-and-delete, so a
   * binding that was replaced in the meantime survives). Resolves `true` when a binding was removed.
   */
  deleteBinding(contextId: string, ifRef?: string): Promise<boolean>;
  /** Every binding, in no particular order (the GC and the start-up validation walk them). */
  listBindings(): Promise<ContextBinding[]>;
  /**
   * Record that the binding was just used: set `lastUsedAt` to `at`, leave everything else (`updatedAt` included)
   * alone. Only when the binding exists and, with `ifRef`, its session `ref` is that one (so a touch never revives
   * a deleted binding or marks a replaced one). Resolves `true` when it changed the record.
   */
  touchBinding(contextId: string, at: string, ifRef?: string): Promise<boolean>;

  /** Insert or replace a queued message (keyed by `taskId` and `message.id`). */
  putQueued(record: QueuedMessageRecord): Promise<void>;
  /** The queued messages of a task, in `position` order (insertion order when absent). */
  listQueued(taskId: string): Promise<QueuedMessageRecord[]>;
  /**
   * Compare-and-set the state of one queued message: set `to` only if the record
   * is currently in `from`. Resolves `true` when this call made the change. This
   * is the atomic claim (`queued -> running`) that keeps a message from being
   * started twice, by two instances or across a crash.
   */
  claimQueued(
    taskId: string,
    messageId: string,
    from: QueuedMessageState,
    to: QueuedMessageState,
    reason?: string,
  ): Promise<boolean>;

  /** Insert or replace a pending interaction (keyed by `taskId` and `interaction.id`). Secrets must already be redacted. */
  putPending(record: PendingInteraction): Promise<void>;
  /** One pending interaction of a task. */
  getPending(taskId: string, interactionId: string): Promise<PendingInteraction | undefined>;
  /** Every interaction of a task, in `seq` order, whatever its state. */
  listPending(taskId: string): Promise<PendingInteraction[]>;
}

const pendingKey = (taskId: string, interactionId: string): string => `${taskId}\u0000${interactionId}`;

const queuedKey = (taskId: string, messageId: string): string => `${taskId}\u0000${messageId}`;

/** In-memory {@link RunStore}. Records are stored encoded and decoded on read. */
export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, StoredRecord>();
  private readonly bindings = new Map<string, StoredRecord>();
  private readonly queued = new Map<string, StoredRecord>();
  private readonly pending = new Map<string, StoredRecord>();

  async getRun(taskId: string): Promise<RunRecord | undefined> {
    const s = this.runs.get(taskId);
    return s ? decodeRecord<RunRecord>(s) : undefined;
  }

  async putRun(record: RunRecord): Promise<void> {
    this.runs.set(record.taskId, encodeRecord(record));
  }

  async listNonTerminalRuns(): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .map((s) => decodeRecord<RunRecord>(s))
      .filter((r) => classifyState(r.state) !== "terminal");
  }

  async getBinding(contextId: string): Promise<ContextBinding | undefined> {
    const s = this.bindings.get(contextId);
    return s ? decodeRecord<ContextBinding>(s) : undefined;
  }

  async putBinding(binding: ContextBinding): Promise<void> {
    this.bindings.set(binding.contextId, encodeRecord(binding));
  }

  async deleteBinding(contextId: string, ifRef?: string): Promise<boolean> {
    const s = this.bindings.get(contextId);
    if (!s) return false;
    if (ifRef !== undefined && (s.session as { ref?: string } | undefined)?.ref !== ifRef) return false;
    this.bindings.delete(contextId);
    return true;
  }

  async listBindings(): Promise<ContextBinding[]> {
    return [...this.bindings.values()].map((s) => decodeRecord<ContextBinding>(s));
  }

  async touchBinding(contextId: string, at: string, ifRef?: string): Promise<boolean> {
    // No await between the read and the write: atomic on one event loop.
    const s = this.bindings.get(contextId);
    if (!s) return false;
    if (ifRef !== undefined && (s.session as { ref?: string } | undefined)?.ref !== ifRef) return false;
    const next = decodeRecord<ContextBinding>(s);
    next.lastUsedAt = at;
    this.bindings.set(contextId, encodeRecord(next));
    return true;
  }

  async putQueued(record: QueuedMessageRecord): Promise<void> {
    this.queued.set(queuedKey(record.taskId, record.message.id), encodeRecord(record));
  }

  async listQueued(taskId: string): Promise<QueuedMessageRecord[]> {
    const out: QueuedMessageRecord[] = [];
    for (const s of this.queued.values()) {
      if (s.taskId === taskId) out.push(decodeRecord<QueuedMessageRecord>(s));
    }
    return out.sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
  }

  async claimQueued(
    taskId: string,
    messageId: string,
    from: QueuedMessageState,
    to: QueuedMessageState,
    reason?: string,
  ): Promise<boolean> {
    // No await between the read and the write: this is atomic on one event loop.
    const key = queuedKey(taskId, messageId);
    const s = this.queued.get(key);
    if (!s || s.state !== from) return false;
    const next = decodeRecord<QueuedMessageRecord>(s);
    next.state = to;
    next.updatedAt = new Date().toISOString();
    if (reason !== undefined) next.reason = reason;
    this.queued.set(key, encodeRecord(next));
    return true;
  }

  async putPending(record: PendingInteraction): Promise<void> {
    this.pending.set(pendingKey(record.taskId, record.interaction.id), encodeRecord(record));
  }

  async getPending(taskId: string, interactionId: string): Promise<PendingInteraction | undefined> {
    const s = this.pending.get(pendingKey(taskId, interactionId));
    return s ? decodeRecord<PendingInteraction>(s) : undefined;
  }

  async listPending(taskId: string): Promise<PendingInteraction[]> {
    const out: PendingInteraction[] = [];
    for (const s of this.pending.values()) {
      if (s.taskId === taskId) out.push(decodeRecord<PendingInteraction>(s));
    }
    return out.sort((a, b) => a.seq - b.seq);
  }
}
