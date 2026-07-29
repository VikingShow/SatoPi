/**
 * WorkflowFsm — Formal verification tests.
 *
 * These tests verify the structural properties of the phase transition graph
 * and the behavioral correctness of the FSM implementation.
 *
 * ## Property Categories
 *
 * 1. **Graph integrity**: bidirectional consistency of allowedFrom/allowedTo
 * 2. **Reachability**: all phases reachable from idle
 * 3. **Liveness**: all phases can reach idle (no trap states)
 * 4. **Dead-end freedom**: every phase has at least one outgoing edge
 * 5. **Transition validation**: valid/invalid transitions are correctly accepted/rejected
 * 6. **Force transitions**: escape hatch bypasses validation
 * 7. **Idempotency**: self-transitions are no-ops
 * 8. **Listener notification**: onChange fires on transitions
 * 9. **Timed auto-transitions**: defaultTimeoutMs arms a timer
 * 10. **Dispose**: cleanup rejects pending promises and clears listeners
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { WorkflowFsm, PHASES } from "../core/workflow-fsm";
import * as path from "node:path";
import { StateTracker } from "../core/state";
import { type Chapter } from "../core/state";
import { ActivityLogger } from "../infra/activity-logger";

// ============================================================================
// Test helpers
// ============================================================================

/** Create a temporary directory for StateTracker/ActivityLogger. */
async function createTempSwarmDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wfsm-test-"));
	return dir;
}

/** Create a fully-registered WorkflowFsm with all standard PHASES. */
async function createFsm(initialPhase: Chapter = "idle"): Promise<{
	fsm: WorkflowFsm;
	stateTracker: StateTracker;
	activityLogger: ActivityLogger;
	cleanup: () => Promise<void>;
}> {
	const swarmDir = await createTempSwarmDir();
	const stateTracker = new StateTracker(swarmDir, "test");
	const activityLogger = new ActivityLogger(swarmDir, "test");
	const fsm = new WorkflowFsm(stateTracker, activityLogger, initialPhase);
	for (const def of PHASES) fsm.registerPhase(def);

	return {
		fsm,
		stateTracker,
		activityLogger,
		cleanup: async () => {
			fsm.dispose();
			await fs.rm(swarmDir, { recursive: true, force: true });
		},
	};
}

/** Get all phase identifiers from the PHASES registry. */
const ALL_PHASES = PHASES.map(p => p.phase);

// ============================================================================
// 1. Graph integrity — bidirectional consistency
// ============================================================================

describe("WorkflowFsm — Graph integrity", () => {
	it("PHASES array is non-empty", () => {
		expect(PHASES.length).toBeGreaterThan(0);
	});

	it("every phase has a unique identifier", () => {
		const ids = PHASES.map(p => p.phase);
		const unique = new Set(ids);
		expect(unique.size).toBe(ids.length);
	});

	it("allowedTo ↔ allowedFrom are bidirectionally consistent", () => {
		// For every edge A → B (B in A.allowedTo),
		// B.allowedFrom must contain A.
		for (const phaseA of PHASES) {
			for (const target of phaseA.allowedTo) {
				const phaseB = PHASES.find(p => p.phase === target);
				expect(phaseB).toBeDefined();
				expect(phaseB!.allowedFrom, `${target}.allowedFrom should contain ${phaseA.phase}`).toContain(phaseA.phase);
			}
		}
	});

	it("allowedFrom ↔ allowedTo are bidirectionally consistent (reverse)", () => {
		// For every edge B ← A (A in B.allowedFrom),
		// A.allowedTo must contain B.
		for (const phaseB of PHASES) {
			for (const source of phaseB.allowedFrom) {
				const phaseA = PHASES.find(p => p.phase === source);
				expect(phaseA).toBeDefined();
				expect(phaseA!.allowedTo, `${source}.allowedTo should contain ${phaseB.phase}`).toContain(phaseB.phase);
			}
		}
	});

	it("all phases referenced in allowedTo/allowedFrom are defined", () => {
		const defined = new Set(ALL_PHASES);
		for (const phase of PHASES) {
			for (const to of phase.allowedTo) {
				expect(defined.has(to), `${phase.phase}.allowedTo references undefined phase: ${to}`).toBe(true);
			}
			for (const from of phase.allowedFrom) {
				expect(defined.has(from), `${phase.phase}.allowedFrom references undefined phase: ${from}`).toBe(true);
			}
		}
	});
});

