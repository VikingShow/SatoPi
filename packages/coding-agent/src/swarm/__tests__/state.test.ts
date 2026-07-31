/**
 * Unit tests for StateTracker — live API surface.
 *
 * Tests:
 *   - registerAgent: registers agents idempotently, records model name
 *   - updateAgent / updatePipeline: in-memory mutations
 *   - getBestAgent: iteration-based best-agent selection
 *   - writeChain integrity: persistence survives logSwarmState rejection
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StateTracker } from "../core/state";
import { SwarmSessionManager } from "../session/swarm-session-manager";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-state-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// registerAgent
// ============================================================================

describe("registerAgent", () => {
	it("registers an agent with default fields", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.registerAgent("worker-1");

		const agent = st.state.agents["worker-1"];
		expect(agent).toBeDefined();
		expect(agent!.status).toBe("pending");
		expect(agent!.iteration).toBe(0);
		expect(agent!.wave).toBe(0);
	});

	it("is idempotent — re-registering preserves the existing agent", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.registerAgent("worker-1");
		await st.updateAgent("worker-1", { status: "completed", iteration: 2 });

		await st.registerAgent("worker-1");

		expect(st.state.agents["worker-1"]!.status).toBe("completed");
		expect(st.state.agents["worker-1"]!.iteration).toBe(2);
	});

	it("records an optional model name", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.registerAgent("worker-1", "claude-sonnet");

		expect(st.state.agents["worker-1"]!.modelName).toBe("claude-sonnet");
	});
});

// ============================================================================
// updateAgent / updatePipeline
// ============================================================================

describe("updateAgent / updatePipeline", () => {
	it("updateAgent mutates the registered agent", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.registerAgent("worker-1");
		await st.updateAgent("worker-1", { status: "running", iteration: 1 });

		expect(st.state.agents["worker-1"]!.status).toBe("running");
		expect(st.state.agents["worker-1"]!.iteration).toBe(1);
	});

	it("updateAgent is a no-op for unknown agents", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.updateAgent("ghost", { status: "completed" });

		expect(st.state.agents.ghost).toBeUndefined();
	});

	it("updatePipeline merges swarm-level fields", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.updatePipeline({ phase: "stage", status: "running", iteration: 2 });

		expect(st.state.phase).toBe("stage");
		expect(st.state.status).toBe("running");
		expect(st.state.iteration).toBe(2);
	});
});

// ============================================================================
// getBestAgent
// ============================================================================

describe("getBestAgent", () => {
	it("returns the agent with the highest iteration count", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.registerAgent("worker-1");
		await st.registerAgent("worker-2");
		await st.updateAgent("worker-2", { iteration: 3 });

		expect(st.getBestAgent()).toBe("worker-2");
	});

	it("honors excludeIds", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.registerAgent("worker-1");
		await st.registerAgent("worker-2");
		await st.updateAgent("worker-2", { iteration: 3 });

		expect(st.getBestAgent(["worker-2"])).toBe("worker-1");
	});

	it("returns null when no agents are registered", async () => {
		const st = new StateTracker(tmpDir, "test");
		expect(st.getBestAgent()).toBeNull();
	});

	it("returns null when every agent is excluded", async () => {
		const st = new StateTracker(tmpDir, "test");
		await st.registerAgent("worker-1");

		expect(st.getBestAgent(["worker-1"])).toBeNull();
	});
});

// ============================================================================
// writeChain integrity (SP-6)
// ============================================================================

describe("writeChain integrity (SP-6)", () => {
	it("survives logSwarmState rejection without corrupting subsequent writes", async () => {
		const st = new StateTracker(tmpDir, "test-sp6");
		const sm = await SwarmSessionManager.create(tmpDir);
		st.setSessionManager(sm);

		// Register first — this triggers a #persist() through the real logSwarmState.
		await st.registerAgent("worker-1");

		// Spy: first call throws to simulate a disk failure. Subsequent calls
		// fall through to the default vi.fn() which returns undefined (void).
		const logSpy = vi.spyOn(sm, "logSwarmState");
		logSpy.mockImplementationOnce(() => {
			throw new Error("Simulated disk failure");
		});

		// First updateAgent — logSwarmState throws, but the try/catch in
		// #persist() swallows the error. The updateAgent call should NOT throw.
		await st.updateAgent("worker-1", { status: "running", iteration: 1 });

		// In-memory state MUST be correct despite the persistence error.
		// The state mutation (Object.assign) happens BEFORE #persist() runs.
		expect(st.state.agents["worker-1"]!.status).toBe("running");
		expect(st.state.agents["worker-1"]!.iteration).toBe(1);
		expect(logSpy).toHaveBeenCalledTimes(1);

		// Second updateAgent — the write chain MUST NOT be corrupted.
		// If the chain were corrupted, this call would hang or silently
		// skip the persist (because .then() on a rejected promise skips
		// the success handler).
		await st.updateAgent("worker-1", { status: "completed", iteration: 2 });

		// In-memory state MUST reflect the second update.
		expect(st.state.agents["worker-1"]!.status).toBe("completed");
		expect(st.state.agents["worker-1"]!.iteration).toBe(2);

		// Second logSwarmState was called — proves the write chain
		// processed the second persist callback.
		expect(logSpy).toHaveBeenCalledTimes(2);

		await sm.close();
	});

	it("preserves write ordering after a rejected persist", async () => {
		const st = new StateTracker(tmpDir, "test-sp6-ordering");
		const sm = await SwarmSessionManager.create(tmpDir);
		st.setSessionManager(sm);

		await st.registerAgent("alpha");
		await st.registerAgent("beta");

		// First logSwarmState call (from the second updateAgent) throws.
		const logSpy = vi.spyOn(sm, "logSwarmState");
		logSpy.mockImplementationOnce(() => {
			throw new Error("Simulated disk failure");
		});

		// Update alpha — triggers the throwing logSwarmState.
		await st.updateAgent("alpha", { status: "running", iteration: 1 });

		// Update beta — this persist MUST succeed even though the
		// previous one's logSwarmState threw.
		await st.updateAgent("beta", { status: "completed", iteration: 3 });

		// Both agents' in-memory state MUST be correct.
		expect(st.state.agents.alpha!.status).toBe("running");
		expect(st.state.agents.alpha!.iteration).toBe(1);
		expect(st.state.agents.beta!.status).toBe("completed");
		expect(st.state.agents.beta!.iteration).toBe(3);

		// logSwarmState was called for both persists (first threw, second succeeded).
		expect(logSpy).toHaveBeenCalledTimes(2);

		await sm.close();
	});
});
