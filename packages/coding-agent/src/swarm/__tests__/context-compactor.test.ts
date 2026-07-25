/**
 * context-compactor.test.ts — Unit tests for ContextCompactor system.
 *
 * Covers:
 * 1. SummarizeStrategy — applies at 90%, doesn't below, compacts messages
 * 2. TruncateStrategy — applies at 95%, keeps only recent
 * 3. OffloadToStigmergyStrategy — applies at 80%, creates stigmergy mark
 * 4. ContextCompactor — finds first applicable strategy, returns null when none
 * 5. Edge cases — empty messages, single message, messages under budget
 */

import { describe, test, expect } from "bun:test";
import {
  ContextCompactor,
  SummarizeStrategy,
  TruncateStrategy,
  OffloadToStigmergyStrategy,
  type CompactionStrategy,
  type CompactedContext,
} from "../context-manager/context-compactor";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock AgentMessage for testing */
function msg(content: string, extra: Partial<AgentMessage> = {}): AgentMessage {
  return {
    role: extra.role ?? "user",
    content,
    timestamp: extra.timestamp ?? Date.now(),
    ...extra,
  };
}

/** Create N mock messages with sequential content */
function makeMessages(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => msg(`message ${i + 1}`));
}

// ============================================================================
// SummarizeStrategy
// ============================================================================

describe("SummarizeStrategy", () => {
  const strategy = new SummarizeStrategy();

  test("applies at 90% threshold", () => {
    expect(strategy.appliesTo(91, 100)).toBe(true);
    expect(strategy.appliesTo(100, 100)).toBe(true);
  });

  test("does not apply below 90% threshold", () => {
    expect(strategy.appliesTo(90, 100)).toBe(false);
    expect(strategy.appliesTo(89, 100)).toBe(false);
    expect(strategy.appliesTo(50, 100)).toBe(false);
  });

  test("has correct name", () => {
    expect(strategy.name).toBe("summarize");
  });

  test("compacts messages: keeps last 20, summarizes older", async () => {
    const messages = makeMessages(30);
    const result = await strategy.compact(messages);

    expect(result.messages.length).toBe(21); // 1 summary + 20 recent
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toContain("[Context Compaction Summary]");
    expect(result.summaryText).toContain("Compacted 10 messages");
  });

  test("returns messages unchanged when 20 or fewer", async () => {
    const messages = makeMessages(15);
    const result = await strategy.compact(messages);

    expect(result.messages).toBe(messages); // same reference
    expect(result.messages.length).toBe(15);
    expect(result.summaryText).toBeUndefined();
  });

  test("handles exactly 20 messages", async () => {
    const messages = makeMessages(20);
    const result = await strategy.compact(messages);

    expect(result.messages).toBe(messages);
    expect(result.messages.length).toBe(20);
  });
});

// ============================================================================
// TruncateStrategy
// ============================================================================

describe("TruncateStrategy", () => {
  const strategy = new TruncateStrategy();

  test("applies at 95% threshold", () => {
    expect(strategy.appliesTo(96, 100)).toBe(true);
    expect(strategy.appliesTo(100, 100)).toBe(true);
  });

  test("does not apply below 95% threshold", () => {
    expect(strategy.appliesTo(95, 100)).toBe(false);
    expect(strategy.appliesTo(90, 100)).toBe(false);
  });

  test("has correct name", () => {
    expect(strategy.name).toBe("truncate");
  });

  test("keeps only last 30 messages", async () => {
    const messages = makeMessages(50);
    const result = await strategy.compact(messages);

    expect(result.messages.length).toBe(30);
    // Should be the last 30 messages
    expect(result.messages[0].content).toBe("message 21");
    expect(result.messages[29].content).toBe("message 50");
    expect(result.summaryText).toContain("Truncated 20 messages");
  });

  test("keeps all messages when fewer than 30", async () => {
    const messages = makeMessages(10);
    const result = await strategy.compact(messages);

    expect(result.messages.length).toBe(10);
    expect(result.summaryText).toContain("Truncated 0 messages");
  });
});

// ============================================================================
// OffloadToStigmergyStrategy
// ============================================================================

describe("OffloadToStigmergyStrategy", () => {
  const strategy = new OffloadToStigmergyStrategy();

  test("applies at 80% threshold", () => {
    expect(strategy.appliesTo(81, 100)).toBe(true);
    expect(strategy.appliesTo(100, 100)).toBe(true);
  });

  test("does not apply below 80% threshold", () => {
    expect(strategy.appliesTo(80, 100)).toBe(false);
    expect(strategy.appliesTo(50, 100)).toBe(false);
  });

  test("has correct name", () => {
    expect(strategy.name).toBe("offload-to-stigmergy");
  });

  test("offloads to stigmergy: keeps last 15, creates stigmergy mark", async () => {
    const messages = makeMessages(25);
    const result = await strategy.compact(messages);

    expect(result.messages.length).toBe(15);
    expect(result.stigmergyMark).toBeDefined();
    expect(result.stigmergyMark!.type).toBe("context-offload");
    expect(result.stigmergyMark!.message).toBeTruthy();
    expect(result.summaryText).toContain("Offloaded 10 messages");
  });

  test("handles fewer than 15 messages", async () => {
    const messages = makeMessages(10);
    const result = await strategy.compact(messages);

    // slice(-15) on 10 items returns all 10
    expect(result.messages.length).toBe(10);
    expect(result.stigmergyMark).toBeDefined();
    expect(result.stigmergyMark!.message).toBeFalsy(); // empty because old array is empty
  });
});

// ============================================================================
// ContextCompactor
// ============================================================================

describe("ContextCompactor", () => {
  const compactor = new ContextCompactor();

  test("returns null when no strategy applies (under all thresholds)", async () => {
    const messages = makeMessages(30);
    const result = await compactor.compactIfNeeded(messages, 70, 100);
    expect(result).toBeNull();
  });

  test("selects first applicable strategy (offload-to-stigmergy at 80%)", async () => {
    const messages = makeMessages(30);
    const result = await compactor.compactIfNeeded(messages, 85, 100);
    expect(result).not.toBeNull();
    // OffloadToStigmergy is first in order (after SummarizeStrategy),
    // but SummarizeStrategy applies at 90% not 85%, so OffloadToStigmergy wins
    expect(result!.stigmergyMark).toBeDefined();
  });

  test("selects summarize strategy at 90%", async () => {
    const messages = makeMessages(30);
    const result = await compactor.compactIfNeeded(messages, 92, 100);
    expect(result).not.toBeNull();
    // SummarizeStrategy is first and applies at 90%
    expect(result!.messages[0].content).toContain("[Context Compaction Summary]");
  });

  test("returns null when tokens are at exactly budget boundary", async () => {
    const messages = makeMessages(30);
    const result = await compactor.compactIfNeeded(messages, 80, 100);
    expect(result).toBeNull();
  });

  test("createHook returns a valid hook descriptor", () => {
    const hook = compactor.createHook();
    expect(hook.name).toBe("context-compactor");
    expect(hook.priority).toBe(3);
    expect(hook.events).toContain("agent:beforeLaunch");
    expect(hook.phases).toContain("stage");
    expect(typeof hook.handler).toBe("function");
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  test("handles empty messages array", async () => {
    const result = await compactor.compactIfNeeded([], 100, 100);
    expect(result).not.toBeNull();
    expect(result!.messages).toEqual([]);
  });

  test("handles single message", async () => {
    const messages = makeMessages(1);
    const result = await compactor.compactIfNeeded(messages, 100, 100);
    expect(result).not.toBeNull();
    expect(result!.messages.length).toBe(1);
  });
});
