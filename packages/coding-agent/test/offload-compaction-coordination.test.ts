/**
 * P3 #3 — session/offload compaction coordination.
 *
 * Two compaction pipelines previously shared zero state:
 *   1. session-side threshold compaction (agent-session shouldCompact →
 *      history rewrite via #runAutoCompaction)
 *   2. offload-side L3 compaction (compactContext Mild/Aggressive/Emergency,
 *      transient per provider request)
 *
 * The coordination signal: OffloadManager records the outcome of every L3
 * compactContext run (recordCompactResult), and the session-side threshold
 * decision consults it (shouldDeferSessionCompaction) — deferring the
 * expensive, history-coarsening rewrite while L3 already keeps the effective
 * request within budget.
 *
 * These tests simulate a token-threshold trigger and assert both sides of the
 * signal: the offload side reflects the run, and the session-side decision
 * defers exactly when L3 is sufficient (and rewrites when the signal is
 * absent/stale/insufficient — i.e. the test fails if the coordination is
 * removed).
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@satopi/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens, shouldCompact } from "@satopi/pi-agent-core/compaction";
import {
	compactContext,
	DEFAULT_COMPACT_CONFIG,
	OFFLOAD_COMPACT_FRESH_MS,
	type OffloadCompactStatus,
	shouldDeferSessionCompaction,
	toOffloadCompactStatus,
} from "@satopi/pi-coding-agent/offload/compact";
import { OffloadManager } from "@satopi/pi-coding-agent/offload/manager";
import { MemorySessionStorage } from "@satopi/pi-coding-agent/session/store/session-storage";
import { Snowflake } from "@satopi/pi-utils";

// Window + session settings used by both sides of the signal.
const WINDOW = 2000;
// thresholdPercent 70 → threshold = 1400 tokens.
const SESSION_SETTINGS = { ...DEFAULT_COMPACTION_SETTINGS, thresholdPercent: 70, thresholdTokens: -1 };

function estimateTotalTokens(messages: AgentMessage[]): number {
	return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/**
 * Conversation where the "current task" (most recent assistant tool call) is
 * small, while an older tool result carries a large payload that the L3 Mild
 * tier can replace with an offload summary.
 */
function buildConversation(): AgentMessage[] {
	const bigToolResult = "x".repeat(6000); // ≈1500 tokens
	return [
		{ role: "user", content: "Task: build the auth module", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "stale-1", name: "read", arguments: "{}" }],
			timestamp: 2,
		},
		{ role: "toolResult", toolCallId: "stale-1", content: bigToolResult, timestamp: 3 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "current-1", name: "read", arguments: "{}" }],
			timestamp: 4,
		},
		{ role: "toolResult", toolCallId: "current-1", content: "ok", timestamp: 5 },
	] as AgentMessage[];
}

function makeManager(): OffloadManager {
	const dir = path.join("/tmp", `offload-coordination-${Snowflake.next()}`);
	return new OffloadManager(dir, "coord-agent", `session-${Snowflake.next()}`, new MemorySessionStorage());
}

describe("offload L3 outcome is recorded as the shared signal", () => {
	it("records tier/sizes/window after a compactContext run", async () => {
		const mgr = makeManager();
		await mgr.summarizeL1("stale-1", "compressed result summary");
		const summaries = await mgr.getOffloadSummaries();
		expect(summaries.get("stale-1")).toBe("compressed result summary");

		const messages = buildConversation();
		const result = compactContext(messages, summaries, {
			...DEFAULT_COMPACT_CONFIG,
			contextWindow: WINDOW,
		});
		expect(result.mildApplied).toBe(true);

		expect(mgr.getLastCompactStatus()).toBeUndefined();
		mgr.recordCompactResult(toOffloadCompactStatus(result, WINDOW));

		const status = mgr.getLastCompactStatus();
		expect(status).toBeDefined();
		expect(status!.tier).toBe("mild");
		expect(status!.tokensBefore).toBe(result.tokensBefore);
		expect(status!.tokensAfter).toBe(result.tokensAfter);
		expect(status!.contextWindow).toBe(WINDOW);
	});
});

