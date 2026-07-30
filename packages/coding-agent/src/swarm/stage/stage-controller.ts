/**
 * StageController — Canonical stage execution with rich features.
 *
 * This is the full-featured stage orchestration with profile-based agent
 * selection, domain matching, complexity analysis, credit-aware role
 * assignment, retry-with-backoff, and circuit breaker.  Used by the
 * graph engine ({@link StageNodeBehavior}) which calls its monolithic
 * {@link run()} method.
 *
 * ## Relationship with StageBehavior
 *
 * {@link StageBehavior} is a lightweight PhaseBehavior adapter for the
 * theatre graph engine's event-driven lifecycle.  It uses simplified
 * agent creation (one agent per unique task role) and delegates
 * task-parsing and role-assignment to shared helpers from this module
 * ({@link assignAgentRoles}, {@link TaskQueue.parseFromPlan}).
 *
 * StageController and StageBehavior serve **different API surfaces**:
 *   - StageController: monolithic `run()` → `StageResult` (for NodeBehavior)
 *   - StageBehavior: event-driven enter/handleAgentEvent/checkCompletion/exit
 *
 * ## Flow
 *   1. Select agents (scored by domain match + credit)
 *   2. Roundtable for role assignment (agents discuss, system resolves)
 *   3. Parse plan.md → TaskQueue (DAG with dependencies)
 *   4. Spawn all agents in parallel, each with assigned role
 *   5. Event-driven: claim → work → complete → trigger dependents
 *   6. All tasks done → spawn reporter agent → user applauds → Curtain
 */

import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";
import type { SingleResult } from "@satopi/pi-coding-agent/task";
import { logger } from "@satopi/pi-utils";
import type { ProfileRegistry } from "../../agent/agent-profile";
import { extractDomains, type ScoredAgent, selectAgents } from "../../agent/agent-selector";
import type { RoleAssetManager } from "../../agent/role-asset";
import type { IrcBus } from "../../irc/bus";
import type { SwarmRuntime } from "../core/swarm-runtime";
import type { LoopSwarmConfig } from "../core/schema";
import type { StateTracker } from "../core/state";
import { type Task, TaskQueue } from "../../graph/task-queue";
import type { HookPipeline } from "../../hooks/hook-pipeline";
import type { ActivityLogger } from "../../infra/activity-logger";
import { TaskComplexityAnalyzer } from "../script/task-analyzer";
import type { RoleCandidate } from "./role-roundtable";

// ============================================================================
// StageCallbacks — feedback interface for Profile credit + Stigmergy marks
// ============================================================================

/**
 * Callbacks invoked by StageController at key lifecycle points.
 * Implementations wire ProfileRegistry credit updates and MarkEnvironment
 * signal placement without StageController needing to know about them.
 */
export interface StageCallbacks {
	/** Called after agent selection completes. */
	onAgentsSelected(agents: ScoredAgent[]): void;
	/** Called when an agent successfully completes a task. */
	onTaskCompleted(agentId: string, task: Task, result: SingleResult): void;
	/** Called when an agent fails a task. */
	onTaskFailed(agentId: string, task: Task, error: string): void;
	/** Called when the entire Stage finishes. */
	onStageComplete(result: StageResult): void;
	/** Called when building an agent's prompt. Return extra context to inject, or null. */
	getAgentContext(agentId: string): string | null;
}

// ============================================================================
// Types
// ============================================================================