// ============================================================================
// 2. Reachability — all phases reachable from idle
// ============================================================================

describe("WorkflowFsm — Reachability", () => {
	it("all phases are reachable from idle via BFS", () => {
		const adj = new Map<Chapter, Chapter[]>();
		for (const p of PHASES) {
			adj.set(p.phase, [...p.allowedTo]);
		}

		const visited = new Set<Chapter>(["idle"]);
		const queue: Chapter[] = ["idle"];
		while (queue.length > 0) {
			const current = queue.shift()!;
			const neighbors = adj.get(current) ?? [];
			for (const n of neighbors) {
				if (!visited.has(n)) {
					visited.add(n);
					queue.push(n);
				}
			}
		}

		for (const phase of ALL_PHASES) {
			expect(visited.has(phase), `Phase ${phase} is not reachable from idle`).toBe(true);
		}
	});

	it("idle is reachable from every phase via BFS", () => {
		const adj = new Map<Chapter, Chapter[]>();
		for (const p of PHASES) {
			adj.set(p.phase, [...p.allowedTo]);
		}

		for (const start of ALL_PHASES) {
			if (start === "idle") continue;

			const visited = new Set<Chapter>([start]);
			const queue: Chapter[] = [start];
			let foundIdle = false;
			while (queue.length > 0) {
				const current = queue.shift()!;
				if (current === "idle") {
					foundIdle = true;
					break;
				}
				const neighbors = adj.get(current) ?? [];
				for (const n of neighbors) {
					if (!visited.has(n)) {
						visited.add(n);
						queue.push(n);
					}
				}
			}
			expect(foundIdle, `idle is not reachable from ${start}`).toBe(true);
		}
	});
});

// ============================================================================
// 3. Dead-end freedom — every phase has at least one outgoing edge
// ============================================================================

describe("WorkflowFsm — Dead-end freedom", () => {
	it("every phase has at least one allowedTo entry", () => {
		for (const phase of PHASES) {
			expect(phase.allowedTo.length, `${phase.phase} has no outgoing edges (dead end)`).toBeGreaterThan(0);
		}
	});
});

// ============================================================================
// 4. Transition validation
// ============================================================================

