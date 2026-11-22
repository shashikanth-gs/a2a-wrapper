/**
 * Input Queue — the SDK input stream of one Claude query
 *
 * A query in streaming-input mode reads its prompts from an async iterable. This one is a queue the turn pushes to: the
 * prompt first, then any message steered into the running turn. Passing an iterable (rather than a string) is what stops
 * the SDK closing the CLI's stdin on the first result, which is the only reason a second turn, a steered message or a
 * background-task report can ever arrive. Closing the queue ends the CLI's input, which lets the process exit and the
 * message iterator complete.
 *
 * The turn MUST close it on every exit path or the CLI subprocess stays alive.
 */

import type { SDKUserMessageLike } from "./client-factory.js";

export class InputQueue implements AsyncIterable<SDKUserMessageLike> {
  private readonly buffer: SDKUserMessageLike[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessageLike>) => void) | undefined;
  private isClosed = false;

  /** Queue a message. `false` (and nothing queued) once the queue is closed. */
  push(message: SDKUserMessageLike): boolean {
    if (this.isClosed) return false;
    const waiting = this.waiter;
    if (waiting) {
      this.waiter = undefined;
      waiting({ value: message, done: false });
    } else {
      this.buffer.push(message);
    }
    return true;
  }

  /** End the stream. Messages already queued are still delivered. */
  close(): void {
    this.isClosed = true;
    const waiting = this.waiter;
    if (waiting && this.buffer.length === 0) {
      this.waiter = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  get closed(): boolean {
    return this.isClosed;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessageLike> {
    return {
      next: () => {
        const next = this.buffer.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.isClosed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      // The SDK calls this when the query is torn down: end the stream so a parked `next` settles.
      return: () => {
        this.buffer.length = 0;
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