export interface StageOptions {
	workspace: string;
	swarmName: string;
	planContent: string;
	loopConfig: LoopSwarmConfig;
	stateTracker: StateTracker;
	activityLogger: ActivityLogger;
	modelRegistry: ModelRegistry;
	settings: Settings;
	signal?: AbortSignal;
	profileRegistry: ProfileRegistry;
	roleAssetManager: RoleAssetManager;
	/** Pre-selected agent IDs (skip selection algorithm). */
	agentIds?: string[];
	/** User-specified agent count (overrides complexity analyzer). */
	agentCount?: number;
	/** Agent tooling strategy for spawned agents ("swift" or "main"). */
	agentTooling?: "swift" | "main";
	/** P7: Stage lifecycle callbacks (credit updates, stigmergy marks). */
	callbacks?: StageCallbacks;
	/** v3: Unified hook pipeline for lifecycle events. */
	hookPipeline?: HookPipeline;
	/** v3: SwarmRuntime — required for agent spawning (unified execution path). */
	runtime?: SwarmRuntime;
	ircBus?: IrcBus;
	/** P5: Max retries per task before blocking (default 3). */
	maxRetries?: number;
	/** P5: Base delay for exponential backoff between retries (default 5000ms). */
	retryBaseDelayMs?: number;
	/** P6: Per-agent execution timeout in ms (default 300_000 = 5 minutes). */
	agentTimeoutMs?: number;
}

export interface StageResult {
	status: "completed" | "failed" | "aborted";
	agentResults: Map<string, SingleResult[]>;
	errors: string[];
	/** Selected agents with their assigned roles. */
	agents: Array<{ id: string; role: string }>;
	/** Task queue progress snapshot. */
	taskProgress: { total: number; completed: number };
	/** Non-fatal degradation events accumulated during stage execution. */
	degradedMode: string[];
}

// ============================================================================
// StageController
// ============================================================================

// ============================================================================
// Standalone helpers — shared between StageController and StageBehavior
// ============================================================================

/** Options for {@link assignAgentRoles}, the shared role-assignment algorithm. */
export interface RoleAssignmentOptions {
	planContent: string;
	roleAssetManager: Pick<RoleAssetManager, "list">;
	activityLogger: Pick<ActivityLogger, "logBroadcast">;
	/** Optional IrcBus for roundtable negotiation. */
	ircBus?: IrcBus;
}

/**
 * Shared role-assignment algorithm used by both StageController and
 * StageBehavior.  Assigns each agent a role based on plan task types,
 * agent preferences, and optional roundtable negotiation.
 *
 * Algorithm: derive roles from plan tasks → fall back to role library →
 * prefer agent.preferredRoles → round-robin assignment for remaining.
 */
export async function assignAgentRoles(
	agents: ScoredAgent[],
	opts: RoleAssignmentOptions,
): Promise<Array<{ id: string; role: string }>> {
	const { planContent, roleAssetManager, activityLogger, ircBus } = opts;

	// 1. Derive needed roles from plan.md task types
	const taskRoles = TaskQueue.parseFromPlan(planContent)
		.map(t => t.assignedRole)
		.filter(Boolean);

	// 2. Fall back to approved roles from the role library
	let availableRoles = [...new Set(taskRoles)];
	if (availableRoles.length === 0) {
		const allRoles = await roleAssetManager.list("approved");
		availableRoles = allRoles
			.sort((a, b) => (b.usage_count ?? 0) - (a.usage_count ?? 0))
			.slice(0, Math.max(agents.length, 3))
			.map(r => r.id);
	}

	// 3. Single agent: pick the most-used approved role or "developer"
	if (agents.length === 1) {
		const fallbackRole = availableRoles[0] ?? "developer";
		return [{ id: agents[0].profileId, role: fallbackRole }];
	}

	// 4. Build candidate list for roundtable
	const candidates: RoleCandidate[] = agents.map(a => ({
		agentId: a.profileId,
		name: a.name,
		preferredRoles: a.preferredRoles ?? [],
	}));

	// 5. Try roundtable negotiation (if IrcBus is available)
	if (ircBus) {
		ircBus.groupChannel(
			"role-negotiation",
			candidates.map(c => c.agentId),
			activityLogger as ActivityLogger,
		);
	}

	// 6. Fallback: algorithm-based assignment
	// First pass: agents with strong role preference
	const assignments: Array<{ id: string; role: string }> = [];
	for (const agent of agents) {
		const preferred = agent.preferredRoles.find(r => availableRoles.includes(r));
		if (preferred) {
			assignments.push({ id: agent.profileId, role: preferred });
		}
	}

	// Second pass: remaining agents get remaining roles round-robin
	const remaining = agents.filter(a => !assignments.find(ra => ra.id === a.profileId));
	const remainingRoles = availableRoles.filter(r => !assignments.find(a => a.role === r));
	for (let i = 0; i < remaining.length; i++) {
		const role = remainingRoles[i % remainingRoles.length] ?? availableRoles[0] ?? "developer";
		assignments.push({ id: remaining[i].profileId, role });
	}

	activityLogger.logBroadcast(
		"system",
		`Algorithm role assignments: ${assignments.map(a => `${a.id}=${a.role}`).join(", ")}`,
	);

	return assignments;
}

