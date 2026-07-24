import { describe, it, expect } from "bun:test";
import { computeScaleDelta } from "../agent/agent-scaler";

describe("computeScaleDelta", () => {
	it("returns 0 when too few voted (gate)", () => {
		// 3 voters → need ceil(3/2)=2 suggestions.
		expect(computeScaleDelta({ suggestions: [2], voterCount: 3, currentAgentCount: 3, min: 1 })).toBe(0);
	});

	it("fast-scales by median on super-majority with |median| >= 2", () => {
		// 3 voters, superMajority = ceil(6/3)=2. All up, median 3.
		expect(computeScaleDelta({ suggestions: [2, 3, 4], voterCount: 3, currentAgentCount: 3, min: 1 })).toBe(3);
	});

	it("fast-scales down by median on super-majority", () => {
		expect(computeScaleDelta({ suggestions: [-2, -3, -4], voterCount: 3, currentAgentCount: 8, min: 1 })).toBe(-3);
	});

	it("falls back to +1 on simple up-majority without strong signal", () => {
		// median 1 (< 2) so no fast path; upVotes 2 >= majority 2 → +1.
		expect(computeScaleDelta({ suggestions: [1, 1, -1], voterCount: 3, currentAgentCount: 3, min: 1 })).toBe(1);
	});

	it("falls back to -1 on simple down-majority when above min", () => {
		expect(computeScaleDelta({ suggestions: [-1, -1, 1], voterCount: 3, currentAgentCount: 4, min: 1 })).toBe(-1);
	});

	it("does not scale down below min via the conservative path", () => {
		expect(computeScaleDelta({ suggestions: [-1, -1, 1], voterCount: 3, currentAgentCount: 1, min: 1 })).toBe(0);
	});

	it("returns 0 when votes are split with no majority", () => {
		// 4 voters, majority = 2. 1 up, 1 down, 2 zero → no majority either way.
		expect(computeScaleDelta({ suggestions: [1, -1, 0, 0], voterCount: 4, currentAgentCount: 3, min: 1 })).toBe(0);
	});

	it("does not mutate the caller's suggestions array", () => {
		const suggestions = [4, 2, 3];
		computeScaleDelta({ suggestions, voterCount: 3, currentAgentCount: 3, min: 1 });
		expect(suggestions).toEqual([4, 2, 3]);
	});
});
