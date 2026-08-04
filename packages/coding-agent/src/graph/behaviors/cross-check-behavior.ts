/**
 * CrossCheckBehavior — NodeBehavior for the `cross-check` graph node.
 *
 * Runs after the Stage wave. Every deliverable (a task parsed from the
 * plan, restricted to tasks the stage actually completed when the shared
 * task queue is available) is dispatched to a `reviewer`-role agent
 * (`swarm-reviewer` profile) that returns an explicit verdict:
 *
 *   VERDICT: APPROVED
 *   VERDICT: REWORK
 *
 * Verdicts are recorded in the run state (pipeline `reviewVerdict` summary,
 * ActivityLogger `logVerdict`, and the node result metadata). Deliverables
 * flagged for rework have their task blocked in the shared TaskQueue so
 * the existing retry/backoff machinery can pick them up on the next run.
 *
 * Lifecycle: prepare → (no-op) → execute (spawn reviewers, await verdicts)
 * → validate (pass-through — GraphRunner drives gates) → cleanup.
 */

import { logger, prompt } from "@satopi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import crossCheckReviewerPrompt from "../../swarm/prompts/cross-check-reviewer.md" with { type: "text" };
import type { ReviewVerdict } from "../../types/pipeline-types";
import type { AgentSpec } from "../agent-spec";
import type { GateResult, GateSpec, NodeBehavior, NodeContext, NodeResult } from "../schema";
import { TaskQueue } from "../task-queue";

// ============================================================================
// Types
// ============================================================================

/** Per-deliverable review outcome produced by one reviewer agent. */
export interface CrossCheckVerdict {
	/** Task/deliverable id (from the plan task list). */
	deliverableId: string;
	/** Whether the reviewer approved the deliverable. */
	passed: boolean;
	/** Reviewer agent id that produced the verdict. */
	reviewer: string;
	/** Reviewer rationale (trimmed output). */
	rationale: string;
}

// ============================================================================
// CrossCheckBehavior
// ============================================================================

export class CrossCheckBehavior implements NodeBehavior {
	readonly name = "cross-check";

	/** Spawned reviewer sessions — tracked for cleanup. */
	#sessions: AgentSession[] = [];

	// ======================================================================
	// prepare
	// ======================================================================

	async prepare(_ctx: NodeContext): Promise<AgentSpec[]> {
		return [];
	}

	// ======================================================================
	// execute
	// ======================================================================

