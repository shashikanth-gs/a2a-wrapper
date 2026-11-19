/**
 * Runtime polyfills for older supported Node versions (package.json: node >= 20).
 *
 * `@opencode/client` (OpenCode 2.x) uses `Promise.withResolvers()` in its event stream, which
 * only exists from Node 22. Without this, every 2.x prompt on Node 20 fails to subscribe to
 * events. The guard makes this a no-op on Node 22+.
 */

type Resolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const P = Promise as unknown as { withResolvers?: <T>() => Resolvers<T> };

if (typeof P.withResolvers !== "function") {
  P.withResolvers = function withResolvers<T>(): Resolvers<T> {
    let resolve!: Resolvers<T>["resolve"];
    let reject!: Resolvers<T>["reject"];
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