/** Result of {@link createTaskQueueFromPlan}. */
export interface TaskQueueSetup {
	queue: TaskQueue;
	/** Raw parsed tasks (before wrapping in TaskQueue). */
	tasks: Task[];
}

/**
 * Parse plan content into a TaskQueue, creating a single default "execute-plan"
 * task when no tasks are found.  Shared between StageController and StageBehavior.
 */
export function createTaskQueueFromPlan(planContent: string): TaskQueueSetup {
	const tasks = TaskQueue.parseFromPlan(planContent);
	if (tasks.length === 0) {
		tasks.push({
			id: "execute-plan",
			title: "Execute the plan as described",
			type: "develop",
			dependsOn: [],
			estimatedMinutes: 60,
			assignedRole: "developer",
		} as unknown as Task);
	}
	return { queue: new TaskQueue(tasks as Task[]), tasks: tasks as unknown as Task[] };
}
export class StageController {
	readonly #opts: StageOptions;
	/** SwarmRuntime — required for all agent spawning (unified execution path). */
	#runtime: SwarmRuntime;

	constructor(opts: StageOptions) {
		this.#opts = opts;
		if (!opts.runtime) {
			throw new Error("[StageController] SwarmRuntime is required. Pass `runtime` in StageOptions.");
		}
		this.#runtime = opts.runtime;
	}