	async execute(ctx: NodeContext, _prepared: AgentSpec[]): Promise<NodeResult> {
		const nodeId = ctx.node.id;

		// Deliverables = tasks parsed from the plan. When the shared task
		// queue is present, restrict to tasks the stage actually completed.
		const allTasks = TaskQueue.parseFromPlan(ctx.planContent ?? "");
		const queue = ctx.taskQueue;
		const deliverables =
			queue && queue.completed.length > 0 ? allTasks.filter(t => queue.completed.includes(t.id)) : allTasks;

		if (deliverables.length === 0) {
			logger.info("[CrossCheckBehavior] No stage deliverables to review", { nodeId });
			return { nodeId, success: true, output: "No Stage deliverables to review — cross-check skipped." };
		}

		const reviewerSystemPrompt = prompt.render(crossCheckReviewerPrompt);

		const specs: AgentSpec[] = deliverables.map(task => ({
			id: `cross-reviewer-${task.id}`,
			role: "reviewer",
			roleSource: "profile",
			profileId: "swarm-reviewer",
			phase: "stage",
			task: [
				`Task ID: ${task.id}`,
				`Deliverable: ${task.title}`,
				task.files && task.files.length > 0 ? `Files: ${task.files.join(", ")}` : "",
				`Assigned role: ${task.assignedRole}`,
				"",
				reviewerSystemPrompt,
			]
				.filter(Boolean)
				.join("\n"),
		}));

		logger.info("[CrossCheckBehavior] Dispatching deliverables to reviewers", {
			nodeId,
			deliverableCount: deliverables.length,
		});

		let sessions: AgentSession[];
		try {
			sessions = await ctx.runtime.spawn(specs);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("[CrossCheckBehavior] Failed to spawn reviewers", { nodeId, error: message });
			return { nodeId, success: false, error: message };
		}
		this.#sessions = sessions;

		const settled = await Promise.allSettled(sessions.map(s => s.wait()));

		const verdicts: CrossCheckVerdict[] = deliverables.map((task, i) => {
			const reviewer = sessions[i]?.id ?? specs[i]!.id;
			const outcome = settled[i];
			if (outcome?.status === "rejected") {
				const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
				return { deliverableId: task.id, passed: false, reviewer, rationale: `Reviewer crashed: ${reason}` };
			}
			const output =
				typeof outcome?.value?.output === "string" ? outcome.value.output : String(outcome?.value?.output ?? "");
			const match = output.match(/VERDICT:\s*(APPROVED|REWORK)/i);
			// Fail-closed: only an explicit APPROVED marker passes.
			const passed = match ? match[1]!.toUpperCase() === "APPROVED" : false;
			return { deliverableId: task.id, passed, reviewer, rationale: output.trim().slice(0, 2000) };
		});

		const failed = verdicts.filter(v => !v.passed);
		const approved = verdicts.filter(v => v.passed);

		// Mark failing deliverables for rework: block their task in the
		// shared queue so the next stage run picks them up again.
		for (const verdict of failed) {
			if (queue?.tasks.has(verdict.deliverableId)) {
				queue.block(verdict.deliverableId);
				logger.info("[CrossCheckBehavior] Blocked task for rework", {
					nodeId,
					taskId: verdict.deliverableId,
				});
			}
		}

		// Record verdicts in the run state.
		const reviewVerdict: ReviewVerdict = {
			passed: failed.length === 0,
			approvalCount: approved.length,
			totalCount: verdicts.length,
			findings: failed.map(v => `${v.deliverableId}: ${v.rationale}`),
			agentCountSuggestions: [],
			disagreed: false,
			praisedAgents: approved.map(v => v.reviewer),
			criticizedAgents: failed.map(v => v.reviewer),
		};
		const summary =
			failed.length === 0
				? `Cross-check: ${approved.length}/${verdicts.length} deliverables approved.`
				: `Cross-check: ${failed.length} deliverable(s) sent back for rework: ${failed.map(v => v.deliverableId).join(", ")}.`;
		await ctx.stateTracker
			?.updatePipeline({ reviewVerdict: summary })
			.catch(err => logger.error("[CrossCheckBehavior] updatePipeline failed", { error: String(err) }));
		ctx.activityLogger?.logVerdict(reviewVerdict);

		const output = [
			summary,
			"",
			...verdicts.map(v => `- [${v.passed ? "APPROVED" : "REWORK"}] ${v.deliverableId} (${v.reviewer})`),
			"",
			...failed.map(v => `  ${v.deliverableId}: ${v.rationale}`),
		].join("\n");

		return {
			nodeId,
			success: true,
			output,
			metadata: { verdicts },
		};
	}

	// ======================================================================
	// validate
	// ======================================================================

	async validate(result: NodeResult, gate?: GateSpec): Promise<GateResult> {
		if (!gate) {
			return { passed: true, failures: [], humanReviewRequired: false };
		}
		return {
			passed: result.success,
			failures: result.error ? [result.error] : [],
			humanReviewRequired: false,
		};
	}

	// ======================================================================
	// cleanup
	// ======================================================================

	async cleanup(_ctx: NodeContext): Promise<void> {
		for (const session of this.#sessions) {
			try {
				session.abort({ reason: "cleanup" });
			} catch {
				// Agent already terminated — ignore
			}
		}
		this.#sessions = [];
	}
}