describe("threshold trigger coordination (offload → session)", () => {
	it("session defers its rewrite when L3 already brought the request under budget", async () => {
		const mgr = makeManager();
		await mgr.summarizeL1("stale-1", "compressed result summary");
		const summaries = await mgr.getOffloadSummaries();

		const messages = buildConversation();
		const tokensBefore = estimateTotalTokens(messages);

		// 1. Simulate the offload L3 trigger on the provider request.
		const result = compactContext(messages, summaries, {
			...DEFAULT_COMPACT_CONFIG,
			contextWindow: WINDOW,
		});
		mgr.recordCompactResult(toOffloadCompactStatus(result, WINDOW));

		// 2. The session-side threshold decision.
		//    a. The persisted context is over the threshold → session would trip.
		expect(shouldCompact(tokensBefore, WINDOW, SESSION_SETTINGS)).toBe(true);
		//    b. But L3 applied a tier and brought the request under the threshold
		//       → the session defers instead of rewriting.
		const status = mgr.getLastCompactStatus();
		expect(status!.tier).not.toBe("none");
		expect(status!.tokensAfter).toBeLessThanOrEqual(1400);
		expect(shouldDeferSessionCompaction(WINDOW, SESSION_SETTINGS, status)).toBe(true);

		// 3. The full session decision chain: rewrite happens only when NOT deferred.
		const sessionWouldRewrite =
			shouldCompact(tokensBefore, WINDOW, SESSION_SETTINGS) &&
			!shouldDeferSessionCompaction(WINDOW, SESSION_SETTINGS, status);
		expect(sessionWouldRewrite).toBe(false);
	});

	it("session rewrites when the coordination signal is absent (coordination removed)", async () => {
		const messages = buildConversation();
		const tokensBefore = estimateTotalTokens(messages);
		expect(shouldCompact(tokensBefore, WINDOW, SESSION_SETTINGS)).toBe(true);

		// No manager wired / never recorded → no signal → session must rewrite.
		expect(shouldDeferSessionCompaction(WINDOW, SESSION_SETTINGS, undefined)).toBe(false);
		const mgr = makeManager();
		expect(shouldDeferSessionCompaction(WINDOW, SESSION_SETTINGS, mgr.getLastCompactStatus())).toBe(false);

		const sessionWouldRewrite =
			shouldCompact(tokensBefore, WINDOW, SESSION_SETTINGS) &&
			!shouldDeferSessionCompaction(WINDOW, SESSION_SETTINGS, undefined);
		expect(sessionWouldRewrite).toBe(true);
	});

	it("does not defer when L3 applied no tier, is stale, targets a different window, or missed the budget", () => {
		const fresh: OffloadCompactStatus = {
			tier: "mild",
			tokensBefore: 1500,
			tokensAfter: 300,
			contextWindow: WINDOW,
			at: Date.now(),
		};

		// No tier applied — L3 was a no-op, the rewrite is still needed.
		expect(shouldDeferSessionCompaction(WINDOW, SESSION_SETTINGS, { ...fresh, tier: "none" })).toBe(false);
		// L3 ran but could not get under the threshold (e.g. emergency plateau).
		expect(
			shouldDeferSessionCompaction(WINDOW, SESSION_SETTINGS, { ...fresh, tier: "emergency", tokensAfter: 1600 }),
		).toBe(false);
		// Stale signal — the manager stopped receiving L3 runs; rewrite.
		expect(
			shouldDeferSessionCompaction(WINDOW, SESSION_SETTINGS, {
				...fresh,
				at: Date.now() - OFFLOAD_COMPACT_FRESH_MS - 1,
			}),
		).toBe(false);
		// Different context window — L3 was configured against another budget.
		expect(shouldDeferSessionCompaction(WINDOW, SESSION_SETTINGS, { ...fresh, contextWindow: 4000 })).toBe(false);
	});
});

describe("negative: no summaries → no mild tier → session rewrites", () => {
	it("L3 without offload summaries cannot compress, so no deferral", async () => {
		const mgr = makeManager();
		const summaries = await mgr.getOffloadSummaries();
		expect(summaries.size).toBe(0);

		const messages = buildConversation();
		const result = compactContext(messages, summaries, {
			...DEFAULT_COMPACT_CONFIG,
			contextWindow: WINDOW,
		});
		expect(result.mildApplied).toBe(false);
		expect(result.emergencyApplied).toBe(false);

		mgr.recordCompactResult(toOffloadCompactStatus(result, WINDOW));
		expect(shouldDeferSessionCompaction(WINDOW, SESSION_SETTINGS, mgr.getLastCompactStatus())).toBe(false);
	});
});
