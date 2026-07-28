/**
 * StageBehavior — PhaseBehavior implementation for the Stage (execution) phase.
 *
 * Wraps the StageController execution logic into a pluggable behavior that
 * the orchestrator can drive through the standard PhaseBehavior lifecycle.
 *
 * Data flow:
 *   1. enter() → parse plan → spawn worker agents → create swarm channel
 *   2. handleHumanMessage() → broadcast steering directives to all workers
 *   3. handleAgentEvent() → track task completion, detect conflicts
 *   4. checkCompletion() → detect when all agents have finished
 *   5. exit() → clean up agent handles, task queue, and channel
 *
 * This behavior does NOT import StageController — it uses AgentRuntime,
 * CommBus, TaskQueue, and HookPipeline directly.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentHandle } from "../agent-runtime/agent-handle";
import type { CommChannel } from "../comm-bus/comm-channel";
import type { Chapter } from "../core/state";
import { TaskQueue } from "../executor/task-queue";
import type { PhaseBehavior, PhaseCompletion, PhaseContext, PhaseEnterResult } from "./index";

// ============================================================================
// Types
// ============================================================================

/** Per-agent tracking state within the Stage phase. */
interface AgentTracking {
	handle: AgentHandle;
	/** Current task being worked on (if any). */
	currentTask?: string;
	/** Whether this agent has been flagged with an error. */
	hasError: boolean;
}

// ============================================================================
// StageBehavior
// ============================================================================

export class StageBehavior implements PhaseBehavior {
	readonly phase: Chapter = "stage";

	/** All spawned worker agents, keyed by agent ID. */
	#agents = new Map<string, AgentTracking>();

	/** The swarm group communication channel. */
	#channel?: CommChannel;

	/** The task queue (DAG-based coordination). */
	#taskQueue?: TaskQueue;

	/** Whether a human steering pause is active. */
	#paused = false;

	/** Completion tracking: set of agent IDs that have completed. */
	#completedAgents = new Set<string>();

	// ==========================================================================
	// Lifecycle: enter
	// ==========================================================================

	async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
		// 1. Parse plan → task assignments
		const rawTasks = TaskQueue.parseFromPlan(ctx.planContent ?? "");
		this.#taskQueue = new TaskQueue(rawTasks);

		logger.info("[StageBehavior] Parsed tasks from plan", {
			taskCount: rawTasks.length,
			taskIds: rawTasks.map(t => t.id),
		});

		// 2. Determine agent IDs and roles from tasks
		//    Each unique assignedRole gets one agent (with role defaulting to "worker")
		const roleSet = new Set<string>();
		for (const task of rawTasks) {
			roleSet.add(task.assignedRole);
		}

		// If no tasks were parsed, create a single default worker
		const roles = roleSet.size > 0 ? [...roleSet] : ["worker"];

		// Generate agent IDs from roles
		const agentIds = roles.map((_role, i) => `agent-${i + 1}`);

		// 3. Create swarm group channel (Human as observer)
		const channel = ctx.commBus.groupChannel("swarm", ["human", ...agentIds], ctx.activityLogger);
		this.#channel = channel;

		// 4. Optional: role roundtable if configured
		if (ctx.loopConfig?.debate?.enabled) {
			try {
				await channel.roundtable("assign roles for this project", {
					rounds: ctx.loopConfig.debate.maxRounds ?? 2,
					agentIds,
				});
				logger.info("[StageBehavior] Role roundtable complete");
			} catch (err) {
				logger.warn("[StageBehavior] Role roundtable failed (non-fatal)", {
					error: String(err),
				});
			}
		}

		// 5. Spawn all worker agents in parallel
		const specs = roles.map((role, i) => {
			// Find a task assigned to this role as the initial task
			const roleTasks = rawTasks.filter(t => t.assignedRole === role);
			const initialTask =
				roleTasks.length > 0 ? roleTasks.map(t => t.title).join("; ") : "Execute build tasks as assigned";

			return {
				id: agentIds[i],
				role,
				roleSource: "library" as const,
				task: initialTask,
				phase: this.phase,
			};
		});

		const handles = await ctx.runtime.spawn(specs);

