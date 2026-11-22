/**
 * @module model/cancel
 *
 * The cancellation sentinel. It lives here, in the SDK-free model, so
 * `model/run.ts` can name it without importing `executor/task-runs` (which
 * imports the A2A SDK). `executor/task-runs` re-exports it unchanged.
 */

/** Value `run.race()` resolves with when the run was canceled first. */
export const CANCELED: unique symbol = Symbol("a2a.task.canceled");
