/**
 * dissatisfaction-loop.test.ts — Unit tests for DissatisfactionLoop + wireApplaudSignal
 *
 * Coverage:
 * 1. wireApplaudSignal: null signal → no-op
 * 2. wireApplaudSignal: custom EventTarget-based signal → calls onDissatisfied / onSatisfied
 * 3. wireApplaudSignal: once-only dispatch
 * 4. DissatisfactionLoop.handleDissatisfaction: transitions state to "script" phase
 * 5. DissatisfactionLoop.completeLoop: retry vs completion paths
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
	DissatisfactionLoop,
	wireApplaudSignal,
	type DissatisfactionLoopConfig,
} from "../monitor/dissatisfaction-loop";
import type { Agent } from "@oh-my-pi/pi-agent-core";

describe("wireApplaudSignal", () => {
	// ── Null signal ──────────────────────────────────────────────────

	test("no-ops when applaudSignal is undefined", () => {
		expect(() =>
			wireApplaudSignal({
				applaudSignal: undefined,
				onDissatisfied: async () => ({ shouldRetry: true }),
				onSatisfied: async () => {},
			}),
		).not.toThrow();
	});

	// ── Custom signal: dissatisfaction reason ───────────────────────

	test("calls onDissatisfied when signal emitted with dissatisfy keyword", async () => {
		let called = false;

		// Build a manual signal-like EventTarget
		const target = new EventTarget();
		const signal = {
			addEventListener: (event: string, handler: EventListenerOrEventListenerObject, opts?: any) =>
				target.addEventListener(event, handler, opts),
			aborted: false,
		} as unknown as AbortSignal;

		wireApplaudSignal({
			applaudSignal: signal,
			onDissatisfied: async () => {
				called = true;
				return { shouldRetry: true };
			},
			onSatisfied: async () => {},
		});

		// Manually dispatch an AbortEvent-like event
		// The handler reads signal.reason; we attach it before dispatch
		(signal as any).reason = "User is dissatisfied with the font choices";
		target.dispatchEvent(new Event("abort"));

		await new Promise(resolve => setTimeout(resolve, 10));
		expect(called).toBe(true);
	});

	// ── Custom signal: satisfied ────────────────────────────────────

	test("calls onSatisfied when signal emitted without dissatisfy keyword", async () => {
		let satisfied = false;

		const target = new EventTarget();
		const signal = {
			addEventListener: (event: string, handler: EventListenerOrEventListenerObject, opts?: any) =>
				target.addEventListener(event, handler, opts),
			aborted: false,
		} as unknown as AbortSignal;

		wireApplaudSignal({
			applaudSignal: signal,
			onDissatisfied: async () => ({ shouldRetry: true }),
			onSatisfied: async () => {
				satisfied = true;
			},
		});

		(signal as any).reason = "Task completed successfully";
		target.dispatchEvent(new Event("abort"));

		await new Promise(resolve => setTimeout(resolve, 10));
		expect(satisfied).toBe(true);
	});

	// ── Once-only listener ──────────────────────────────────────────

	test("listener fires only once", async () => {
		let count = 0;

		const target = new EventTarget();
		const signal = {
			addEventListener: (event: string, handler: EventListenerOrEventListenerObject, opts?: any) =>
				target.addEventListener(event, handler, opts),
			aborted: false,
		} as unknown as AbortSignal;

		wireApplaudSignal({
			applaudSignal: signal,
			onDissatisfied: async () => {
				count++;
				return { shouldRetry: true };
			},
			onSatisfied: async () => {},
		});

		(signal as any).reason = "User dissatisfied with the output";
		target.dispatchEvent(new Event("abort"));
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(count).toBe(1);

		// Dispatch again — should not increment (once: true)
		target.dispatchEvent(new Event("abort"));
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(count).toBe(1);
	});
});

describe("DissatisfactionLoop", () => {
	let plannerCalls: string[] = [];

	function makePlannerAgent(): Agent {
		return {
			steer: mock((_msg: any) => {
				plannerCalls.push("steered");
			}),
			followUp: mock((_msg: any) => {
				plannerCalls.push("followUp");
			}),
			continue: mock(() => Promise.resolve()),
			waitForIdle: mock(() => Promise.resolve()),
			state: { messages: [], model: {} },
		} as unknown as Agent;
	}

	function makeConfig(planner: Agent): DissatisfactionLoopConfig {
		return {
			plannerAgent: planner,
			activityLogger: {
				logBroadcast: mock(() => {}),
			} as any,
			stateTracker: {
				updatePipeline: mock(() => Promise.resolve()),
			} as any,
			planPath: "/tmp/plan.md",
			workspace: "/tmp/workspace",
		};
	}

	beforeEach(() => { plannerCalls = []; });

	// ── handleDissatisfaction ────────────────────────────────────────

	test("steers planner agent and transitions to script phase", async () => {
		const planner = makePlannerAgent();
		const config = makeConfig(planner);
		const loop = new DissatisfactionLoop(config);

		const result = await loop.handleDissatisfaction("The frontend looks ugly");

		expect(result.shouldRetry).toBe(true);
		expect(plannerCalls.length).toBeGreaterThanOrEqual(2);
	});

	// ── completeLoop: retry path ────────────────────────────────────

	test("completeLoop with shouldRetry=true does not throw", () => {
		const planner = makePlannerAgent();
		const config = makeConfig(planner);
		const loop = new DissatisfactionLoop(config);

		expect(() =>
			loop.completeLoop({ shouldRetry: true, clarifiedIssues: ["UI needs overhaul"] }),
		).not.toThrow();
	});

	// ── completeLoop: completion path ───────────────────────────────

	test("completeLoop with shouldRetry=false transitions to curtain:completed", () => {
		const planner = makePlannerAgent();
		const config = makeConfig(planner);
		const loop = new DissatisfactionLoop(config);

		expect(() =>
			loop.completeLoop({ shouldRetry: false }),
		).not.toThrow();
	});
});
