/**
 * Robustness integration tests for SatoPi swarm system.
 *
 * Tests cross-module behavior:
 *   - getWorstAgent + unregisterAgent lifecycle (state.ts scale-down)
 *   - RegionLockManager per-session isolation (region-lock.ts)
 *   - resetAgentStatuses retry lifecycle (state.ts)
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StateTracker } from "../core/state";
import { RegionLockManager } from "../coordination/region-lock";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-robustness-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Scale-down lifecycle: getWorstAgent → unregisterAgent → re-register
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
		const worst = st.getWorstAgent(["worker-1", "worker-2", "worker-3"]);
		expect(worst).toBe("worker-2");

		await st.unregisterAgent(worst!);

		// Verify worker-2 is gone
		expect(st.state.agents["worker-2"]).toBeUndefined();
		expect(Object.keys(st.state.agents).sort()).toEqual(["worker-1", "worker-3"]);

		// Scale-up: register a new worker (reusing worker-2 ID)
		await st.registerAgent("worker-2");

		// New worker-2 should have clean counters
		const newAgent = st.state.agents["worker-2"];
		expect(newAgent).toBeDefined();
		expect(newAgent!.praiseCount).toBe(0);
		expect(newAgent!.criticismCount).toBe(0);
		expect(newAgent!.conflictCount).toBe(0);
		expect(newAgent!.status).toBe("pending");
	});

	it("getWorstAgent returns correct worker after scale-up changes roster", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1", "worker-2"], 5, "loop");

		// worker-1 is worst
		await st.incrementCriticism(["worker-1"]);
		expect(st.getWorstAgent(["worker-1", "worker-2"])).toBe("worker-1");

		// Scale up: add worker-3 (even worse score)
		await st.registerAgent("worker-3");
		await st.incrementCriticism(["worker-3"]);
		await st.incrementConflict("worker-3");

		// Now worker-3 is worst
		expect(st.getWorstAgent(["worker-1", "worker-2", "worker-3"])).toBe("worker-3");
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

		// getWorstAgent should work correctly on clean state (all scores = 0)
		const worst = st.getWorstAgent(["worker-1", "worker-2"]);
		expect(worst).not.toBeNull();
		// All scores are 0, so it's a tie — either is fine
		expect(["worker-1", "worker-2"]).toContain(worst!);
	});
});

// ============================================================================
// RegionLockManager — per-session instance isolation
// ============================================================================

describe("RegionLockManager per-session isolation", () => {
	it("a fresh instance inherits no locks from another instance", () => {
		const mgr = new RegionLockManager();

		expect(mgr.tryLock("agent-1", "/src/file-a.ts")).toBe(true);
		expect(mgr.tryLock("agent-2", "/src/file-b.ts")).toBe(true);
		// Conflicting lock on file-a is blocked within the same instance.
		expect(mgr.tryLock("agent-3", "/src/file-a.ts")).toBe(false);

		// A separate session (separate instance) shares no state.
		const mgr2 = new RegionLockManager();
		expect(mgr2.tryLock("agent-3", "/src/file-a.ts")).toBe(true);
		expect(mgr2.tryLock("agent-4", "/src/file-b.ts")).toBe(true);
	});

	it("releaseAll clears all locks held by a worker", () => {
		const mgr = new RegionLockManager();
		mgr.tryLock("agent-1", "/a.ts");
		mgr.tryLock("agent-1", "/b.ts");
		mgr.tryLock("agent-2", "/c.ts");
		expect(mgr.getActiveLocks().length).toBe(3);

		mgr.releaseAll("agent-1");

		const remaining = mgr.getActiveLocks();
		expect(remaining.length).toBe(1);
		expect(remaining[0]!.agentId).toBe("agent-2");
		// agent-1's files are now acquirable by others.
		expect(mgr.tryLock("agent-3", "/a.ts")).toBe(true);
	});

	it("release only frees a lock held by the requesting worker", () => {
		const mgr = new RegionLockManager();
		mgr.tryLock("agent-1", "/shared.ts");
		// agent-2 cannot release agent-1's lock.
		mgr.release("agent-2", "/shared.ts");
		expect(mgr.tryLock("agent-3", "/shared.ts")).toBe(false);
		// The holder can release it.
		mgr.release("agent-1", "/shared.ts");
		expect(mgr.tryLock("agent-3", "/shared.ts")).toBe(true);
	});
});

// ============================================================================
// extractVerdict + tallyVerdicts removed
//
// These functions lived in the now-deleted review-council.ts.  In the
// StageController model review is a task in the TaskQueue — there is no
// centralized cloner council.  Verdict extraction / tallying is no longer
// part of the core swarm pipeline.
// ============================================================================
