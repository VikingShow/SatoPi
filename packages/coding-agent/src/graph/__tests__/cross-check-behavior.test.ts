/**
 * cross-check-behavior.test.ts — CrossCheckBehavior contracts (Phase E1b).
 *
 * - Deliverables (tasks parsed from the plan, restricted to tasks the shared
 *   queue reports as completed) are dispatched to reviewer-role agents
 *   (swarm-reviewer profile) via the runtime spawn seam.
 * - A flawed deliverable (VERDICT: REWORK) yields a rework verdict, its task
 *   is blocked in the shared TaskQueue, and the run state records it
 *   (pipeline reviewVerdict + ActivityLogger verdict).
 * - Approved deliverables leave their queue task untouched.
 * - No deliverables → skip without spawning reviewers.
 */
import { describe, expect, test, vi } from "bun:test";
import type { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent/agent-session";
import type { ReviewVerdict } from "../../types/pipeline-types";
import { CrossCheckBehavior } from "../behaviors/cross-check-behavior";
import { TaskQueue } from "../task-queue";
import type { NodeContext } from "../types";

// ============================================================================
// Fixtures
// ============================================================================

const PLAN = [
	"# Build Plan",
	"",
	"## Phase 1",
	"- [ ] implement-login (type: develop) (role: implementer) (est: 30m)",
	"- [ ] write-tests (type: test) (role: tester) (est: 20m)",
].join("\n");

/** Fake reviewer session whose wait() resolves to the given output. */
function fakeSession(output: string): AgentSession {
	return {
		id: "reviewer",
		status: "completed",
		wait: async () => ({ output }),
		abort: () => {},
	} as unknown as AgentSession;
}

function makeContext(
	overrides: Partial<{
		taskQueue: TaskQueue;
		spawn: (specs: unknown[]) => Promise<AgentSession[]>;
		stateTracker: { updatePipeline: (update: unknown) => Promise<void> };
		activityLogger: { logVerdict: (verdict: ReviewVerdict) => void };
	}>,
): { ctx: NodeContext; spawn: ReturnType<typeof vi.fn>; queue: TaskQueue } {
	const queue = overrides.taskQueue ?? new TaskQueue(TaskQueue.parseFromPlan(PLAN));
	const spawn = vi.fn(overrides.spawn ?? (async (_specs: unknown[]) => [fakeSession("VERDICT: APPROVED\nAll good")]));
	const stateTracker = overrides.stateTracker ?? { updatePipeline: vi.fn(async () => {}) };
	const activityLogger = overrides.activityLogger ?? { logVerdict: vi.fn() };
	const settings = { get: () => false } as unknown as Settings;

	const ctx = {
		node: {
			id: "cross_check",
			label: "Cross-Check",
			description: "Review stage deliverables",
			role: "reviewer",
			tools: ["read", "grep"],
			dependsOn: ["stage"],
			type: "cross-check",
		},
		workspace: "/tmp/ws",
		modelRegistry: {} as never,
		settings,
		upstreamOutputs: {},
		experience: "",
		signal: new AbortController().signal,
		runtime: { spawn },
		agentRegistry: { global: () => ({ list: () => [] }) } as never,
		stateTracker,
		activityLogger,
		planContent: PLAN,
		taskQueue: queue,
	} as unknown as NodeContext;

	return { ctx, spawn, queue };
}

// ============================================================================
// Tests
// ============================================================================

describe("CrossCheckBehavior", () => {
	test("spawns reviewer agents for completed deliverables and records rework verdicts", async () => {
		const queue = new TaskQueue(TaskQueue.parseFromPlan(PLAN));
		queue.complete("implement-login");
		queue.complete("write-tests");

		const spawn = vi.fn(async (_specs: unknown[]) => [
			fakeSession("VERDICT: APPROVED\nLogin flow verified"),
			fakeSession("VERDICT: REWORK\nMissing error handling for bad credentials"),
		]);
		const stateTracker = { updatePipeline: vi.fn(async () => {}) };
		const activityLogger = { logVerdict: vi.fn() };

		const behavior = new CrossCheckBehavior();
		const prepared = await behavior.prepare({} as never);
		const result = await behavior.execute(
			makeContext({ taskQueue: queue, spawn, stateTracker, activityLogger }).ctx,
			prepared,
		);

		// Reviewer agents got the swarm-reviewer profile via the spawn seam.
		const specs = spawn.mock.calls[0]![0] as Array<Record<string, unknown>>;
		expect(specs).toHaveLength(2);
		for (const spec of specs) {
			expect(spec).toMatchObject({ role: "reviewer", roleSource: "profile", profileId: "swarm-reviewer" });
		}

		// Cross-check ran (node succeeds even when deliverables fail — rework is
		// recorded through the queue + run state, not a graph abort).
		expect(result.success).toBe(true);
		const verdicts = result.metadata?.verdicts as Array<{ deliverableId: string; passed: boolean }>;
		expect(verdicts).toHaveLength(2);
		expect(verdicts.find(v => v.deliverableId === "implement-login")?.passed).toBe(true);
		expect(verdicts.find(v => v.deliverableId === "write-tests")?.passed).toBe(false);

		// Rework: the flawed task is blocked in the shared queue.
		expect(queue.get("write-tests")?.status).toBe("blocked");
		expect(queue.get("implement-login")?.status).toBe("completed");

		// Run state records the verdict summary.
		expect(stateTracker.updatePipeline).toHaveBeenCalledWith(
			expect.objectContaining({ reviewVerdict: expect.stringContaining("write-tests") }),
		);
		const verdict = (activityLogger.logVerdict as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ReviewVerdict;
		expect(verdict.passed).toBe(false);
		expect(verdict.approvalCount).toBe(1);
		expect(verdict.totalCount).toBe(2);
	});

	test("reviews only tasks the shared queue reports as completed", async () => {
		const queue = new TaskQueue(TaskQueue.parseFromPlan(PLAN));
		queue.complete("implement-login");
		// write-tests is still pending → excluded from the review pass.

		const { ctx, spawn } = makeContext({ taskQueue: queue });

		const behavior = new CrossCheckBehavior();
		const result = await behavior.execute(ctx, await behavior.prepare(ctx));

		const specs = spawn.mock.calls[0]![0] as Array<Record<string, unknown>>;
		expect(specs).toHaveLength(1);
		expect(specs[0]).toMatchObject({ role: "reviewer", profileId: "swarm-reviewer" });
		expect(specs[0]!.task).toContain("implement-login");
		expect(result.metadata?.verdicts).toHaveLength(1);
	});

	test("skips when the plan has no tasks to review", async () => {
		const queue = new TaskQueue(TaskQueue.parseFromPlan(PLAN));
		const { ctx, spawn } = makeContext({ taskQueue: queue });
		ctx.planContent = "# Plan with no checkbox tasks";

		const behavior = new CrossCheckBehavior();
		const result = await behavior.execute(ctx, await behavior.prepare(ctx));

		expect(result.success).toBe(true);
		expect(result.output).toContain("No Stage deliverables");
		expect(spawn).not.toHaveBeenCalled();
	});
});
