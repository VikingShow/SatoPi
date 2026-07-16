/**
 * Tests for RegionLockManager — the in-process file-region lock singleton
 * used by swarm workers for tier-2 file conflict prevention.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { RegionLockManager } from "../region-lock";

describe("RegionLockManager", () => {
	afterEach(() => {
		RegionLockManager.reset();
	});

	it("acquires a lock when file is free", () => {
		const mgr = RegionLockManager.create();
		expect(mgr.tryLock("worker-1", "src/foo.ts")).toBe(true);
		expect(mgr.getActiveLocks()).toHaveLength(1);
	});

	it("rejects lock when another worker holds it", () => {
		const mgr = RegionLockManager.create();
		expect(mgr.tryLock("worker-1", "src/foo.ts")).toBe(true);
		expect(mgr.tryLock("worker-2", "src/foo.ts")).toBe(false);
	});

	it("allows re-acquire by same worker (no-op)", () => {
		const mgr = RegionLockManager.create();
		expect(mgr.tryLock("worker-1", "src/foo.ts")).toBe(true);
		expect(mgr.tryLock("worker-1", "src/foo.ts")).toBe(true);
		expect(mgr.getActiveLocks()).toHaveLength(1);
	});

	it("checkLock reports locked by other", () => {
		const mgr = RegionLockManager.create();
		mgr.tryLock("worker-1", "src/foo.ts");

		expect(mgr.checkLock("src/foo.ts", "worker-2")).toEqual({
			locked: true,
			entry: { workerId: "worker-1", file: "src/foo.ts", range: undefined, acquiredAt: expect.any(Number) },
		});

		expect(mgr.checkLock("src/foo.ts", "worker-1")).toEqual({ locked: false });
	});

	it("release frees lock for same worker", () => {
		const mgr = RegionLockManager.create();
		mgr.tryLock("worker-1", "src/foo.ts");
		mgr.release("worker-1", "src/foo.ts");
		expect(mgr.getActiveLocks()).toHaveLength(0);
	});

	it("release ignores locks held by other workers", () => {
		const mgr = RegionLockManager.create();
		mgr.tryLock("worker-1", "src/foo.ts");
		mgr.release("worker-2", "src/foo.ts");
		expect(mgr.getActiveLocks()).toHaveLength(1);
		expect(mgr.getActiveLocks()[0].workerId).toBe("worker-1");
	});

	it("releaseAll clears only that worker's locks", () => {
		const mgr = RegionLockManager.create();
		mgr.tryLock("worker-1", "src/a.ts");
		mgr.tryLock("worker-1", "src/b.ts");
		mgr.tryLock("worker-2", "src/c.ts");
		mgr.releaseAll("worker-1");
		const locks = mgr.getActiveLocks();
		expect(locks).toHaveLength(1);
		expect(locks[0].workerId).toBe("worker-2");
	});

	it("normalizes ./ prefix and duplicate slashes", () => {
		const mgr = RegionLockManager.create();
		expect(mgr.tryLock("worker-1", "./src/foo.ts")).toBe(true);
		expect(mgr.checkLock("src/foo.ts", "worker-2").locked).toBe(true);
		expect(mgr.checkLock("src//foo.ts", "worker-2").locked).toBe(true);
	});

	it("describeLock formats human-readable string", () => {
		const desc = RegionLockManager.describeLock({
			workerId: "worker-3",
			file: "src/auth.ts",
			range: "5-20",
			acquiredAt: 1234567890,
		});
		expect(desc).toBe("worker-3 is editing src/auth.ts:5-20");
	});

	it("describeLock omits range when absent", () => {
		const desc = RegionLockManager.describeLock({
			workerId: "worker-3",
			file: "src/auth.ts",
			acquiredAt: 1234567890,
		});
		expect(desc).toBe("worker-3 is editing src/auth.ts");
	});

	it("global returns the same singleton", () => {
		const a = RegionLockManager.global();
		const b = RegionLockManager.global();
		expect(a).toBe(b);
	});

	it("create returns a fresh instance", () => {
		const a = RegionLockManager.create();
		const b = RegionLockManager.create();
		expect(a).not.toBe(b);
		// global() now points to the latest create() result
		expect(RegionLockManager.global()).toBe(b);
	});
});
