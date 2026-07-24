import { describe, it, expect } from "bun:test";
import { evaluateBlockage, STAGNATION_THRESHOLD, CRASH_THRESHOLD } from "../blockage";

describe("evaluateBlockage", () => {
	it("does not block below both thresholds", () => {
		const d = evaluateBlockage({ stagnationCount: 1, agentCrashCounts: { "worker-1": 1 } });
		expect(d.blocked).toBe(false);
		expect(d.cause).toBeUndefined();
	});

	it("blocks on stagnation at the threshold", () => {
		const d = evaluateBlockage({ stagnationCount: STAGNATION_THRESHOLD, agentCrashCounts: {} });
		expect(d.blocked).toBe(true);
		expect(d.cause).toBe("stagnation");
		expect(d.reason).toContain("stagnated");
	});

	it("blocks on crash deadlock at the threshold", () => {
		const d = evaluateBlockage({ stagnationCount: 0, agentCrashCounts: { "worker-2": CRASH_THRESHOLD } });
		expect(d.blocked).toBe(true);
		expect(d.cause).toBe("deadlock");
		expect(d.reason).toContain("deadlock");
	});

	it("prefers stagnation cause when both conditions hold", () => {
		const d = evaluateBlockage({
			stagnationCount: STAGNATION_THRESHOLD + 2,
			agentCrashCounts: { "worker-3": CRASH_THRESHOLD + 1 },
		});
		expect(d.blocked).toBe(true);
		expect(d.cause).toBe("stagnation");
	});

	it("honors overridden thresholds", () => {
		const d = evaluateBlockage({
			stagnationCount: 2,
			agentCrashCounts: {},
			stagnationThreshold: 2,
		});
		expect(d.blocked).toBe(true);
		expect(d.cause).toBe("stagnation");
	});

	it("ignores crash counts below threshold across many workers", () => {
		const d = evaluateBlockage({
			stagnationCount: 0,
			agentCrashCounts: { a: 2, b: 2, c: 2 },
		});
		expect(d.blocked).toBe(false);
	});
});
