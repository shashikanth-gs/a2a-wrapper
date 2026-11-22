/**
 * @module executor/task-runs
 *
 * Provider-neutral task cancellation.
 *
 * Every wrapper has to answer the same A2A questions when `tasks/cancel`
 * arrives: which run is it, is it still cancelable, who publishes the terminal
 * event, and what happens to the events the aborted backend keeps producing.
 * Those answers are protocol rules, not provider behaviour, so they live here
 * once. A wrapper supplies only the provider-specific part: how to abort its
 * backend, and what to do if that fails.
 *
 * ### Contract
 *
 * - `begin()` registers a run when `execute` starts and returns a {@link TaskRun}.
 *   All of `execute`'s publishing goes through `run.bus`, which drops every event
 *   once the task is canceled, so late events from the aborted backend can never
 *   reach a finished task.
 * - `cancel()` on an unknown, finished or already-finalizing task is a silent
 *   no-op (idempotent), so a repeated or late cancel never publishes to a
 *   closed task.
 * - The run is claimed synchronously, so a completion racing the cancel cannot
 *   also publish a terminal state. Exactly one wins.
 * - `canceled` is published **before** the backend abort is awaited. Once
 *   `execute` returns the A2A SDK closes the task's event bus, so a terminal
 *   event published after a slow abort would be lost, leaving the stored task
 *   `working` and `tasks/cancel` failing with `TaskNotCancelable`.
 * - The abort is bounded by a timeout and never throws; on failure or timeout
 *   `onAbortFailed` lets the wrapper discard backend state it can no longer trust.
 *
 * @example
 * ```ts
 * private readonly runs = new TaskRunRegistry();
 *
 * async execute(ctx, rawBus) {
 *   const run = this.runs.begin(ctx.taskId, ctx.contextId, rawBus);
 *   try {
 *     const result = await run.race(backend.prompt(...));
 *     if (run.canceled) return;            // cancelTask already published
 *     if (!run.beginFinalize()) return;    // lost the race to a cancel
 *     publishFinalArtifact(run.bus, ...);
 *   } finally { run.end(); }
 * }
 *
 * cancelTask(taskId, bus) {
 *   return this.runs.cancel(taskId, bus, {
 *     abort: (run) => session.abort(),
 *     onAbortFailed: (run) => this.sessions.destroy(run.contextId),
 *   }).then(() => undefined);
 * }
 * ```
 */

import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import { publishStatus } from "../events/event-publisher.js";
import { CANCELED } from "../model/cancel.js";

/** Default upper bound on how long `cancel()` waits for the backend abort. */
export const DEFAULT_ABORT_TIMEOUT_MS = 5_000;

/** Value `run.race()` resolves with when the run was canceled first. Defined in `model/cancel` (SDK-free). */
export { CANCELED };

/** One in-flight task, as seen by the executor that is running it. */
export interface TaskRun {
  readonly taskId: string;
  readonly contextId: string;
  /** Publish through this, not the raw bus: it drops everything once canceled. */
  readonly bus: ExecutionEventBus;
  /** Aborted when the task is canceled. Pass to anything that accepts an `AbortSignal`. */
  readonly signal: AbortSignal;
  /** `true` once `cancel()` has claimed this run. */
  readonly canceled: boolean;
  /**
   * Await `work`, but wake up immediately with {@link CANCELED} if the task is
   * canceled first. If `work` later rejects (typical after an abort) the
   * rejection is swallowed so it cannot become unhandled.
   */
  race<T>(work: Promise<T>): Promise<T | typeof CANCELED>;
  /**
   * Claim the right to publish this run's terminal event (completed / failed).
   * Returns `false` if a cancel already claimed it; from then on a late
   * `cancel()` is a no-op. Idempotent.
   */
  beginFinalize(): boolean;
  /** Unregister the run. Call from `finally`. */
  end(): void;
}

/** Provider-specific parts of a cancellation. */
export interface CancelHooks {
  /** Stop the backend work for this run. Failures and timeouts are handled for you. */
  abort?(run: TaskRun): Promise<unknown> | unknown;
  /** The abort failed or timed out: discard whatever backend state can no longer be trusted. */
  onAbortFailed?(run: TaskRun, error: Error): Promise<unknown> | unknown;
  /** Upper bound for `abort`. Default {@link DEFAULT_ABORT_TIMEOUT_MS}. */
  abortTimeoutMs?: number;
}

interface RunState {
  run: TaskRun;
  canceled: boolean;
  finalizing: boolean;
  controller: AbortController;
  wake: () => void;
}

/** Tracks in-flight runs for one executor instance. */
export class TaskRunRegistry {
  private readonly runs = new Map<string, RunState>();

  /** Register a run. Call at the start of `execute`; pair with `run.end()` in `finally`. */
  begin(taskId: string, contextId: string, rawBus: ExecutionEventBus): TaskRun {
    const controller = new AbortController();
    let wake!: () => void;
    const canceledPromise = new Promise<typeof CANCELED>((resolve) => {
      wake = () => resolve(CANCELED);
    });

    const state = { canceled: false, finalizing: false } as RunState;

    const bus = new Proxy(rawBus, {
      get(target, prop) {
        if (prop === "publish") return (event: unknown) => { if (!state.canceled) (target as any).publish(event); };
        if (prop === "finished") return () => { if (!state.canceled) target.finished(); };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const registry = this;
    const run: TaskRun = {
      taskId,
      contextId,
      bus,
      signal: controller.signal,
      get canceled() { return state.canceled; },
      race<T>(work: Promise<T>) {
        work.catch(() => {}); // an aborted backend usually rejects; that's not a failure
        return Promise.race([work, canceledPromise]);
      },
      beginFinalize() {
        if (state.canceled) return false;
        state.finalizing = true;
        return true;
      },
      end() {
        if (registry.runs.get(taskId) === state) registry.runs.delete(taskId);
      },
    };

    state.run = run;
    state.controller = controller;
    state.wake = wake;
    this.runs.set(taskId, state);
    return run;
  }

  /** Is there an in-flight run for this task? */
  has(taskId: string): boolean {
    return this.runs.has(taskId);
  }

  /** The in-flight run for this task, if any. */
  get(taskId: string): TaskRun | undefined {
    return this.runs.get(taskId)?.run;
  }

  /**
   * Cancel a task. Resolves `true` if this call canceled it, `false` if there
   * was nothing cancelable (unknown, finished, already completing or already
   * canceled), in which case nothing is published. Never rejects.
   */
  async cancel(taskId: string, bus: ExecutionEventBus, hooks: CancelHooks = {}): Promise<boolean> {
    const state = this.runs.get(taskId);
    if (!state || state.canceled || state.finalizing) return false;

    // Claim synchronously, publish the terminal event, and only then wake
    // `execute` and abort the backend (see module doc for why the order matters).
    state.canceled = true;
    publishStatus(bus, taskId, state.run.contextId, "canceled", undefined, true);
    bus.finished();
    state.controller.abort();
    state.wake();

    if (hooks.abort) {
      const timeoutMs = hooks.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => hooks.abort!(state.run)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`abort timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        try {
          await hooks.onAbortFailed?.(state.run, error);
        } catch {
          /* best effort */
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return true;
  }
}