		for (let i = 0; i < handles.length; i++) {
			const handle = handles[i];
			this.#agents.set(handle.id, {
				handle,
				hasError: false,
			});

			// Register the agent in the StateTracker
			await ctx.stateTracker.registerAgent(handle.id).catch(() => {
				// Non-fatal: state tracker persistence is best-effort
			});
		}

		logger.info("[StageBehavior] Worker agents spawned", {
			agentCount: handles.length,
			agentIds: handles.map(h => h.id),
		});

		return {
			agents: handles,
			channels: [channel],
			initialUIMessage: `Stage started with ${handles.length} workers on ${rawTasks.length} tasks.`,
		};
	}

	// ==========================================================================
	// Lifecycle: handleHumanMessage
	// ==========================================================================

	async handleHumanMessage(msg: { from: string; body: string }, ctx: PhaseContext): Promise<void> {
		const trimmed = msg.body.trim().toLowerCase();

		// Handle pause/resume steering commands
		if (trimmed === "pause" || trimmed === "/pause") {
			this.#paused = true;
			await ctx.activityLogger.logBroadcast("human", "[Steering] Workflow paused");
			return;
		}

		if (trimmed === "resume" || trimmed === "/resume") {
			this.#paused = false;
			await ctx.activityLogger.logBroadcast("human", "[Steering] Workflow resumed");
			return;
		}

		// Broadcast steering message to all agents via CommBus channel
		if (this.#channel) {
			await this.#channel.send("human", msg.body);
			logger.info("[StageBehavior] Broadcast steering to all workers", {
				bodyLength: msg.body.length,
			});
		}

		// Also deliver via AgentRuntime for agent-level steering queue
		for (const [agentId, tracking] of this.#agents) {
			if (tracking.handle.status === "running") {
				await ctx.runtime.sendHumanMessage(agentId, msg.body).catch(() => {
					// Best-effort: agent may not be accepting messages
				});
			}
		}
	}

	// ==========================================================================
	// Lifecycle: handleAgentEvent
	// ==========================================================================

	async handleAgentEvent(
		event: { agentId: string; status: string; result?: unknown },
		ctx: PhaseContext,
	): Promise<void> {
		const tracking = this.#agents.get(event.agentId);
		if (!tracking) return;

		switch (event.status) {
			case "completed": {
				this.#completedAgents.add(event.agentId);

				// Update StateTracker
				await ctx.stateTracker.updateAgent(event.agentId, { status: "completed" }).catch(() => {});

				// If this agent had a current task, mark it complete
				if (tracking.currentTask && this.#taskQueue) {
					this.#taskQueue.complete(tracking.currentTask);
					logger.info("[StageBehavior] Agent completed task", {
						agentId: event.agentId,
						taskId: tracking.currentTask,
					});
				}

				logger.info("[StageBehavior] Agent completed", {
					agentId: event.agentId,
					remainingActive: this.#agents.size - this.#completedAgents.size,
				});
				break;
			}

			case "failed": {
				tracking.hasError = true;

				await ctx.stateTracker
					.updateAgent(event.agentId, {
						status: "failed",
						error:
							typeof event.result === "string"
								? event.result
								: ((event.result as { error?: string })?.error ?? "unknown error"),
					})
					.catch(() => {});

				// If this agent had a current task, mark it blocked
				if (tracking.currentTask && this.#taskQueue) {
					this.#taskQueue.block(tracking.currentTask, `Agent ${event.agentId} failed`);
				}

				logger.error("[StageBehavior] Agent failed", {
					agentId: event.agentId,
					error: String(event.result ?? "unknown"),
				});

				// Log crash for forensic debugging
				await ctx.activityLogger.logCrash(
					event.agentId,
					typeof event.result === "string" ? event.result : "agent failed",
				);
				break;
			}

			case "running":
				// Agent started processing — update state tracker
				await ctx.stateTracker.updateAgent(event.agentId, { status: "running" }).catch(() => {});
				break;

			default:
				break;
		}
	}

	// ==========================================================================
	// Lifecycle: checkCompletion
	// ==========================================================================

	async checkCompletion(_ctx: PhaseContext): Promise<PhaseCompletion | null> {
		// Don't complete if paused
		if (this.#paused) return null;

		// Check if all agents have finished (completed or failed)
		const allFinished =
			this.#agents.size > 0 &&
			[...this.#agents.values()].every(
				t => t.handle.status === "completed" || t.handle.status === "failed" || t.handle.status === "aborted",
			);

		if (this.#agents.size > 0 && this.#completedAgents.size === this.#agents.size) {
			// All agents have completed — check task queue too
			const tasksDone = !this.#taskQueue || this.#taskQueue.isAllComplete;

			if (tasksDone) {
				// Count failures
				const failures = [...this.#agents.values()].filter(t => t.hasError).length;

				return {
					nextPhase: "curtain",
					message:
						failures > 0
							? `Stage complete with ${failures} agent failure(s). Transitioning to Curtain.`
							: "All agents completed successfully. Transitioning to Curtain.",
				};
			}
		}

		// Alternative: if task queue is fully complete but some agents are still
		// running (idle waiting for tasks), we can consider the stage done.
		if (this.#taskQueue?.isAllComplete && allFinished) {
			return {
				nextPhase: "curtain",
				message: "All tasks complete. Transitioning to Curtain.",
			};
		}

		return null;
	}

	// ==========================================================================
	// Lifecycle: exit
	// ==========================================================================

	async exit(): Promise<void> {
		// Abort any still-running agents
		for (const tracking of this.#agents.values()) {
			if (tracking.handle.status === "running") {
				try {
					tracking.handle.abort("phase exit");
				} catch {
					// Best-effort abort
				}
			}
		}

		this.#agents.clear();
		this.#channel = undefined;
		this.#taskQueue = undefined;
		this.#completedAgents.clear();
		this.#paused = false;

		logger.info("[StageBehavior] Cleaned up");
	}
}
