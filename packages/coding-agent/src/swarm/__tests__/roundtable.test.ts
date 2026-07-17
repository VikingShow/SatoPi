/**
 * Unit tests for ClonerCouncil roundtable functions.
 *
 * Tests:
 *   - extractVerdict: JSON parsing, heuristic fallback, edge cases
 *   - tallyVerdicts: majority vote, tie-breaking, edge cases
 */

import { describe, expect, it } from "bun:test";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import { extractVerdict, tallyVerdicts } from "../roundtable";

// ============================================================================
// extractVerdict
// ============================================================================

describe("extractVerdict", () => {
	it("parses valid PASS JSON verdict", () => {
		const text = `Analysis complete.\n{"verdict":"PASS","confidence":0.9,"findings":["All tests pass", "Code quality is good"]}\nDone.`;
		const result = extractVerdict("cloner-1", text);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
		expect(result!.confidence).toBe(0.9);
		expect(result!.findings).toEqual(["All tests pass", "Code quality is good"]);
	});

	it("parses valid FAIL JSON verdict", () => {
		const text = `{"verdict":"FAIL","confidence":0.3,"findings":["Missing error handling"]}`;
		const result = extractVerdict("cloner-2", text);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
		expect(result!.confidence).toBe(0.3);
		expect(result!.findings).toEqual(["Missing error handling"]);
	});

	it("handles single string findings (not array)", () => {
		const text = `{"verdict":"PASS","confidence":0.8,"findings":"Looks good"}`;
		const result = extractVerdict("cloner-3", text);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
		expect(result!.findings).toEqual(["Looks good"]);
	});

	it("handles missing confidence (defaults to 0.5)", () => {
		const text = `{"verdict":"PASS","findings":["ok"]}`;
		const result = extractVerdict("cloner-4", text);
		expect(result).not.toBeNull();
		expect(result!.confidence).toBe(0.5);
	});

	it("falls back to heuristic when FAIL keyword present", () => {
		const text = "I reviewed the output and it FAILs to meet requirements. The code has bugs.";
		const result = extractVerdict("cloner-5", text);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
		expect(result!.findings[0]).toContain("cloner-5");
	});

	it("falls back to heuristic when REJECT keyword present", () => {
		const text = "REJECT: The implementation is incomplete.";
		const result = extractVerdict("cloner-6", text);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
	});

	it("returns null when no verdict pattern found", () => {
		const text = "I'm not sure about this. Let me think more.";
		const result = extractVerdict("cloner-7", text);
		expect(result).toBeNull();
	});

	it("does not match FAIL when PASS is also present", () => {
		const text = "The test FAILs in one edge case but overall PASSes.";
		const result = extractVerdict("cloner-8", text);
		expect(result).toBeNull(); // heuristic: PASS present = not a FAIL match
	});

	// ----------------------------------------------------------------
	// Robustness: nested JSON and braces inside string values
	// ----------------------------------------------------------------

	it("parses JSON with nested objects", () => {
		const text = `{"verdict":"FAIL","confidence":0.3,"findings":["error"],"role_suggestions":{"worker-1":"reviewer"}}`;
		const result = extractVerdict("cloner-nested", text);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
		expect(result!.roleSuggestions).toEqual({ "worker-1": "reviewer" });
	});

	it("parses JSON with brace characters inside string values", () => {
		const text = `Some analysis.\n{"verdict":"PASS","confidence":0.9,"findings":["function() { return true; }"]}\nDone.`;
		const result = extractVerdict("cloner-brace", text);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
		expect(result!.findings).toEqual(["function() { return true; }"]);
	});

	it("parses JSON with escaped quotes inside strings", () => {
		const text = `{"verdict":"FAIL","confidence":0.5,"findings":["expected \\"hello\\" but got \\"world\\""]}`;
		const result = extractVerdict("cloner-escape", text);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
		expect(result!.findings).toEqual(['expected "hello" but got "world"']);
	});

	it("skips non-verdict JSON objects and finds the verdict one", () => {
		const text = `Here is some info: {"meta": "data"}\n{"verdict":"PASS","confidence":0.8,"findings":["ok"]}`;
		const result = extractVerdict("cloner-multi-json", text);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
	});

	it("handles JSON with worker_count_delta field", () => {
		const text = `{"verdict":"FAIL","confidence":0.4,"findings":["slow"],"worker_count_delta":-1}`;
		const result = extractVerdict("cloner-delta", text);
		expect(result).not.toBeNull();
		expect(result!.workerCountDelta).toBe(-1);
	});
});

// ============================================================================
// tallyVerdicts
// ============================================================================

function makeResult(agent: string, output: string): SingleResult {
	return {
		id: `id-${agent}`,
		index: 0,
		agent,
		output,
		meta: {},
	} as unknown as SingleResult;
}

