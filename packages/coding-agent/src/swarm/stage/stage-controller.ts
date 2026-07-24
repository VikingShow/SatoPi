/**
 * StageController — orchestrates the Stage (execution) phase.
 *
 * Replaces the iteration-based LoopController with an event-driven,
 * task-queue-based execution model. Agents work concurrently on a
 * shared DAG-structured task queue rather than fixed rounds.
 *
 * Flow:
 *   1. Select agents (scored by domain match + credit)
 *   2. Roundtable for role assignment (agents discuss, system resolves)
 *   3. Parse plan.md → TaskQueue (DAG with dependencies)
 *   4. Spawn all agents in parallel, each with assigned role
 *   5. Event-driven: claim → work → complete → trigger dependents
 *   6. All tasks done → spawn reporter agent → user applauds → Curtain
 */

import * as fs from "node:fs/promises";
import type { ModelRegistry, Settings, AgentDefinition } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import type { ActivityLogger } from "../hooks/activity-logger";
import type { AgentExecutor } from "../executor/executor";
import { SubprocessAgentExecutor } from "../executor/executor";
import { streamAgentOutput } from "../render/streaming";
import { RegionLockManager } from "../coordination/region-lock";
import { TaskQueue, type Task } from "../executor/task-queue";
import { type ScoredAgent, selectAgents, extractDomains } from "../agent/agent-selector";
import type { ProfileRegistry } from "../agent/agent-profile";
import type { RoleAssetManager, RoleAsset } from "../agent/role-asset";
import type { StateTracker } from "../core/state";
import type { AgentToolRestriction, LoopSwarmConfig } from "../core/schema";
import { TaskComplexityAnalyzer } from "../script/task-analyzer";
import type { ReviewVerdict } from "../core/pipeline";

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
	ircBus?: IrcBus;
	executor?: AgentExecutor;
	/** Pre-selected agent IDs (skip selection algorithm). */
	agentIds?: string[];
	/** User-specified agent count (overrides complexity analyzer). */
	agentCount?: number;
	/** User-specified reviewer count. */
	reviewerCount?: number;
	/** P7: Stage lifecycle callbacks (credit updates, stigmergy marks). */
	callbacks?: StageCallbacks;
}

export interface StageResult {
	status: "completed" | "failed" | "aborted";
	agentResults: Map<string, SingleResult[]>;
	errors: string[];
	/** Selected agents with their assigned roles. */
	agents: Array<{ id: string; role: string }>;
	/** Task queue progress snapshot. */
	taskProgress: { total: number; completed: number };
}

// ============================================================================
// StageController
// ============================================================================

export class StageController {
	readonly #opts: StageOptions;
	#executor: AgentExecutor;
	#lockMgr = new RegionLockManager();

	constructor(opts: StageOptions) {
		this.#opts = opts;
		this.#executor = opts.executor ?? new SubprocessAgentExecutor();
	}

	/**
	 * Run the full Stage phase: select agents → assign roles → execute tasks → report.
	 */
	async run(): Promise<StageResult> {
		const { workspace, planContent, loopConfig, stateTracker, activityLogger, signal } = this.#opts;
		const errors: string[] = [];

		// ── Phase: stage ──
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
			activityLogger.logBroadcast("system", `Auto-created ${missing} new agent(s) to reach required count of ${required}`);
		}

		if (selectedAgents.length === 0) {
			return { status: "failed", agentResults: new Map(), errors: ["No agents available"], agents: [], taskProgress: { total: 0, completed: 0 } };
		}

		// Save profiles immediately so they persist across restarts
		await registry.save(this.#opts.workspace).catch(() => {});

		// P7: Notify callbacks that agents have been selected
		this.#opts.callbacks?.onAgentsSelected(selectedAgents);

		activityLogger.logBroadcast("system", `Selected ${selectedAgents.length} agents: ${selectedAgents.map(a => a.name).join(", ")}`);

		// 3. Role assignment (roundtable or direct)
		const roleAssignments = await this.#assignRoles(selectedAgents);
		for (const a of roleAssignments) {
			await stateTracker.registerAgent(a.id);
			await stateTracker.updateAgent(a.id, { status: "running", role: a.role as "reviewer" | undefined });
		}
		await stateTracker.updatePipeline({ roundtablePhase: "Agents assigned" });

		// 4. Parse tasks into queue
		const tasks = TaskQueue.parseFromPlan(planContent);
		if (tasks.length === 0) {
			logger.warn("[Stage] No tasks parsed from plan. Creating a single default task.");
			tasks.push({
				id: "execute-plan",
				title: "Execute the plan as described",
				type: "develop",
				dependsOn: [],
				estimatedMinutes: 60,
				assignedRole: "developer",
			});
		}
		const queue = new TaskQueue(tasks);
		await stateTracker.updatePipeline({ roundtablePhase: `Task queue: ${tasks.length} tasks ready` });
		activityLogger.logBroadcast("system", `Task queue initialized with ${tasks.length} tasks. Agent-hour estimate: ${recommendation.estimatedAgentHours}h`);

		// 5. Spawn agents in parallel
		const agentResults = new Map<string, SingleResult[]>();
		const agentPromises = roleAssignments.map(async (agent) => {
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
		};

		// P7: Notify callbacks that the stage is complete
		this.#opts.callbacks?.onStageComplete(result);

		return result;
	}

	// ────────────────────────────────────────────────────────────────────────
	// Role assignment
	// ────────────────────────────────────────────────────────────────────────

	async #assignRoles(agents: ScoredAgent[]): Promise<Array<{ id: string; role: string }>> {
		const { planContent, roleAssetManager, activityLogger } = this.#opts;
		const assignments: Array<{ id: string; role: string }> = [];

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

		// 4. First pass: agents with strong role preference
		for (const agent of agents) {
			const preferred = agent.preferredRoles.find(r => availableRoles.includes(r));
			if (preferred) {
				assignments.push({ id: agent.profileId, role: preferred });
			}
		}

		// 5. Second pass: remaining agents get remaining roles round-robin
		const remaining = agents.filter(a => !assignments.find(ra => ra.id === a.profileId));
		const remainingRoles = availableRoles.filter(r => !assignments.find(a => a.role === r));
		for (let i = 0; i < remaining.length; i++) {
			const role = remainingRoles[i % remainingRoles.length] ?? availableRoles[0] ?? "developer";
			assignments.push({ id: remaining[i].profileId, role });
		}

		activityLogger.logBroadcast(
			"system",
			`Role assignments: ${assignments.map(a => `${a.id}=${a.role}`).join(", ")}`,
		);

		return assignments;
	}

