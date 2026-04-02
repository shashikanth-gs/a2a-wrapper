/**
 * @module utils/deferred
 *
 * Promise utilities for externally-controlled resolution and timed delays.
 *
 * This module provides two primitives used extensively across A2A wrapper
 * projects:
 *
 * - {@link Deferred} / {@link createDeferred} — a promise whose `resolve` and
 *   `reject` callbacks are exposed as properties, enabling completion from a
 *   different code path than the one that created the promise. This pattern is
 *   common in streaming event handlers where the completion signal arrives
 *   asynchronously.
 *
 * - {@link sleep} — a simple timer-based delay that returns a promise,
 *   useful for polling loops and retry back-off.
 *
 * @example
 * ```ts
 * import { createDeferred, sleep } from '@a2a-wrapper/core';
 *
 * // Deferred usage — resolve from an event handler
 * const deferred = createDeferred<string>();
 * eventBus.on('done', (result) => deferred.resolve(result));
 * const value = await deferred.promise;
 *
 * // Sleep usage — wait 500 ms between retries
 * await sleep(500);
 * ```
 */

/**
 * A deferred promise whose `resolve` and `reject` callbacks are accessible
 * as properties, allowing external code to settle the promise.
 *
 * Created via {@link createDeferred}. The `promise` property is a standard
 * `Promise<T>` that settles when either `resolve` or `reject` is called.
 *
 * @typeParam T - The type of the value the promise resolves with.
 *
 * @example
 * ```ts
 * const d: Deferred<number> = createDeferred<number>();
 * d.resolve(42);
 * const result = await d.promise; // 42
 * ```
 */
export interface Deferred<T> {
  /** The underlying promise that settles when {@link resolve} or {@link reject} is called. */
  promise: Promise<T>;

  /** Resolves the deferred promise with the given value. */
  resolve: (value: T) => void;

  /** Rejects the deferred promise with an optional reason. */
  reject: (reason?: unknown) => void;
}

/**
 * Creates a new {@link Deferred} instance.
 *
 * The returned object exposes `resolve` and `reject` callbacks alongside the
 * `promise` they control. This is equivalent to extracting the executor
 * arguments from `new Promise()` and storing them externally.
 *
 * @typeParam T - The type of the value the promise resolves with.
 * @returns A new {@link Deferred} with an unsettled promise.
 *
 * @example
 * ```ts
 * const deferred = createDeferred<string>();
 *
 * // Later, in a callback or event handler:
 * deferred.resolve('done');
 *
 * // The consumer awaits the promise:
 * const result = await deferred.promise; // 'done'
 * ```
 */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Returns a promise that resolves after the specified number of milliseconds.
 *
 * Useful for introducing delays in polling loops, retry back-off strategies,
 * and test utilities. The returned promise always resolves (never rejects).
 *
 * @param ms - The delay duration in milliseconds. A value of `0` defers to
 *             the next event-loop tick via `setTimeout(..., 0)`.
 * @returns A promise that resolves with `void` after `ms` milliseconds.
 *
 * @example
 * ```ts
 * // Wait 1 second between retries
 * for (let attempt = 0; attempt < 3; attempt++) {
 *   try { return await fetchData(); }
 *   catch { await sleep(1000); }
 * }
 * ```
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