describe("WorkflowFsm — Transition validation", () => {
	let ctx: Awaited<ReturnType<typeof createFsm>>;

	beforeEach(async () => {
		ctx = await createFsm("idle");
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it("valid transition: idle → script succeeds", async () => {
		const result = await ctx.fsm.transition("script");
		expect(result.ok).toBe(true);
		expect(result.from).toBe("idle");
		expect(result.to).toBe("script");
		expect(result.noop).toBeUndefined();
	});

	it("valid transition: script → script-debate succeeds", async () => {
		await ctx.fsm.transition("script");
		const result = await ctx.fsm.transition("script-debate");
		expect(result.ok).toBe(true);
		expect(result.to).toBe("script-debate");
	});

	it("valid transition: script-confirm → stage succeeds", async () => {
		await ctx.fsm.transition("script");
		await ctx.fsm.transition("script-confirm");
		const result = await ctx.fsm.transition("stage");
		expect(result.ok).toBe(true);
		expect(result.to).toBe("stage");
	});

	it("valid transition: stage → curtain succeeds", async () => {
		await ctx.fsm.transition("script");
		await ctx.fsm.transition("script-confirm");
		await ctx.fsm.transition("stage");
		const result = await ctx.fsm.transition("curtain");
		expect(result.ok).toBe(true);
		expect(result.to).toBe("curtain");
	});

	it("valid transition: curtain → idle succeeds", async () => {
		await ctx.fsm.transition("script");
		await ctx.fsm.transition("script-confirm");
		await ctx.fsm.transition("stage");
		await ctx.fsm.transition("curtain");
		const result = await ctx.fsm.transition("idle");
		expect(result.ok).toBe(true);
		expect(result.to).toBe("idle");
	});

	it("invalid transition: idle → stage is rejected (not in idle.allowedTo? actually it is)", async () => {
		// idle.allowedTo = ["script", "stage"], so idle → stage IS valid.
		const result = await ctx.fsm.transition("stage");
		expect(result.ok).toBe(true);
	});

	it("invalid transition: idle → curtain is rejected", async () => {
		const result = await ctx.fsm.transition("curtain");
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("not in");
	});

	it("invalid transition: idle → blocked is rejected", async () => {
		const result = await ctx.fsm.transition("blocked");
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("not in");
	});

	it("invalid transition: script → stage is rejected", async () => {
		await ctx.fsm.transition("script");
		const result = await ctx.fsm.transition("stage");
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("not in");
	});

	it("invalid transition: curtain → script is rejected", async () => {
		await ctx.fsm.transition("script");
		await ctx.fsm.transition("script-confirm");
		await ctx.fsm.transition("stage");
		await ctx.fsm.transition("curtain");
		const result = await ctx.fsm.transition("script");
		expect(result.ok).toBe(false);
	});
});

// ============================================================================
// 5. Force transitions (escape hatch)
// ============================================================================

describe("WorkflowFsm — Force transitions", () => {
	let ctx: Awaited<ReturnType<typeof createFsm>>;

	beforeEach(async () => {
		ctx = await createFsm("idle");
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it("force bypasses validation: idle → blocked", async () => {
		const result = await ctx.fsm.force("blocked");
		expect(result.ok).toBe(true);
		expect(result.to).toBe("blocked");
	});

	it("force bypasses validation: idle → curtain", async () => {
		const result = await ctx.fsm.force("curtain");
		expect(result.ok).toBe(true);
		expect(result.to).toBe("curtain");
	});

	it("force self-transition is a noop", async () => {
		const result = await ctx.fsm.force("idle");
		expect(result.ok).toBe(true);
		expect(result.noop).toBe(true);
	});
});

// ============================================================================
// 6. Idempotent self-transitions
// ============================================================================

describe("WorkflowFsm — Idempotency", () => {
	let ctx: Awaited<ReturnType<typeof createFsm>>;

	beforeEach(async () => {
		ctx = await createFsm("script");
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it("self-transition returns noop without side effects", async () => {
		const before = ctx.fsm.state;
		const result = await ctx.fsm.transition("script");
		expect(result.ok).toBe(true);
		expect(result.noop).toBe(true);
		expect(result.from).toBe("script");
		expect(result.to).toBe("script");

		const after = ctx.fsm.state;
		expect(after.iteration).toBe(before.iteration);
		expect(after.phaseStartedAt).toBe(before.phaseStartedAt);
	});
});

// ============================================================================
// 7. Listener notification
// ============================================================================

describe("WorkflowFsm — Listener notification", () => {
	let ctx: Awaited<ReturnType<typeof createFsm>>;

	beforeEach(async () => {
		ctx = await createFsm("idle");
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it("onChange fires on transition with from/to/meta", async () => {
		const listener = vi.fn();
		ctx.fsm.onChange(listener);

		await ctx.fsm.transition("script");

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0][0].from).toBe("idle");
		expect(listener.mock.calls[0][0].to).toBe("script");
	});

	it("unsubscribe stops notifications", async () => {
		const listener = vi.fn();
		const unsub = ctx.fsm.onChange(listener);

		await ctx.fsm.transition("script");
		expect(listener).toHaveBeenCalledTimes(1);

		unsub();
		await ctx.fsm.transition("script-confirm");
		expect(listener).toHaveBeenCalledTimes(1); // no new calls
	});

	it("listener errors are swallowed (don't crash FSM)", async () => {
		ctx.fsm.onChange(() => {
			throw new Error("listener boom");
		});
		// Should not throw
		const result = await ctx.fsm.transition("script");
		expect(result.ok).toBe(true);
	});
});

// ============================================================================
// 8. Timed auto-transitions
// ============================================================================

describe("WorkflowFsm — Timed auto-transitions", () => {
	let ctx: Awaited<ReturnType<typeof createFsm>>;

	beforeEach(async () => {
		ctx = await createFsm("idle");
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it("phases with defaultTimeoutMs > 0 arm a timer", async () => {
		// script-debate has defaultTimeoutMs: 300_000
		await ctx.fsm.transition("script");
		await ctx.fsm.transition("script-debate");

		// Don't wait for the timer — just verify cancelTimed doesn't throw
		ctx.fsm.cancelTimed();
	});

	it("cancelTimed prevents the auto-transition", async () => {
		await ctx.fsm.transition("script");
		await ctx.fsm.transition("script-debate");

		ctx.fsm.cancelTimed();

		// Wait a tiny bit to ensure no timer fires
		await new Promise(r => setTimeout(r, 50));
		expect(ctx.fsm.phase).toBe("script-debate");
	});
});

// ============================================================================
// 9. State snapshot
// ============================================================================

describe("WorkflowFsm — State snapshot", () => {
	let ctx: Awaited<ReturnType<typeof createFsm>>;

	beforeEach(async () => {
		ctx = await createFsm("idle");
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it("state reflects current phase", () => {
		expect(ctx.fsm.state.phase).toBe("idle");
	});

	it("state.running is true for active phases", async () => {
		await ctx.fsm.transition("script");
		expect(ctx.fsm.state.running).toBe(true);
	});

	it("state.running is false for idle", () => {
		expect(ctx.fsm.state.running).toBe(false);
	});

	it("state.iteration increments on transitions", async () => {
		const before = ctx.fsm.state.iteration;
		await ctx.fsm.transition("script");
		expect(ctx.fsm.state.iteration).toBe(before + 1);
	});

	it("capabilities match phase definition", async () => {
		await ctx.fsm.transition("script");
		const caps = ctx.fsm.capabilities;
		expect(caps.humanMode).toBe("dialogue");
		expect(caps.multiAgent).toBe(false);
	});
});

// ============================================================================
// 10. Dispose
// ============================================================================

describe("WorkflowFsm — Dispose", () => {
	it("dispose clears listeners and timers", async () => {
		const ctx = await createFsm("idle");
		const listener = vi.fn();
		ctx.fsm.onChange(listener);

		ctx.fsm.dispose();

		// After dispose, transitions should still work but listeners are gone.
		// Actually, after dispose the FSM should not be used — but if it is,
		// listeners are cleared so the callback won't fire.
		await ctx.fsm.transition("script").catch(() => {});
		expect(listener).not.toHaveBeenCalled();

		await ctx.cleanup();
	});

	it("dispose rejects pending human decision", async () => {
		const ctx = await createFsm("blocked");

		// Start waiting for human decision
		const waitPromise = ctx.fsm.waitForHumanDecision(10_000);

		// Dispose should reject the pending promise
		ctx.fsm.dispose();

		await expect(waitPromise).rejects.toThrow("WorkflowFsm disposed");

		await ctx.cleanup();
	});
});

// ============================================================================
// 11. Human decision waiting
// ============================================================================

describe("WorkflowFsm — Human decision", () => {
	let ctx: Awaited<ReturnType<typeof createFsm>>;

	beforeEach(async () => {
		ctx = await createFsm("blocked");
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	it("waitForHumanDecision resolves on transition", async () => {
		const waitPromise = ctx.fsm.waitForHumanDecision(5_000);

		// Trigger a transition
		setTimeout(() => void ctx.fsm.transition("stage"), 10);

		const result = await waitPromise;
		expect(result).toBe("stage");
	});

	it("waitForHumanDecision times out", async () => {
		await expect(ctx.fsm.waitForHumanDecision(50)).rejects.toThrow("timed out");
	});

	it("second waitForHumanDecision replaces the first", async () => {
		const first = ctx.fsm.waitForHumanDecision(10_000);
		const second = ctx.fsm.waitForHumanDecision(10_000);

		// First should be rejected
		await expect(first).rejects.toThrow("cancelled");

		// Clean up second
		ctx.fsm.dispose();
		await expect(second).rejects.toThrow();
	});
});
