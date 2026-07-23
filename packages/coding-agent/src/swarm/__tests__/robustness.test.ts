/**
 * Robustness integration tests for Loop Engineering system.
 *
 * Tests cross-module behavior that was fixed in the robustness pass:
 *   - getWorstWorker + unregisterAgent lifecycle (state.ts ↔ loop-controller scale-down)
 *   - extractVerdict balanced JSON extraction (roundtable.ts)
 *   - tallyVerdicts CRASHED skip behavior (roundtable.ts)
 *   - RegionLockManager.reset() (region-lock.ts)
 *   - extractRoundSummary + CRASHED filtering (loop-controller.ts)
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StateTracker } from "../state";
import { RegionLockManager } from "../region-lock";
import { extractVerdict, tallyVerdicts } from "../review-council";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-robustness-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Scale-down lifecycle: getWorstWorker → unregisterAgent → re-register
// ============================================================================

describe("scale-down lifecycle", () => {
	it("simulates full scale-down then scale-up without counter pollution", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1", "worker-2", "worker-3"], 5, "loop");

		// Simulate work: worker-2 performs poorly
		await st.incrementPraise(["worker-1", "worker-3"]); // good workers
		await st.incrementCriticism(["worker-2"]);          // bad worker
		await st.incrementConflict("worker-2");

		// Scale-down: find worst among current workers, unregister
		const worst = st.getWorstWorker(["worker-1", "worker-2", "worker-3"]);
		expect(worst).toBe("worker-2");

		await st.unregisterAgent(worst!);

		// Verify worker-2 is gone
		expect(st.state.agents["worker-2"]).toBeUndefined();
		expect(Object.keys(st.state.agents).sort()).toEqual(["worker-1", "worker-3"]);

		// Scale-up: register a new worker (reusing worker-2 ID as loop-controller does)
		await st.registerAgent("worker-2");

		// New worker-2 should have clean counters
		const newAgent = st.state.agents["worker-2"];
		expect(newAgent).toBeDefined();
		expect(newAgent!.praiseCount).toBe(0);
		expect(newAgent!.criticismCount).toBe(0);
		expect(newAgent!.conflictCount).toBe(0);
		expect(newAgent!.status).toBe("pending");
	});

	it("getWorstWorker returns correct worker after scale-up changes roster", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1", "worker-2"], 5, "loop");

		// worker-1 is worst
		await st.incrementCriticism(["worker-1"]);
		expect(st.getWorstWorker(["worker-1", "worker-2"])).toBe("worker-1");

		// Scale up: add worker-3 (even worse score)
		await st.registerAgent("worker-3");
		await st.incrementCriticism(["worker-3"]);
		await st.incrementConflict("worker-3");

		// Now worker-3 is worst
		expect(st.getWorstWorker(["worker-1", "worker-2", "worker-3"])).toBe("worker-3");
	});
});

// ============================================================================
// Retry lifecycle: resetAgentStatuses
// ============================================================================

describe("retry lifecycle", () => {
	it("resetAgentStatuses allows a clean retry after crash", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1", "worker-2"], 5, "loop");

		// Simulate a crashed run: agents stuck in running, counters polluted
		await st.updateAgent("worker-1", { status: "running", iteration: 2 });
		await st.updateAgent("worker-2", { status: "completed", iteration: 2, completedAt: 12345 });
		await st.incrementPraise(["worker-1"]);
		await st.incrementCriticism(["worker-2"]);
		await st.updatePipeline({ status: "failed", completedAt: 99999, iteration: 2 });

		// Retry: reset
		await st.resetAgentStatuses();

		// All agents should be clean
		expect(st.state.agents["worker-1"]!.status).toBe("pending");
		expect(st.state.agents["worker-2"]!.status).toBe("pending");
		expect(st.state.agents["worker-1"]!.praiseCount).toBe(0);
		expect(st.state.agents["worker-2"]!.criticismCount).toBe(0);
		expect(st.state.status).toBe("running");
		expect(st.state.completedAt).toBeUndefined();

		// getWorstWorker should work correctly on clean state (all scores = 0)
		const worst = st.getWorstWorker(["worker-1", "worker-2"]);
		expect(worst).not.toBeNull();
		// All scores are 0, so it's a tie — either is fine
		expect(["worker-1", "worker-2"]).toContain(worst!);
	});
});

// ============================================================================
// RegionLockManager — per-session instance isolation
//
// RegionLockManager is now a per-session instance (no global singleton /
// static reset). Isolation therefore comes from constructing a fresh
// instance per session, and releaseAll() clears a worker's locks on teardown.
// ============================================================================

describe("RegionLockManager per-session isolation", () => {
	it("a fresh instance inherits no locks from another instance", () => {
		const mgr = new RegionLockManager();

		expect(mgr.tryLock("worker-1", "/src/file-a.ts")).toBe(true);
		expect(mgr.tryLock("worker-2", "/src/file-b.ts")).toBe(true);
		// Conflicting lock on file-a is blocked within the same instance.
		expect(mgr.tryLock("worker-3", "/src/file-a.ts")).toBe(false);

		// A separate session (separate instance) shares no state.
		const mgr2 = new RegionLockManager();
		expect(mgr2.tryLock("worker-3", "/src/file-a.ts")).toBe(true);
		expect(mgr2.tryLock("worker-4", "/src/file-b.ts")).toBe(true);
	});

	it("releaseAll clears all locks held by a worker", () => {
		const mgr = new RegionLockManager();
		mgr.tryLock("worker-1", "/a.ts");
		mgr.tryLock("worker-1", "/b.ts");
		mgr.tryLock("worker-2", "/c.ts");
		expect(mgr.getActiveLocks().length).toBe(3);

		mgr.releaseAll("worker-1");

		const remaining = mgr.getActiveLocks();
		expect(remaining.length).toBe(1);
		expect(remaining[0]!.workerId).toBe("worker-2");
		// worker-1's files are now acquirable by others.
		expect(mgr.tryLock("worker-3", "/a.ts")).toBe(true);
	});

	it("release only frees a lock held by the requesting worker", () => {
		const mgr = new RegionLockManager();
		mgr.tryLock("worker-1", "/shared.ts");
		// worker-2 cannot release worker-1's lock.
		mgr.release("worker-2", "/shared.ts");
		expect(mgr.tryLock("worker-3", "/shared.ts")).toBe(false);
		// The holder can release it.
		mgr.release("worker-1", "/shared.ts");
		expect(mgr.tryLock("worker-3", "/shared.ts")).toBe(true);
	});
});

// ============================================================================
// extractVerdict: complex real-world JSON patterns
// ============================================================================

describe("extractVerdict: real-world patterns", () => {
	it("handles multi-line JSON with nested findings array", () => {
		const text = [
			`I've reviewed the code changes. Here's my verdict:`,
			``,
			`{`,
			`  "verdict": "FAIL",`,
			`  "confidence": 0.35,`,
			`  "findings": [`,
			`    "Missing input validation in auth.ts",`,
			`    "No error handling for network failures",`,
			`    "Test coverage below 50% for new modules"`,
			`  ],`,
			`  "worker_count_delta": -1`,
			`}`,
		].join("\n");

		const result = extractVerdict("cloner-1", text);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(false);
		expect(result!.findings.length).toBe(3);
		expect(result!.workerCountDelta).toBe(-1);
	});

	it("handles JSON embedded in markdown code block", () => {
		const text = [
			`## Review`,
			``,
			`My verdict:`,
			``,
			`{"verdict":"PASS","confidence":0.85,"findings":["All checks pass"]}`,
			``,
			`Done.`,
		].join("\n");

		const result = extractVerdict("cloner-2", text);
		expect(result).not.toBeNull();
		expect(result!.passed).toBe(true);
		expect(result!.confidence).toBe(0.85);
	});

	it("returns null for completely invalid text", () => {
		const text = "I am not sure what to say about this. Maybe ask someone else.";
		const result = extractVerdict("cloner-3", text);
		expect(result).toBeNull();
	});
});

// ============================================================================
// tallyVerdicts: mixed crash + valid results
// ============================================================================

describe("tallyVerdicts: mixed crash scenarios", () => {
	function makeResult(agent: string, output: string): SingleResult {
		return {
			index: 0,
			id: `id-${agent}`,
			agent,
			agentSource: "project" as const,
			task: "",
			exitCode: 0,
			output,
			stderr: "",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			requests: 0,
		};
	}

	it("2 PASS + 1 CRASHED → PASS (majority of 2 valid)", () => {
		const results = [
			makeResult("cloner-1", `{"verdict":"PASS","confidence":0.9,"findings":["good"]}`),
			makeResult("cloner-2", `[CRASHED] out of memory`),
			makeResult("cloner-3", `{"verdict":"PASS","confidence":0.8,"findings":["ok"]}`),
		];
		const v = tallyVerdicts(results);
		expect(v.totalCount).toBe(2);
		expect(v.approvalCount).toBe(2);
		expect(v.passed).toBe(true);
	});

	it("1 PASS + 1 FAIL + 1 CRASHED → PASS (1/2 ≥ ceil(2/2)=1)", () => {
		const results = [
			makeResult("cloner-1", `{"verdict":"PASS","confidence":0.6,"findings":["ok"]}`),
			makeResult("cloner-2", `{"verdict":"FAIL","confidence":0.4,"findings":["bad"]}`),
			makeResult("cloner-3", `[CRASHED] timeout`),
		];
		const v = tallyVerdicts(results);
		expect(v.totalCount).toBe(2);
		expect(v.approvalCount).toBe(1);
		expect(v.passed).toBe(true); // 1 ≥ ceil(2/2)=1
	});

	it("1 FAIL + 2 CRASHED → FAIL (only 1 valid vote, 0 approvals)", () => {
		const results = [
			makeResult("cloner-1", `{"verdict":"FAIL","confidence":0.2,"findings":["bad"]}`),
			makeResult("cloner-2", `[CRASHED] error 1`),
			makeResult("cloner-3", `[CRASHED] error 2`),
		];
		const v = tallyVerdicts(results);
		expect(v.totalCount).toBe(1);
		expect(v.approvalCount).toBe(0);
		expect(v.passed).toBe(false);
	});
});
