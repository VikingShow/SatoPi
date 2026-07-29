/**
 * task-queue.test.ts — Unit tests for createTaskQueueFromPlan() factory.
 *
 * Covers:
 * - Valid multi-phase plan (metadata parsing — type/role/est)
 * - Empty plan (default task fallback)
 * - Malformed plan (invalid DAG — missing dependency)
 * - Single-task plan
 * - Multi-task DAG plan with dependencies
 *
 * NOTE: slugify() includes the full title (including parenthetical metadata)
 * in the task ID. So depends values that reference other tasks must match
 * the slugified ID of the referenced task. For clean DAG tests, keep
 * referenced task names bare (no parenthetical) so slugify(id) equals the
 * depends value.
 */

import { describe, expect, test } from "bun:test";

import { TaskQueue } from "../executor/task-queue";
import { createTaskQueueFromPlan } from "../stage/stage-controller";

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal plan markdown with tasks. */
function planWithTasks(lines: string[]): string {
	return `# Implementation Plan

## Overview

This plan covers the feature implementation.

## Tasks
${lines.join("\n")}
`;
}

// ============================================================================
// Tests
// ============================================================================

describe("createTaskQueueFromPlan", () => {
	// ── Case 1: valid multi-phase plan (metadata parsing) ─────────────────

	test("parses a valid multi-phase plan with typed tasks and metadata", () => {
		// Each task has type metadata and optional est/role.
		// No depends here — metadata parsing is the focus.
		const plan = planWithTasks([
			"- [ ] setup-db (type: config, est: 15, role: dba)",
			"- [ ] implement-auth (type: develop, files: src/auth/*.ts, est: 45)",
			"- [ ] test-auth (type: test, est: 20)",
			"- [ ] review-auth (type: review, est: 10)",
			"- [ ] update-docs (type: docs, est: 5)",
		]);

		const { queue, tasks } = createTaskQueueFromPlan(plan);

		expect(queue).toBeInstanceOf(TaskQueue);
		expect(tasks.length).toBe(5);

		// Verify task types and derived role assignments from metadata
		const configTask = tasks.find(t => t.type === "config")!;
		expect(configTask).toMatchObject({ type: "config", assignedRole: "dba", estimatedMinutes: 15 });

		const devTask = tasks.find(t => t.type === "develop")!;
		expect(devTask).toMatchObject({ type: "develop", assignedRole: "developer", estimatedMinutes: 45 });

		const testTask = tasks.find(t => t.type === "test")!;
		expect(testTask).toMatchObject({ type: "test", assignedRole: "tester", estimatedMinutes: 20 });

		const reviewTask = tasks.find(t => t.type === "review")!;
		expect(reviewTask).toMatchObject({ type: "review", assignedRole: "reviewer", estimatedMinutes: 10 });

		const docsTask = tasks.find(t => t.type === "docs")!;
		expect(docsTask).toMatchObject({ type: "docs", assignedRole: "developer", estimatedMinutes: 5 });
	});

	// ── Case 2: empty plan ───────────────────────────────────────────────

	test("falls back to default task when plan is empty", () => {
		const { queue, tasks } = createTaskQueueFromPlan("");

		expect(queue).toBeInstanceOf(TaskQueue);
		expect(tasks.length).toBe(1);
		expect(tasks[0]).toMatchObject({
			id: "execute-plan",
			title: "Execute the plan as described",
			type: "develop",
			dependsOn: [],
		});
	});

	// ── Case 3: malformed plan — missing dependency target ────────────────

	test("throws when a task depends on a non-existent task id", () => {
		// Task B depends on "ghost-task" which doesn't exist in the plan.
		const plan = planWithTasks(["- [ ] Task A", "- [ ] Task B (depends: ghost-task)"]);

		// slugify("Task B (depends: ghost-task)") includes the parenthetical
		// in the task ID, but the dependsOn value is just "ghost-task".
		expect(() => createTaskQueueFromPlan(plan)).toThrow(
			/Task "task-b-depends-ghost-task" depends on unknown task "ghost-task"/,
		);
	});

	// ── Case 4: single-task plan ─────────────────────────────────────────

	test("creates a queue with a single parsed task", () => {
		const plan = planWithTasks(["- [ ] build-everything (type: develop, est: 120)"]);

		const { queue, tasks } = createTaskQueueFromPlan(plan);

		expect(queue).toBeInstanceOf(TaskQueue);
		expect(tasks.length).toBe(1);
		expect(tasks[0].type).toBe("develop");
		expect(tasks[0].estimatedMinutes).toBe(120);
		expect(queue.tasks.size).toBe(1);
		expect(queue.readyQueue.length).toBe(1); // single task is immediately ready
		expect(queue.isAllComplete).toBe(false);
	});

	// ── Case 5: multi-task DAG plan ─────────────────────────────────────

	test("creates a queue with a multi-task DAG and correct readiness", () => {
		// Keep referenced tasks bare (no parenthetical) so their slugified ID
		// matches the dependsOn value that other tasks reference.
		// Only the leaf task (integration-tests) has a parenthetical for its
		// depends — its own ID will include the parenthetical, but it is
		// never referenced as a dependency.
		const plan = planWithTasks([
			"- [ ] design-api",
			"- [ ] implement-controllers",
			"- [ ] implement-models",
			"- [ ] integration-tests (depends: implement-controllers, implement-models)",
		]);

		const { queue, tasks } = createTaskQueueFromPlan(plan);

		expect(tasks.length).toBe(4);
		expect(queue.tasks.size).toBe(4);

		// Only the root tasks (no deps) should be ready
		expect(queue.readyQueue.length).toBe(3);
		expect(queue.readyQueue).toContain("design-api");
		expect(queue.readyQueue).toContain("implement-controllers");
		expect(queue.readyQueue).toContain("implement-models");
		expect(queue.progress).toMatchObject({
			total: 4,
			completed: 0,
			inProgress: 0,
			ready: 3,
		});
	});

	test("all independent tasks are ready in a DAG with no dependencies", () => {
		// Bare names only — no parenthetical metadata to avoid slug issues
		const plan = planWithTasks(["- [ ] load-data", "- [x] validate-schemas", "- [ ] generate-report"]);

		const { queue } = createTaskQueueFromPlan(plan);

		// All 3 should be ready (no deps), ordered alphabetically by slug
		expect(queue.readyQueue.length).toBe(3);
		expect(queue.readyQueue).toContain("load-data");
		expect(queue.readyQueue).toContain("validate-schemas");
		expect(queue.readyQueue).toContain("generate-report");
	});
});