	// ────────────────────────────────────────────────────────────────────────
	// Run a single agent against the task queue
	// ────────────────────────────────────────────────────────────────────────

	async #runAgent(
		agent: { id: string; role: string },
		queue: TaskQueue,
		signal: AbortSignal | undefined,
	): Promise<SingleResult[]> {
		const { workspace, swarmName, activityLogger, modelRegistry, settings, profileRegistry, roleAssetManager } = this.#opts;
		const results: SingleResult[] = [];
		let roleDef: RoleAsset | null = null;

		// Load role definition
		try {
			roleDef = await roleAssetManager.get(agent.role);
		} catch { /* use defaults */ }

		// Build system prompt with profile context + P7 stigmergy context
		const profileCtx = profileRegistry.getPromptContext(agent.id);
		const stigmergyCtx = this.#opts.callbacks?.getAgentContext(agent.id) ?? "";
		const systemPrompt = [
			roleDef?.prompts?.system ??
				`You are a ${agent.role} in the SatoPi system. Complete tasks assigned to you from the task queue.`,
			profileCtx ?? "",
			stigmergyCtx,
			"",
			"TASK QUEUE INSTRUCTIONS:",
			"- You have a shared task queue. Use the queue to claim the next available task.",
			"- When you complete a task, mark it as done. Dependent tasks will become ready.",
			"- If you encounter an issue, create a fix task and notify the reviewer.",
			"- Work efficiently — your completion speed affects the team's throughput.",
		].filter(Boolean).join("\n");

		// Keep claiming and executing tasks until the queue is empty or aborted
		while (!signal?.aborted && !queue.isAllComplete) {
			const claim = queue.claim(agent.id, agent.role);
			if (!claim.ok) {
				// No more ready tasks — wait briefly and retry
				await new Promise(r => setTimeout(r, 1000));
				continue;
			}

			const task = claim.task!;
			activityLogger.logBroadcast("system", `${agent.id} (${agent.role}) claimed: ${task.title}`);

			try {
				const msgId = `stage-${agent.id}-${task.id}`;
				const result = await streamAgentOutput(
					{ activityLogger, msgId, from: agent.id },
					{
						cwd: workspace,
						agent: {
							name: agent.id,
							description: `Stage agent: ${agent.id} (${agent.role})`,
							systemPrompt,
							source: "project" as const,
							...(roleDef?.tools ? { tools: roleDef.tools } : {}),
						},
						task: [
							`## Task: ${task.title}`,
							`Role: ${agent.role}`,
							task.files ? `Files: ${task.files.join(", ")}` : "",
							"",
							"Complete this task. When done, report what you accomplished.",
						].filter(Boolean).join("\n"),
						index: results.length,
						id: msgId,
						modelRegistry,
						settings,
						signal,
					},
				);

				results.push(result);

				if (result.exitCode === 0) {
					queue.complete(task.id);
					this.#opts.callbacks?.onTaskCompleted(agent.id, task, result);
					activityLogger.logBroadcast("system", `${agent.id} completed: ${task.title}`);
				} else {
					queue.block(task.id, `Agent ${agent.id} failed with exit ${result.exitCode}`);
					this.#opts.callbacks?.onTaskFailed(agent.id, task, `exit code ${result.exitCode}`);
					activityLogger.logBroadcast("system", `${agent.id} failed: ${task.title} (exit ${result.exitCode})`);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				queue.block(task.id, msg);
				this.#opts.callbacks?.onTaskFailed(agent.id, task, msg);
				activityLogger.logCrash(agent.id, msg);
			}
		}

		return results;
	}
}

/**
 * Factory: create a StageController from shared services.
 */
export function createStageController(opts: StageOptions): StageController {
	return new StageController(opts);
}
