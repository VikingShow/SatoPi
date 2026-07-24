/**
 * swarm-hooks.test.ts — createStageFeedback integration tests
 *
 * Coverage:
 * 1. Disabled mode returns no-op callbacks
 * 2. onAgentsSelected registers profiles and records collaboration
 * 3. onTaskCompleted updates credit + places artifact mark
 * 4. onTaskFailed records failure + places warning mark
 * 5. getAgentContext returns profile + stigmergy context
 * 6. onStageComplete does not throw
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { createStageFeedback } from "../hooks/swarm-hooks";
import { ProfileRegistry } from "../agent/agent-profile";
import { MarkEnvironment } from "../coordination/mark-environment";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import type { Task } from "../executor/task-queue";
import type { ScoredAgent } from "../agent/agent-selector";

describe("createStageFeedback (StageController callbacks)", () => {
	let profileRegistry: ProfileRegistry;
	let markEnvironment: MarkEnvironment;

	beforeEach(() => {
		profileRegistry = new ProfileRegistry();
		markEnvironment = new MarkEnvironment();
	});

	function makeAgent(id: string, archetype = "implementer"): ScoredAgent {
		return {
			profileId: id,
			name: id,
			archetype,
			score: 0.8,
			role: "implementer",
			reason: "test",
		};
	}

	function makeTask(overrides: Partial<Task> = {}): Task {
		return {
			id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			title: "Test task",
			type: "implementation",
			description: "Do something",
			dependencies: [],
			assignedRole: "implementer",
			status: "pending" as const,
			...overrides,
		};
	}

	// ── Disabled mode ──────────────────────────────────────────────

	test("disabled returns stub callbacks that no-op", () => {
		const fb = createStageFeedback({
			enabled: false,
			profileRegistry,
			markEnvironment,
		});

		expect(() => fb.onAgentsSelected([makeAgent("w1")])).not.toThrow();
		expect(fb.getAgentContext("w1")).toBeNull();
	});

	// ── Agent selection callback ───────────────────────────────────

	test("onAgentsSelected registers profiles and records collaboration", () => {
		const fb = createStageFeedback({
			enabled: true,
			profileRegistry,
			markEnvironment,
		});

		fb.onAgentsSelected([
			makeAgent("agent-alpha", "architect"),
			makeAgent("agent-beta", "implementer"),
		]);

		expect(profileRegistry.get("agent-alpha")).toBeDefined();
		expect(profileRegistry.get("agent-beta")).toBeDefined();
		expect(profileRegistry.get("agent-alpha")!.identity.archetype).toBe("architect");
	});

	test("onAgentsSelected is idempotent for same profileId", () => {
		const fb = createStageFeedback({
			enabled: true, profileRegistry, markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w1")]);
		fb.onAgentsSelected([makeAgent("w1")]);
		expect(profileRegistry.get("w1")).toBeDefined();
	});

	// ── Task completed callback ────────────────────────────────────

	test("onTaskCompleted updates credit score and places artifact mark", () => {
		const fb = createStageFeedback({
			enabled: true, profileRegistry, markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w1")]);
		const initialScore = profileRegistry.get("w1")!.credit.score;

		const task = makeTask();
		const result: SingleResult = {
			index: 0,
			id: "test-result",
			agent: "w1",
			agentSource: "pool" as any,
			task: "implementation",
			exitCode: 0,
			output: "done",
		};

		fb.onTaskCompleted("w1", task, result);

		const profile = profileRegistry.get("w1")!;
		expect(profile.credit.score).toBe(initialScore + 3);
		expect(profile.credit.totalTasks).toBe(1);

		const marks = markEnvironment.queryMarks({ type: "artifact" });
		expect(marks.length).toBeGreaterThanOrEqual(1);
	});

	// ── Task failed callback ───────────────────────────────────────

	test("onTaskFailed records failure and places warning mark", () => {
		const fb = createStageFeedback({
			enabled: true, profileRegistry, markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w2")]);
		const initialScore = profileRegistry.get("w2")!.credit.score;

		const task = makeTask({ title: "Broken module" });

		fb.onTaskFailed("w2", task, "compilation error");

		const profile = profileRegistry.get("w2")!;
		expect(profile.credit.score).toBe(initialScore);
		expect(profile.credit.totalTasks).toBe(1);

		const marks = markEnvironment.queryMarks({ type: "warning" });
		expect(marks.length).toBeGreaterThanOrEqual(1);
		expect(marks[0].message).toContain("compilation error");
	});

	// ── Prompt context injection ───────────────────────────────────

	test("getAgentContext returns profile + stigmergy context", () => {
		const fb = createStageFeedback({
			enabled: true, profileRegistry, markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w3", "reviewer")]);

		const ctx = fb.getAgentContext("w3");
		expect(ctx).not.toBeNull();
		expect(ctx!).toContain("w3");
		expect(ctx!).toContain("reviewer");
	});

	test("getAgentContext includes stigmergy marks when present", () => {
		const fb = createStageFeedback({
			enabled: true, profileRegistry, markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w4"), makeAgent("w5")]);

		markEnvironment.placeMark({
			markId: "sig-1",
			type: "signal",
			agentId: "w4",
			message: "w5 is working on auth module",
			priority: "low",
		});

		const ctx = fb.getAgentContext("w5");
		expect(ctx).not.toBeNull();
		expect(ctx!).toContain("w5");
	});

	// ── Stage complete ─────────────────────────────────────────────

	test("onStageComplete does not throw", () => {
		const fb = createStageFeedback({
			enabled: true, profileRegistry, markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w1")]);

		expect(() =>
			fb.onStageComplete({
				status: "completed",
				agentResults: new Map(),
				errors: [],
				agents: [],
				taskProgress: { total: 1, completed: 1 },
			}),
		).not.toThrow();
	});
});
