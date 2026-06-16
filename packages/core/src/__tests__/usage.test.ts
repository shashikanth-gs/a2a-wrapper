import { describe, it, expect } from "vitest";
import {
  LlmUsageAccumulator,
  type UsageCallRecord,
  type ContextWindowSnapshot,
} from "@a2a-wrapper/core";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<UsageCallRecord> = {}): UsageCallRecord {
  return {
    model: "gpt-4o",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    reasoningTokens: 0,
    durationMs: 200,
    timeToFirstTokenMs: 80,
    cost: 0.002,
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    initiator: "agent",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ContextWindowSnapshot> = {}): ContextWindowSnapshot {
  return {
    currentTokens: 1000,
    tokenLimit: 128000,
    conversationTokens: 800,
    systemTokens: 100,
    toolDefinitionsTokens: 50,
    messagesLength: 5,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("LlmUsageAccumulator", () => {
  // 1. Zero state
  describe("zero state (empty accumulator)", () => {
    it("returns all numeric totals as 0", () => {
      const acc = new LlmUsageAccumulator();
      const s = acc.summary();
      expect(s.inputTokens).toBe(0);
      expect(s.outputTokens).toBe(0);
      expect(s.cacheReadTokens).toBe(0);
      expect(s.cacheWriteTokens).toBe(0);
      expect(s.reasoningTokens).toBe(0);
      expect(s.durationMs).toBe(0);
      expect(s.llmCalls).toBe(0);
    });

    it("returns model: null", () => {
      const acc = new LlmUsageAccumulator();
      expect(acc.summary().model).toBeNull();
    });

    it("returns cost: null", () => {
      const acc = new LlmUsageAccumulator();
      expect(acc.summary().cost).toBeNull();
    });

    it("returns calls: []", () => {
      const acc = new LlmUsageAccumulator();
      expect(acc.summary().calls).toEqual([]);
    });

    it("does not include contextWindow", () => {
      const acc = new LlmUsageAccumulator();
      expect("contextWindow" in acc.summary()).toBe(false);
    });
  });

  // 2. Single record
  describe("single record", () => {
    it("all summed fields equal the record's values", () => {
      const acc = new LlmUsageAccumulator();
      const record = makeRecord();
      acc.record(record);
      const s = acc.summary();
      expect(s.inputTokens).toBe(record.inputTokens);
      expect(s.outputTokens).toBe(record.outputTokens);
      expect(s.cacheReadTokens).toBe(record.cacheReadTokens);
      expect(s.cacheWriteTokens).toBe(record.cacheWriteTokens);
      expect(s.reasoningTokens).toBe(record.reasoningTokens);
      expect(s.durationMs).toBe(record.durationMs);
      expect(s.llmCalls).toBe(1);
    });

    it("model equals the record's model", () => {
      const acc = new LlmUsageAccumulator();
      acc.record(makeRecord({ model: "claude-3-opus" }));
      expect(acc.summary().model).toBe("claude-3-opus");
    });

    it("cost equals the record's cost", () => {
      const acc = new LlmUsageAccumulator();
      acc.record(makeRecord({ cost: 0.005 }));
      expect(acc.summary().cost).toBe(0.005);
    });

    it("calls contains the record", () => {
      const acc = new LlmUsageAccumulator();
      const record = makeRecord();
      acc.record(record);
      expect(acc.summary().calls).toEqual([record]);
    });
  });

  // 3. Multiple records
  describe("multiple records", () => {
    it("each numeric field equals the arithmetic sum across all records", () => {
      const acc = new LlmUsageAccumulator();
      const r1 = makeRecord({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, reasoningTokens: 2, durationMs: 200 });
      const r2 = makeRecord({ inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 5, durationMs: 350 });
      const r3 = makeRecord({ inputTokens: 50, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 15, reasoningTokens: 0, durationMs: 120 });
      acc.record(r1);
      acc.record(r2);
      acc.record(r3);
      const s = acc.summary();
      expect(s.inputTokens).toBe(350);
      expect(s.outputTokens).toBe(160);
      expect(s.cacheReadTokens).toBe(30);
      expect(s.cacheWriteTokens).toBe(20);
      expect(s.reasoningTokens).toBe(7);
      expect(s.durationMs).toBe(670);
      expect(s.llmCalls).toBe(3);
    });

    it("calls contains all records in order", () => {
      const acc = new LlmUsageAccumulator();
      const r1 = makeRecord({ model: "a" });
      const r2 = makeRecord({ model: "b" });
      acc.record(r1);
      acc.record(r2);
      expect(acc.summary().calls).toEqual([r1, r2]);
    });
  });

  // 4. Model tracking — last-wins
  describe("model tracking", () => {
    it("model reflects the last recorded call, not the first", () => {
      const acc = new LlmUsageAccumulator();
      acc.record(makeRecord({ model: "gpt-3.5-turbo" }));
      acc.record(makeRecord({ model: "gpt-4o" }));
      acc.record(makeRecord({ model: "claude-sonnet-4-5" }));
      expect(acc.summary().model).toBe("claude-sonnet-4-5");
    });
  });

  // 5. Cost null skipped
  describe("cost: null records do not contribute to totalCost", () => {
    it("all null costs → totalCost remains null", () => {
      const acc = new LlmUsageAccumulator();
      acc.record(makeRecord({ cost: null }));
      acc.record(makeRecord({ cost: null }));
      expect(acc.summary().cost).toBeNull();
    });

    it("mix of null and non-null: only non-null values sum", () => {
      const acc = new LlmUsageAccumulator();
      acc.record(makeRecord({ cost: null }));
      acc.record(makeRecord({ cost: 0.003 }));
      acc.record(makeRecord({ cost: null }));
      expect(acc.summary().cost).toBeCloseTo(0.003);
    });
  });

  // 6. Cost zero preserved
  describe("cost: 0 records DO contribute to totalCost", () => {
    it("[null, 0] → totalCost = 0, not null", () => {
      const acc = new LlmUsageAccumulator();
      acc.record(makeRecord({ cost: null }));
      acc.record(makeRecord({ cost: 0 }));
      expect(acc.summary().cost).toBe(0);
    });

    it("[0, 0] → totalCost = 0", () => {
      const acc = new LlmUsageAccumulator();
      acc.record(makeRecord({ cost: 0 }));
      acc.record(makeRecord({ cost: 0 }));
      expect(acc.summary().cost).toBe(0);
    });

    it("[0, 0.005] → totalCost = 0.005", () => {
      const acc = new LlmUsageAccumulator();
      acc.record(makeRecord({ cost: 0 }));
      acc.record(makeRecord({ cost: 0.005 }));
      expect(acc.summary().cost).toBeCloseTo(0.005);
    });
  });

  // 7. setContextWindow stores snapshot
  describe("setContextWindow", () => {
    it("summary().contextWindow equals the snapshot after setContextWindow(snap)", () => {
      const acc = new LlmUsageAccumulator();
      const snap = makeSnapshot();
      acc.setContextWindow(snap);
      expect(acc.summary().contextWindow).toEqual(snap);
    });

    it("contextWindow is present in summary after setContextWindow", () => {
      const acc = new LlmUsageAccumulator();
      acc.setContextWindow(makeSnapshot());
      expect("contextWindow" in acc.summary()).toBe(true);
    });
  });

  // 8. setContextWindow replacement
  describe("setContextWindow replacement", () => {
    it("second call replaces the first snapshot", () => {
      const acc = new LlmUsageAccumulator();
      const snap1 = makeSnapshot({ currentTokens: 500 });
      const snap2 = makeSnapshot({ currentTokens: 1500 });
      acc.setContextWindow(snap1);
      acc.setContextWindow(snap2);
      expect(acc.summary().contextWindow).toEqual(snap2);
      expect(acc.summary().contextWindow?.currentTokens).toBe(1500);
    });
  });

  // 9. summary() returns new object (shallow copy of calls)
  describe("summary() isolation", () => {
    it("returns a new object on each call", () => {
      const acc = new LlmUsageAccumulator();
      const s1 = acc.summary();
      const s2 = acc.summary();
      expect(s1).not.toBe(s2);
    });

    it("modifying the returned calls array does not affect the accumulator", () => {
      const acc = new LlmUsageAccumulator();
      acc.record(makeRecord({ model: "original" }));
      const s1 = acc.summary();
      // Mutate the returned calls array
      s1.calls.push(makeRecord({ model: "injected" }));
      // Accumulator's internal log should be unaffected
      const s2 = acc.summary();
      expect(s2.calls).toHaveLength(1);
      expect(s2.calls[0].model).toBe("original");
    });

    it("subsequent record() calls do not affect a previously returned summary", () => {
      const acc = new LlmUsageAccumulator();
      acc.record(makeRecord({ inputTokens: 100 }));
      const snapshot = acc.summary();
      acc.record(makeRecord({ inputTokens: 200 }));
      // The previously captured summary should be unchanged
      expect(snapshot.inputTokens).toBe(100);
      expect(snapshot.llmCalls).toBe(1);
    });
  });
});
