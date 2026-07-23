/**
 * SwarmStateMachine tests — legal/illegal transitions, idempotency,
 * escape-hatch force(), timed auto-transitions, and atomic onEnter/onExit.
 */
import { describe, it, expect, mock } from "bun:test";
import {
	SwarmStateMachine,
	canTransition,
	WORKFLOW_TRANSITIONS,
	type PhaseContext,
} from "../swarm-state-machine";
import type { Chapter } from "../state";

describe("canTransition — transition table", () => {
	it("accepts documented legal moves", () => {
		expect(canTransition("idle", "script")).toBe(true);
		expect(canTransition("script-confirm", "stage")).toBe(true);
		expect(canTransition("stage", "paused")).toBe(true);
		expect(canTransition("stage", "blocked")).toBe(true);
		expect(canTransition("blocked", "stage")).toBe(true);
		expect(canTransition("stage", "curtain")).toBe(true);
		expect(canTransition("curtain", "idle")).toBe(true);
	});

	it("covers the previously-missing branches", () => {
		expect(canTransition("script", "idle")).toBe(true); // cancel
		expect(canTransition("paused", "curtain")).toBe(true); // abort while paused
		expect(canTransition("blocked", "curtain")).toBe(true); // abort from blocker
		expect(canTransition("curtain", "stage")).toBe(true); // retry
	});

	it("rejects illegal moves", () => {
		expect(canTransition("idle", "blocked")).toBe(false);
		expect(canTransition("paused", "blocked")).toBe(false);
		expect(canTransition("curtain", "paused")).toBe(false);
	});

	it("treats self-loops as legal no-ops", () => {
		for (const p of Object.keys(WORKFLOW_TRANSITIONS) as Chapter[]) {
			expect(canTransition(p, p)).toBe(true);
		}
	});
});

describe("SwarmStateMachine.transition", () => {
	it("applies a legal transition and fires onExit then onEnter", async () => {
		const calls: string[] = [];
		const sm = new SwarmStateMachine("idle", {
			onExit: (p) => { calls.push(`exit:${p}`); },
			onEnter: (p) => { calls.push(`enter:${p}`); },
		});
		const res = await sm.transition("script");
		expect(res.ok).toBe(true);
		expect(sm.phase).toBe("script");
		expect(calls).toEqual(["exit:idle", "enter:script"]);
	});

	it("rejects an illegal transition without changing phase or firing hooks", async () => {
		const onEnter = mock(() => {});
		const onError = mock(() => {});
		const sm = new SwarmStateMachine("idle", { onEnter, onError });
		const res = await sm.transition("blocked");
		expect(res.ok).toBe(false);
		expect(res.reason).toContain("Illegal");
		expect(sm.phase).toBe("idle");
		expect(onEnter).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("is idempotent on self-transition (no duplicate onEnter)", async () => {
		const onEnter = mock(() => {});
		const sm = new SwarmStateMachine("stage", { onEnter });
		const res = await sm.transition("stage");
		expect(res.ok).toBe(true);
		expect(res.noop).toBe(true);
		expect(onEnter).not.toHaveBeenCalled();
	});

	it("passes PhaseContext through to onEnter (terminal status preserved)", async () => {
		let seen: PhaseContext | null = null;
		const sm = new SwarmStateMachine("stage", {
			onEnter: (_p, ctx) => { seen = ctx; },
		});
		await sm.transition("curtain", { terminalStatus: "converged_partial", iteration: 3 });
		expect(seen).not.toBeNull();
		expect(seen!.terminalStatus).toBe("converged_partial");
		expect(seen!.iteration).toBe(3);
	});

	it("does not throw when onEnter throws — reports via onError", async () => {
		const onError = mock(() => {});
		const sm = new SwarmStateMachine("idle", {
			onEnter: () => { throw new Error("boom"); },
			onError,
		});
		const res = await sm.transition("stage");
		// transition still 'succeeds' (phase moved) but the hook error is reported.
		expect(res.ok).toBe(true);
		expect(sm.phase).toBe("stage");
		expect(onError).toHaveBeenCalledTimes(1);
	});
});

describe("SwarmStateMachine.force", () => {
	it("bypasses the table for hard abort/reset", async () => {
		const sm = new SwarmStateMachine("curtain");
		// after-loop → blocked is NOT in the table.
		expect(await (async () => (await sm.transition("blocked")).ok)()).toBe(false);
		const forced = await sm.force("blocked");
		expect(forced.ok).toBe(true);
		expect(sm.phase).toBe("blocked");
	});
});

describe("SwarmStateMachine timed transitions", () => {
	it("fires the scheduled transition after the delay", async () => {
		const sm = new SwarmStateMachine("blocked");
		sm.scheduleTimed("stage", 20, { reason: "auto-continue" });
		expect(sm.phase).toBe("blocked");
		await new Promise((r) => setTimeout(r, 40));
		expect(sm.phase).toBe("stage");
	});

	it("a manual transition cancels the pending timed transition", async () => {
		const sm = new SwarmStateMachine("blocked");
		sm.scheduleTimed("stage", 30, { reason: "auto-continue" });
		// Operator aborts before the timeout.
		await sm.transition("curtain", { terminalStatus: "aborted" });
		await new Promise((r) => setTimeout(r, 50));
		// Timed transition must NOT have fired (we're not back in running).
		expect(sm.phase).toBe("curtain");
	});

	it("does not fire if the phase already moved away from the armed source", async () => {
		const sm = new SwarmStateMachine("blocked");
		sm.scheduleTimed("stage", 25);
		await sm.transition("stage"); // manual unblock
		await sm.transition("paused"); // then pause
		await new Promise((r) => setTimeout(r, 40));
		expect(sm.phase).toBe("paused"); // timer no-op'd
	});
});