	/**
	 * Run the full Stage phase: select agents → assign roles → execute tasks → report.
	 */
	async run(): Promise<StageResult> {
		const { planContent, loopConfig, stateTracker, activityLogger, signal } = this.#opts;
		const errors: string[] = [];

		// ── Phase: stage ─────────────────────────────────────────────────────────
		await stateTracker.updatePipeline({ phase: "stage", status: "running" });
		activityLogger.logPhase("stage-start");

		// 1. Analyse complexity → recommendations
		const analyzer = new TaskComplexityAnalyzer();
		const recommendation = await analyzer.analyze(planContent, loopConfig);
		// Honour user-specified agent count from confirm bar
		const effectiveAgentCount = this.#opts.agentCount ?? recommendation.agents;
		logger.info("[Stage] Complexity analysis", {
			complexity: recommendation.complexity,
			agents: effectiveAgentCount,
			analyzerRecommendation: recommendation.agents,
			userOverride: this.#opts.agentCount,
			estimatedAgentHours: recommendation.estimatedAgentHours,
		});

		// 2. Select agents
		let selectedAgents: ScoredAgent[];
		if (this.#opts.agentIds && this.#opts.agentIds.length > 0) {
			selectedAgents = this.#opts.agentIds.map(id => {
				const p = this.#opts.profileRegistry.get(id);
				return {
					profileId: id,
					name: p?.identity.name ?? id,
					archetype: p?.identity.archetype ?? "worker",
					score: p?.credit.score ?? 50,
					creditScore: p?.credit.score ?? 50,
					domainMatch: 0.5,
					successRate: p?.credit.successRate ?? 0,
					recencyBonus: 1,
					preferredRoles: p?.stats.preferredRoles ?? [],
				};
			});
		} else {
			const domains = extractDomains(planContent);
			selectedAgents = selectAgents({
				required: effectiveAgentCount,
				domains,
				registry: this.#opts.profileRegistry,
			});
		}

		const required = effectiveAgentCount;
		const registry = this.#opts.profileRegistry;

		// If not enough agents available, create new ones to meet the requirement
		if (selectedAgents.length < required) {
			const missing = required - selectedAgents.length;
			for (let i = 0; i < missing; i++) {
				const id = `agent-auto-${registry.list().length + 1}`;
				const profile = registry.createProfile({
					profileId: id,
					name: id,
					archetype: "worker",
					description: "Auto-created for Stage execution",
				});
				selectedAgents.push({
					profileId: id,
					name: profile.identity.name,
					archetype: profile.identity.archetype,
					score: profile.credit.score,
					creditScore: profile.credit.score,
					domainMatch: 0.5,
					successRate: profile.credit.successRate,
					recencyBonus: 1,
					preferredRoles: profile.stats.preferredRoles,
				});
			}
			activityLogger.logBroadcast(
				"system",
				`Auto-created ${missing} new agent(s) to reach required count of ${required}`,
			);
		}

		if (selectedAgents.length === 0) {
			return {
				status: "failed",
				agentResults: new Map(),
				errors: ["No agents available"],
				agents: [],
				taskProgress: { total: 0, completed: 0 },
				degradedMode: [],
			};
		}

		// Save profiles immediately so they persist across restarts
		await registry
			.save(this.#opts.workspace)
			.catch(err => logger.error("Profile registry save failed", { error: String(err) }));

		// P7: Notify callbacks that agents have been selected
		this.#opts.callbacks?.onAgentsSelected(selectedAgents);

		activityLogger.logBroadcast(
			"system",
			`Selected ${selectedAgents.length} agents: ${selectedAgents.map(a => a.name).join(", ")}`,
		);

		// 3. Role assignment (roundtable or direct)
		const roleAssignments = await this.#assignRoles(selectedAgents);
		for (const a of roleAssignments) {
			await stateTracker.registerAgent(a.id);
			await stateTracker.updateAgent(a.id, { status: "running", role: a.role as "reviewer" | undefined });
		}
		await stateTracker.updatePipeline({ roundtablePhase: "Agents assigned" });

		// 4. Parse tasks into queue (shared helper — also used by StageBehavior)
		const { queue, tasks } = createTaskQueueFromPlan(planContent);
		const taskCount = tasks.length;
		if (taskCount <= 1 && tasks[0]?.id === "execute-plan") {
			logger.warn("[Stage] No tasks parsed from plan. Using default task.");
		}
		await stateTracker.updatePipeline({ roundtablePhase: `Task queue: ${taskCount} tasks ready` });
		activityLogger.logBroadcast(
			"system",
			`Task queue initialized with ${taskCount} tasks. Agent-hour estimate: ${recommendation.estimatedAgentHours}h`,
		);

		// 5. Spawn agents in parallel
		const agentResults = new Map<string, SingleResult[]>();
		const agentPromises = roleAssignments.map(async agent => {
			const results = await this.#runAgent(agent, queue, signal);
			agentResults.set(agent.id, results);
			return { agentId: agent.id, results };
		});

		try {
			await Promise.all(agentPromises);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`Stage execution error: ${msg}`);
		}

		// 6. All tasks complete — transition to curtain
		const progress = queue.progress;
		await stateTracker.updatePipeline({ phase: "curtain", roundtablePhase: "Execution complete" });
		activityLogger.logPhase("curtain", undefined, 1);

		const result: StageResult = {
			status: errors.length > 0 ? "failed" : "completed",
			agentResults,
			errors,
			agents: roleAssignments,
			taskProgress: { total: progress.total, completed: progress.completed },
			degradedMode: [],
		};

		// P7: Notify callbacks that the stage is complete
		this.#opts.callbacks?.onStageComplete(result);

		return result;
	}

	// ────────────────────────────────────────────────────────────────────────
	// Role assignment — delegates to standalone export for reuse by StageBehavior
	// ────────────────────────────────────────────────────────────────────────

	async #assignRoles(agents: ScoredAgent[]): Promise<Array<{ id: string; role: string }>> {
		const { planContent, roleAssetManager, activityLogger, ircBus } = this.#opts;
		return assignAgentRoles(agents, {
			planContent,
			roleAssetManager,
			activityLogger,
			ircBus,
		});
	}

	// ────────────────────────────────────────────────────────────────────────
	// Run a single agent against the task queue
	// ────────────────────────────────────────────────────────────────────────

	async #runAgent(
		agent: { id: string; role: string },
		queue: TaskQueue,
		signal: AbortSignal | undefined,
	): Promise<SingleResult[]> {
		const { activityLogger } = this.#opts;
		const maxRetries = this.#opts.maxRetries ?? 3;
		const retryBaseDelayMs = this.#opts.retryBaseDelayMs ?? 5_000;
		const agentTimeoutMs = this.#opts.agentTimeoutMs ?? 300_000;
		const retryCounts = new Map<string, number>();
		const results: SingleResult[] = [];

		// Keep claiming and executing tasks until the queue is empty or aborted
		let emptyPolls = 0;
		const MAX_EMPTY_POLLS = 3;
		while (!signal?.aborted && !queue.isAllComplete) {
			const claim = queue.claim(agent.id, agent.role);
			if (!claim.ok) {
				// Detect deadlock: nothing ready AND nothing in progress means
				// no new tasks can ever become ready (all remaining are blocked
				// or have unmet dependencies with no agent working on them).
				if (queue.inProgress.size === 0) {
					emptyPolls++;
					if (emptyPolls >= MAX_EMPTY_POLLS) {
						activityLogger.logBroadcast(
							"system",
							`${agent.id}: all tasks blocked or unresolvable (${emptyPolls} empty polls, 0 in-progress), breaking out`,
						);
						break;
					}
				} else {
					emptyPolls = 0;
				}
				// No more ready tasks — wait briefly and retry
				await Bun.sleep(1000);
				continue;
			}
			emptyPolls = 0;

			const task = claim.task!;
			activityLogger.logBroadcast("system", `${agent.id} (${agent.role}) claimed: ${task.title}`);

			try {
				const msgId = `stage-${agent.id}-${task.id}`;
				const taskText = [
					`## Task: ${task.title}`,
					`Role: ${agent.role}`,
					task.files ? `Files: ${task.files.join(", ")}` : "",
					"",
					"Complete this task. When done, report what you accomplished.",
				]
					.filter(Boolean)
					.join("\n");

				let result: SingleResult;

				// Unified path — SwarmRuntime.spawn() is the only execution path.
				// Legacy streamAgentOutput path removed (Phase A4).
				const toolingTools: string[] | undefined =
					this.#opts.agentTooling === "swift"
						? ["quick-task-complete", "task-report"]
						: this.#opts.agentTooling === "main"
							? ["session-save", "session-restore", "streaming-report"]
							: undefined;

				const [handle] = await this.#runtime.spawn([
					{
						id: agent.id,
						role: agent.role,
						roleSource: "library" as const,
						profileId: agent.id,
						task: taskText,
						...(toolingTools ? { tools: toolingTools } : {}),
					},
				]);

				// Race handle.wait() against per-agent timeout
				const waitResult = await Promise.race([
					handle.wait().then(r => ({ type: "result" as const, value: r })),
					Bun.sleep(agentTimeoutMs).then(() => ({ type: "timeout" as const })),
				]);

				if (waitResult.type === "timeout") {
					handle.abort();
					queue.release(task.id, `agent timeout after ${agentTimeoutMs}ms`);
					activityLogger.logBroadcast(
						"system",
						`${agent.id} timed out on "${task.title}" after ${agentTimeoutMs}ms, releasing for retry`,
					);
					continue;
				}

				const agentResult = waitResult.value;
				result = {
					index: results.length,
					id: msgId,
					agent: agent.id,
					agentSource: "project" as const,
					task: taskText,
					exitCode: 0,
					output: agentResult?.output ?? agentResult ?? "(no output)",
					stderr: "",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					requests: 0,
				};

				results.push(result);

				if (result.exitCode === 0) {
					queue.complete(task.id);
					this.#opts.callbacks?.onTaskCompleted(agent.id, task, result);
					// v3: also fire HookPipeline event for Profile + Stigmergy hooks
					this.#opts.hookPipeline
						?.trigger(
							"agent:afterComplete",
							{ agentId: agent.id, taskId: task.id, success: true, result },
							{ phase: "stage" },
						)
						?.catch(err =>
							logger.error("Hook agent:afterComplete failed", { err, agentId: agent.id, taskId: task.id }),
						);
					activityLogger.logBroadcast("system", `${agent.id} completed: ${task.title}`);
				} else {
					// P5: Retry non-zero exit codes with exponential backoff
					const retries = (retryCounts.get(task.id) ?? 0) + 1;
					if (retries < maxRetries) {
						retryCounts.set(task.id, retries);
						const delay = retryBaseDelayMs * 2 ** (retries - 1);
						activityLogger.logBroadcast(
							"system",
							`${agent.id}: task "${task.title}" exit ${result.exitCode} ` +
								`(attempt ${retries}/${maxRetries}), retrying in ${delay}ms`,
						);
						queue.release(task.id, `retry ${retries}/${maxRetries}: exit ${result.exitCode}`);
						await Bun.sleep(delay);
						continue; // retry
					}
					// Circuit breaker: retries exhausted → human-in-the-loop
					const exitReason = `exit code ${result.exitCode} after ${maxRetries} attempts`;
					const circuitResult = await this.#circuitBreak(agent, task, queue, exitReason);
					if (circuitResult === "break") break;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const retries = (retryCounts.get(task.id) ?? 0) + 1;

				if (retries < maxRetries) {
					// P5: Retry with exponential backoff
					retryCounts.set(task.id, retries);
					const delay = retryBaseDelayMs * 2 ** (retries - 1);
					activityLogger.logBroadcast(
						"system",
						`${agent.id}: task "${task.title}" failed (attempt ${retries}/${maxRetries}), ` +
							`retrying in ${delay}ms: ${msg}`,
					);
					queue.release(task.id, `retry ${retries}/${maxRetries}: ${msg}`);
					await Bun.sleep(delay);
					continue; // retry — the released task will be re-claimed
				}
				// Circuit breaker: retries exhausted → human-in-the-loop
				const crashReason = `Failed after ${maxRetries} attempts: ${msg}`;
				const circuitResult = await this.#circuitBreak(agent, task, queue, crashReason);
				if (circuitResult === "break") break;
			}
		}

		return results;
	}

	// ────────────────────────────────────────────────────────────────────────
	// Circuit breaker — human-in-the-loop after retry exhaustion
	// ────────────────────────────────────────────────────────────────────────

	/**
	 * Activate circuit breaker when retries are exhausted for a task.
	 *
	 * Blocks the task and continues — human interaction is handled
	 * by the orchestrator (GraphRunner).
	 *
	 * @returns `"continue"` to keep the agent loop running, `"break"` to exit.
	 */
	async #circuitBreak(
		agent: { id: string; role: string },
		task: Task,
		queue: TaskQueue,
		failureReason: string,
	): Promise<"continue" | "break"> {
		const { activityLogger } = this.#opts;

		logger.error(`Circuit breaker tripped: agent ${agent.id} failed task "${task.title}"`, {
			agentId: agent.id,
			taskId: task.id,
			reason: failureReason,
		});

		// Block the task and continue — human interaction is handled by the orchestrator
		queue.block(task.id, `Agent ${agent.id} failed: ${failureReason}`);
		this.#opts.callbacks?.onTaskFailed(agent.id, task, failureReason);
		this.#opts.hookPipeline
			?.trigger("agent:onError", { agentId: agent.id, error: failureReason }, { phase: "stage" })
			?.catch(err => logger.error("Hook agent:onError failed", { err, agentId: agent.id }));
		activityLogger.logBroadcast("system", `${agent.id} failed: ${task.title} (${failureReason})`);
		return "continue";
	}
}

/**
 * Factory: create a StageController from shared services.
 */
export function createStageController(opts: StageOptions): StageController {
	return new StageController(opts);
}