describe("tallyVerdicts", () => {
	it("PASS with unanimous vote", () => {
		const results = [
			makeResult("cloner-1", `{"verdict":"PASS","confidence":0.9,"findings":["good"]}`),
			makeResult("cloner-2", `{"verdict":"PASS","confidence":0.8,"findings":["ok"]}`),
			makeResult("cloner-3", `{"verdict":"PASS","confidence":0.7,"findings":["fine"]}`),
		];
		const verdict = tallyVerdicts(results);
		expect(verdict.passed).toBe(true);
		expect(verdict.approvalCount).toBe(3);
		expect(verdict.totalCount).toBe(3);
	});

	it("FAIL with unanimous vote", () => {
		const results = [
			makeResult("cloner-1", `{"verdict":"FAIL","confidence":0.2,"findings":["bad"]}`),
			makeResult("cloner-2", `{"verdict":"FAIL","confidence":0.1,"findings":["worse"]}`),
		];
		const verdict = tallyVerdicts(results);
		expect(verdict.passed).toBe(false);
		expect(verdict.approvalCount).toBe(0);
	});

	it("PASS with majority (2 of 3)", () => {
		const results = [
			makeResult("cloner-1", `{"verdict":"PASS","confidence":0.9,"findings":["good"]}`),
			makeResult("cloner-2", `{"verdict":"PASS","confidence":0.7,"findings":["ok"]}`),
			makeResult("cloner-3", `{"verdict":"FAIL","confidence":0.3,"findings":["needs work"]}`),
		];
		const verdict = tallyVerdicts(results);
		expect(verdict.passed).toBe(true);
		expect(verdict.approvalCount).toBe(2);
		expect(verdict.totalCount).toBe(3);
	});

	it("FAIL with minority (1 of 3)", () => {
		const results = [
			makeResult("cloner-1", `{"verdict":"PASS","confidence":0.6,"findings":["ok"]}`),
			makeResult("cloner-2", `{"verdict":"FAIL","confidence":0.2,"findings":["bad"]}`),
			makeResult("cloner-3", `{"verdict":"FAIL","confidence":0.3,"findings":["also bad"]}`),
		];
		const verdict = tallyVerdicts(results);
		expect(verdict.passed).toBe(false);
		expect(verdict.approvalCount).toBe(1);
		expect(verdict.totalCount).toBe(3);
	});
	it("handles cloner with unparseable output", () => {
		const results = [
			makeResult("cloner-1", `{"verdict":"PASS","confidence":0.9,"findings":["good"]}`),
			makeResult("cloner-2", "I don't know... let me think... hmm..."),
			makeResult("cloner-3", `{"verdict":"PASS","confidence":0.7,"findings":["ok"]}`),
		];
		const verdict = tallyVerdicts(results);
		expect(verdict.passed).toBe(true); // 2 of 2 parseable → 2 ≥ ceil(3/2)=2 → PASS
		expect(verdict.approvalCount).toBe(2);
		expect(verdict.totalCount).toBe(3);
	});

	it("findings are collected from all voters", () => {
		const results = [
			makeResult("cloner-1", `{"verdict":"PASS","confidence":0.9,"findings":["good code"]}`),
			makeResult("cloner-2", `{"verdict":"FAIL","confidence":0.3,"findings":["missing docs","bad naming"]}`),
		];
		const verdict = tallyVerdicts(results);
		expect(verdict.findings.length).toBe(3);
		expect(verdict.findings[0]).toContain("[cloner-1]");
		expect(verdict.findings[1]).toContain("[cloner-2]");
		expect(verdict.findings[2]).toContain("[cloner-2]");
	});

	// ----------------------------------------------------------------
	// Robustness: CRASHED cloners should not count as votes
	// ----------------------------------------------------------------

	it("skips CRASHED cloners in vote tally", () => {
		const results = [
			makeResult("cloner-1", `{"verdict":"PASS","confidence":0.9,"findings":["good"]}`),
			makeResult("cloner-2", `[CRASHED] subprocess exited with code 1`),
			makeResult("cloner-3", `{"verdict":"PASS","confidence":0.8,"findings":["ok"]}`),
		];
		const verdict = tallyVerdicts(results);
		// Only 2 valid cloners, both PASS → 2/2 = PASS
		expect(verdict.totalCount).toBe(2);
		expect(verdict.approvalCount).toBe(2);
		expect(verdict.passed).toBe(true);
	});

	it("all CRASHED → FAIL with zero valid votes", () => {
		const results = [
			makeResult("cloner-1", `[CRASHED] error 1`),
			makeResult("cloner-2", `[CRASHED] error 2`),
		];
		const verdict = tallyVerdicts(results);
		expect(verdict.totalCount).toBe(0);
		expect(verdict.approvalCount).toBe(0);
		expect(verdict.passed).toBe(false);
	});

	it("1 PASS + 1 CRASHED + 1 FAIL → PASS (majority of valid votes)", () => {
		const results = [
			makeResult("cloner-1", `{"verdict":"PASS","confidence":0.9,"findings":["good"]}`),
			makeResult("cloner-2", `[CRASHED] timeout`),
			makeResult("cloner-3", `{"verdict":"FAIL","confidence":0.2,"findings":["bad"]}`),
		];
		const verdict = tallyVerdicts(results);
		// 2 valid votes: 1 PASS + 1 FAIL → ceil(2/2)=1, approvalCount=1 ≥ 1 → PASS
		expect(verdict.totalCount).toBe(2);
		expect(verdict.approvalCount).toBe(1);
		expect(verdict.passed).toBe(true);
	});
});
