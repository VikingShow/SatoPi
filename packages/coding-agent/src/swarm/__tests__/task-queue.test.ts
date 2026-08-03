/**
 * task-queue.test.ts — Unit tests for TaskQueue plan parsing.
 *
 * Covers:
 * - Valid multi-phase plan (metadata parsing — type/role/est)
 * - Malformed plan (invalid DAG — missing dependency)
 * - Single-task plan
 * - Multi-task DAG plan with dependencies
 *
 * NOTE: slugify() includes the full title (including parenthetical metadata)
 * in the task ID. So depends values that reference other tasks must match
 * the slugified ID of the referenced task. For clean DAG tests, keep
 * referenced task names bare (no parenthetical) so slugify(id) equals the
 * depends value.
 *
 * The former createTaskQueueFromPlan() wrapper (which added an "execute-plan"
 * fallback task for empty plans) lived in the deleted stage-controller.ts;
 * these tests now exercise TaskQueue.parseFromPlan directly.
 */

import { describe, expect, test } from "bun:test";

import { TaskQueue } from "../../graph/task-queue";

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal plan markdown with tasks. */
function planWithTasks(lines: string[]): string {
	return `# Implementation Plan

${lines.join("\n")}
`;
}

// ============================================================================
// Tests
// ============================================================================

describe("TaskQueue.parseFromPlan", () => {
	// ── Case 1: valid multi-phase plan (metadata parsing) ─────────────────

	test("parses a valid multi-phase plan with typed tasks and metadata", () => {
		// Each task has type metadata and optional est/role.
		// No depends here — metadata parsing is the focus.
		const plan = planWithTasks([
			"- [ ] setup-db (type: config) (role: dba) (est: 15m)",
			"- [ ] implement-auth (type: develop) (role: developer) (est: 45m)",
			"- [ ] test-auth (type: test) (role: tester) (est: 20m)",
			"- [ ] review-auth (type: review) (role: reviewer) (est: 10m)",
			"- [ ] update-docs (type: docs) (role: developer) (est: 5m)",
		]);

		const tasks = TaskQueue.parseFromPlan(plan);
		const queue = new TaskQueue(tasks);

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

	// ── Case 2: malformed plan — missing dependency target ────────────────

	test("throws when a task depends on a non-existent task id", () => {
		// Task B depends on "ghost-task" which doesn't exist in the plan.
		const plan = planWithTasks(["- [ ] Task A", "- [ ] Task B (depends: ghost-task)"]);

		// slugify only uses the title (parentheticals are metadata), so the
		// task id is "task-b" while the dependsOn value is "ghost-task".
		expect(() => new TaskQueue(TaskQueue.parseFromPlan(plan))).toThrow(
			/Task "task-b" depends on unknown task "ghost-task"/,
		);
	});

	// ── Case 3: single-task plan ─────────────────────────────────────────

	test("creates a queue with a single parsed task", () => {
		const plan = planWithTasks(["- [ ] build-everything (type: develop) (est: 120m)"]);

		const tasks = TaskQueue.parseFromPlan(plan);
		const queue = new TaskQueue(tasks);

		expect(queue).toBeInstanceOf(TaskQueue);
		expect(tasks.length).toBe(1);
		expect(tasks[0].type).toBe("develop");
		expect(tasks[0].estimatedMinutes).toBe(120);
		expect(queue.tasks.size).toBe(1);
		expect(queue.readyQueue.length).toBe(1); // single task is immediately ready
		expect(queue.isAllComplete).toBe(false);
	});

	// ── Case 4: multi-task DAG plan ─────────────────────────────────────

	test("creates a queue with a multi-task DAG and correct readiness", () => {
		// Keep referenced tasks bare (no parenthetical) so their slugified ID
		// matches the dependsOn value that other tasks reference.
		// Only the leaf task (integration-tests) carries a depends parenthetical;
		// its slugified ID is still "integration-tests" (parentheticals are
		// metadata), and it is never referenced as a dependency.
		const plan = planWithTasks([
			"- [ ] design-api",
			"- [ ] implement-controllers",
			"- [ ] implement-models",
			"- [ ] integration-tests (depends: implement-controllers, implement-models)",
		]);

		const tasks = TaskQueue.parseFromPlan(plan);
		const queue = new TaskQueue(tasks);

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

		const queue = new TaskQueue(TaskQueue.parseFromPlan(plan));

		// All 3 should be ready (no deps), ordered alphabetically by slug
		expect(queue.readyQueue.length).toBe(3);
		expect(queue.readyQueue).toContain("load-data");
		expect(queue.readyQueue).toContain("validate-schemas");
		expect(queue.readyQueue).toContain("generate-report");
	});
});
