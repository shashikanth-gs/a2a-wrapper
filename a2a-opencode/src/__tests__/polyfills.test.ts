import { describe, it, expect, vi } from "vitest";

type WithResolvers = <T>() => { promise: Promise<T>; resolve: (v: T) => void; reject: (e?: unknown) => void };
const P = Promise as unknown as { withResolvers?: WithResolvers };

describe("Promise.withResolvers polyfill (Node 20)", () => {
  it("installs a working implementation when missing", async () => {
    const original = P.withResolvers;
    delete P.withResolvers;
    try {
      vi.resetModules();
      await import("../utils/polyfills.js");
      expect(typeof P.withResolvers).toBe("function");
      const ok = P.withResolvers!<number>();
      ok.resolve(5);
      await expect(ok.promise).resolves.toBe(5);
      const bad = P.withResolvers!<number>();
      bad.reject(new Error("nope"));
      await expect(bad.promise).rejects.toThrow("nope");
    } finally {
      if (original) P.withResolvers = original;
    }
  });

  it("leaves a native implementation untouched", async () => {
    const native = (() => {}) as unknown as WithResolvers;
    const original = P.withResolvers;
    P.withResolvers = native;
    try {
      vi.resetModules();
      await import("../utils/polyfills.js");
      expect(P.withResolvers).toBe(native);
    } finally {
      if (original) P.withResolvers = original;
      else delete P.withResolvers;
    }
  });
});
