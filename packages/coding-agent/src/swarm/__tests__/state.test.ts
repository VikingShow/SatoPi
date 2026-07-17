/**
 * Unit tests for StateTracker — robustness fixes.
 *
 * Tests:
 *   - getWorstWorker: candidates semantics (was excludeIds, now candidate filter)
 *   - unregisterAgent: removes agent, prevents ID reuse pollution
 *   - resetAgentStatuses: clears all agent state for retry
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StateTracker } from "../state";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-state-test-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// getWorstWorker — candidates semantics
// ============================================================================

describe("getWorstWorker", () => {
	it("finds worst among ALL agents when no candidates given", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1", "worker-2", "worker-3"], 5, "loop");

		await st.incrementPraise(["worker-1"]);     // score: +1
		await st.incrementCriticism(["worker-2"]);   // score: -1
		// worker-3: score 0

		const worst = st.getWorstWorker();
		expect(worst).toBe("worker-2"); // lowest score
	});

	it("finds worst among ONLY the given candidates", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1", "worker-2", "worker-3", "worker-4"], 5, "loop");

		await st.incrementPraise(["worker-1"]);       // score: +1
		await st.incrementCriticism(["worker-2"]);     // score: -1
		await st.incrementConflict("worker-3");         // score: -1
		// worker-4: score 0

		// Only search among worker-1 and worker-4 (the best two)
		const worst = st.getWorstWorker(["worker-1", "worker-4"]);
		expect(worst).toBe("worker-4"); // score 0 < score 1
	});

	it("returns null when candidates list is empty", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1"], 5, "loop");

		const worst = st.getWorstWorker([]);
		expect(worst).toBeNull();
	});

	it("returns null when no agents are registered", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init([], 5, "loop");

		const worst = st.getWorstWorker();
		expect(worst).toBeNull();
	});

	it("handles tie — returns first encountered worst", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1", "worker-2"], 5, "loop");

		await st.incrementCriticism(["worker-1", "worker-2"]); // both score: -1

		const worst = st.getWorstWorker();
		expect(worst).not.toBeNull();
		// Both have the same score; either is acceptable
		expect(["worker-1", "worker-2"]).toContain(worst);
	});

	it("does NOT return agents outside candidates (regression test for excludeIds bug)", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1", "worker-2", "cloner-1"], 5, "loop");

		await st.incrementPraise(["worker-1", "worker-2"]); // workers: +1
		await st.incrementCriticism(["cloner-1"]);           // cloner-1: -1 (worst overall)

		// Search only among workers — cloner-1 should NOT be returned
		// even though it has the lowest score globally.
		const worst = st.getWorstWorker(["worker-1", "worker-2"]);
		expect(worst).not.toBe("cloner-1");
		expect(["worker-1", "worker-2"]).toContain(worst);
	});
});

// ============================================================================
// unregisterAgent
// ============================================================================

describe("unregisterAgent", () => {
	it("removes an agent from state", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1", "worker-2"], 5, "loop");

		await st.unregisterAgent("worker-1");

		// Agent should no longer exist
		expect(st.state.agents["worker-1"]).toBeUndefined();
		expect(st.state.agents["worker-2"]).toBeDefined();
	});

	it("is a no-op for non-existent agent", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1"], 5, "loop");

		// Should not throw
		await st.unregisterAgent("nonexistent");

		expect(st.state.agents["worker-1"]).toBeDefined();
	});

	it("prevents quality counter pollution on ID reuse", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1"], 5, "loop");

		// Accumulate bad scores for worker-1
		await st.incrementCriticism(["worker-1"]);
		await st.incrementConflict("worker-1");
		expect(st.getWorkerScore("worker-1")).toBe(-2);

		// Scale-down: unregister worker-1
		await st.unregisterAgent("worker-1");

		// Scale-up: re-register worker-1 (simulating ID reuse)
		await st.registerAgent("worker-1");

		// Counters should be clean
		expect(st.getWorkerScore("worker-1")).toBe(0);
		expect(st.state.agents["worker-1"]!.criticismCount).toBe(0);
		expect(st.state.agents["worker-1"]!.conflictCount).toBe(0);
	});
});

// ============================================================================
// resetAgentStatuses
// ============================================================================

describe("resetAgentStatuses", () => {
	it("clears all agent counters and statuses", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1", "worker-2"], 5, "loop");

		// Pollute state
		await st.incrementPraise(["worker-1"]);
		await st.incrementCriticism(["worker-2"]);
		await st.incrementConflict("worker-1");
		await st.updateAgent("worker-1", { status: "completed", completedAt: 12345, iteration: 3 });
		await st.updatePipeline({ status: "completed", completedAt: 99999, iteration: 5 });

		// Reset
		await st.resetAgentStatuses();

		// All agents should be clean
		for (const agent of Object.values(st.state.agents)) {
			expect(agent.status).toBe("pending");
			expect(agent.iteration).toBe(0);
			expect(agent.praiseCount).toBe(0);
			expect(agent.criticismCount).toBe(0);
			expect(agent.conflictCount).toBe(0);
			expect(agent.completedAt).toBeUndefined();
			expect(agent.mentorId).toBeUndefined();
			expect(agent.role).toBeUndefined();
		}

		// Pipeline should be back to running
		expect(st.state.status).toBe("running");
		expect(st.state.iteration).toBe(0);
		expect(st.state.completedAt).toBeUndefined();
	});

	it("preserves agent registration (IDs remain)", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1", "worker-2", "worker-3"], 5, "loop");

		await st.resetAgentStatuses();

		expect(Object.keys(st.state.agents).sort()).toEqual(["worker-1", "worker-2", "worker-3"]);
	});

	it("persisted state matches in-memory state after reset", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.init(["worker-1"], 5, "loop");
		await st.incrementPraise(["worker-1"]);
		await st.resetAgentStatuses();

		// Load from disk into a new instance
		const st2 = new StateTracker(tmpDir, "test");
		await st2.load();

		expect(st2.state.agents["worker-1"]).toBeDefined();
		expect(st2.state.agents["worker-1"]!.praiseCount).toBe(0);
		expect(st2.state.agents["worker-1"]!.status).toBe("pending");
	});
});
