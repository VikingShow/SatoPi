/**
 * Robustness integration tests for SatoPi swarm system.
 *
 * Tests cross-module behavior:
 *   - RegionLockManager per-session isolation (region-lock.ts)
 */

import { describe, expect, it } from "bun:test";
import { RegionLockManager } from "../../coordination/region-lock";

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
