/**
 * StageBehavior — PhaseBehavior adapter for the Stage (execution) phase.
 *
 * This is the event-driven PhaseBehavior wrapper used by the theatre
 * graph engine (GraphRunner → PhaseBehaviorNodeAdapter).  It provides
 * an enter → handleAgentEvent → checkCompletion → exit lifecycle.
 *
 * StageBehavior is a **simplified adapter** that:
 *   - Creates one agent per unique task role (no profile selection)
 *   - Parses the plan via {@link TaskQueue.parseFromPlan} and drives the
 *     resulting TaskQueue directly
 *   - Uses the runtime + IrcBus + TaskQueue directly for the
 *     event-driven lifecycle that the graph engine requires
 *
 * Data flow:
 *   1. enter() → parse plan → create channel → spawn worker agents
 *   2. handleHumanMessage() → broadcast steering directives to all workers
 *   3. handleAgentEvent() → track task completion, detect conflicts
 *   4. checkCompletion() → detect when all agents have finished
 *   5. exit() → clean up agent handles, task queue, and channel
 */

import { logger } from "@satopi/pi-utils";
import type { CommChannel } from "../../comm/comm-channel";
import type { AgentSession } from "../../session/agent/agent-session";
import type { Chapter } from "../../swarm/core/state";
import { TaskQueue } from "../task-queue";
import type { PhaseBehavior, PhaseCompletion, PhaseContext, PhaseEnterResult } from "./index";

// ============================================================================
// Types
// ============================================================================

/** Per-agent tracking state within the Stage phase. */
interface AgentTracking {
	handle: AgentSession;
	/** Current task being worked on (if any). */
	currentTask?: string;
	/** Whether this agent has been flagged with an error. */
	hasError: boolean;
}

// ============================================================================
// Summary extraction helpers
// ============================================================================

/** Maximum length for the `agent:afterComplete` summary payload. */
const MAX_SUMMARY_LENGTH = 200;

/** Truncate text to at most {@link MAX_SUMMARY_LENGTH} characters. */
function truncateSummary(text: string): string {
	return text.length > MAX_SUMMARY_LENGTH ? text.slice(0, MAX_SUMMARY_LENGTH) : text;
}

/** Join the text content of a message payload (string or text content blocks). */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/**
 * Extract the last assistant message's text from an agent_end event result.
 *
 * graph-runner passes the full AgentEndEvent (`{ type: "agent_end", messages }`)
 * as `result`; when the last assistant message carries no text (e.g. a
 * tool-call-only turn), earlier assistant messages are scanned.
 */
function extractAssistantSummary(result: unknown): string {
	if (typeof result === "string") return truncateSummary(result);
	if (typeof result !== "object" || result === null) return "";
	if (!("type" in result) || !("messages" in result)) return "";
	if (result.type !== "agent_end") return "";
	const messages = result.messages;
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (typeof message !== "object" || message === null) continue;
		if (!("role" in message) || !("content" in message)) continue;
		if (message.role !== "assistant") continue;
		const text = messageText(message.content);
		if (text.length > 0) return truncateSummary(text);
	}
	return "";
}

/**
 * Extract error text from a failed agent event result: explicit `error` field,
 * then the last assistant message's `errorMessage`, then its text content
 * (e.g. max_turns), falling back to "unknown error".
 */
function extractErrorSummary(result: unknown): string {
	if (typeof result === "string") return truncateSummary(result);
	if (typeof result !== "object" || result === null) return "unknown error";
	if ("error" in result && typeof result.error === "string" && result.error.length > 0) {
		return truncateSummary(result.error);
	}
	if ("messages" in result && Array.isArray(result.messages)) {
		for (let i = result.messages.length - 1; i >= 0; i--) {
			const message = result.messages[i];
			if (typeof message !== "object" || message === null) continue;
			if (!("role" in message) || !("errorMessage" in message)) continue;
			if (message.role !== "assistant") continue;
			if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
				return truncateSummary(message.errorMessage);
			}
		}
		const assistantText = extractAssistantSummary(result);
		if (assistantText.length > 0) return assistantText;
	}
	return "unknown error";
}
// ============================================================================
// Stable profile ID mappings — ensures agent identities survive across swarm runs
// ============================================================================

const ROLE_TO_PROFILE: Record<string, string> = {
	planner: "swarm-planner",
	implementer: "swarm-implementer",
	reviewer: "swarm-reviewer",
	architect: "swarm-architect",
	debugger: "swarm-debugger",
	tester: "swarm-tester",
	reflector: "swarm-reflector",
};

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
		const allTasks = TaskQueue.parseFromPlan(ctx.planContent ?? "");

		// Filter out planner tasks: Script phase (MAIN model) already handled planning.
		// There is no need to spawn a separate planner agent in Stage.
		const execTasks = allTasks.filter(t => t.assignedRole !== "planner");

		// Edge case: if ALL tasks were planner, remap them to implementer to avoid
		// a zero-agent stage.
		const tasks =
			execTasks.length > 0 ? execTasks : allTasks.map(t => ({ ...t, assignedRole: "implementer" as const }));

		// Adopt the runtime-owned shared queue when present (assembler wiring)
		// so TaskQueueSource context and CrossCheckBehavior observe the live
		// queue state; otherwise build a private queue as before.
		this.#taskQueue = ctx.runtime.taskQueue ?? new TaskQueue(tasks);
		if (ctx.runtime.taskQueue) {
			ctx.runtime.taskQueue.load(tasks);
		}

		logger.info("[StageBehavior] Parsed tasks from plan", {
			taskCount: allTasks.length,
			plannerTasksSkipped: allTasks.length - execTasks.length,
			execTaskCount: tasks.length,
			taskIds: tasks.map(t => t.id),
		});

		// 2. Determine agent IDs and roles from tasks
		//    Each unique assignedRole gets one agent (with role defaulting to "worker").
		//    Planner tasks have already been filtered out above.
		const roleSet = new Set<string>();
		for (const task of tasks) {
			roleSet.add(task.assignedRole);
		}

		// If no tasks were parsed, create a single default worker
		const roles = roleSet.size > 0 ? [...roleSet] : ["worker"];

		// Generate stable profile-based agent IDs instead of temporary agent-N IDs
		const agentIds = roles.map(role => ROLE_TO_PROFILE[role] ?? `worker-${role}`);

		// 3. Create swarm group channel (Human as observer)
		const channel = ctx.ircBus.groupChannel("swarm", ["human", ...agentIds], ctx.activityLogger);
		this.#channel = channel;

		// 4. Optional: role roundtable if configured
		if (ctx.loopConfig?.debate?.enabled) {
			try {
				await channel.roundtable("assign roles for this project", {
					rounds: ctx.loopConfig.debate.maxRounds ?? 2,
					agentIds,
					phase: this.phase,
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
			const roleTasks = tasks.filter(t => t.assignedRole === role);
			const initialTask =
				roleTasks.length > 0 ? roleTasks.map(t => t.title).join("; ") : "Execute build tasks as assigned";

			return {
				id: agentIds[i],
				role,
				profileId: ROLE_TO_PROFILE[role] ?? `worker-${role}`,
				roleSource: "profile" as const,
				task: initialTask,
				todoPhases: roleTasks.map(t => ({ title: t.title, files: t.files, dependsOn: t.dependsOn })),
				phase: this.phase,
			};
		});

		const sessions = await ctx.runtime.spawn(specs);

		for (let i = 0; i < sessions.length; i++) {
			const session = sessions[i];
			this.#agents.set(session.id, {
				handle: session,
				hasError: false,
			});

			// Register the agent in the StateTracker
			await ctx.stateTracker
				.registerAgent(session.id)
				.catch(err => logger.error("StateTracker registerAgent failed", { error: String(err) }));
		}

		logger.info("[StageBehavior] Worker agents spawned", {
			agentCount: sessions.length,
			agentIds: sessions.map(s => s.id),
		});

		return {
			agents: sessions,
			channels: [channel],
			initialUIMessage: `Stage started with ${sessions.length} workers on ${tasks.length} tasks.`,
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

		// Broadcast steering message to all agents via IrcBus channel
		if (this.#channel) {
			await this.#channel.send("human", msg.body);
			logger.info("[StageBehavior] Broadcast steering to all workers", {
				bodyLength: msg.body.length,
			});
		}

		// Also deliver via the runtime for agent-level steering queue
		for (const [agentId, tracking] of this.#agents) {
			if (tracking.handle.status === "running") {
				await ctx.runtime
					.sendHumanMessage(agentId, msg.body)
					.catch(err => logger.error("sendHumanMessage failed", { agentId, error: String(err) }));
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
				await ctx.stateTracker
					.updateAgent(event.agentId, { status: "completed" })
					.catch(err => logger.error("StateTracker updateAgent failed (completed)", { error: String(err) }));

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
				// Trigger lifecycle hook for profile credit updates
				await ctx.hookPipeline?.trigger(
					"agent:afterComplete",
					{
						agentId: event.agentId,
						success: true,
						summary: extractAssistantSummary(event.result),
					},
					{ phase: "stage", agentId: event.agentId },
				);
				break;
			}

			case "failed": {
				tracking.hasError = true;

				await ctx.stateTracker
					.updateAgent(event.agentId, {
						status: "failed",
						error: extractErrorSummary(event.result),
					})
					.catch(err => logger.error("StateTracker updateAgent failed (failed)", { error: String(err) }));

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
				// Trigger lifecycle hook for profile credit updates
				await ctx.hookPipeline?.trigger(
					"agent:afterComplete",
					{
						agentId: event.agentId,
						success: false,
						summary: extractErrorSummary(event.result),
					},
					{ phase: "stage", agentId: event.agentId },
				);
				break;
			}

			case "running":
				// Agent started processing — update state tracker
				await ctx.stateTracker
					.updateAgent(event.agentId, { status: "running" })
					.catch(err => logger.error("StateTracker updateAgent failed (running)", { error: String(err) }));
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
			const tasksDone = !this.#taskQueue || this.#taskQueue.allDone;

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
		if (this.#taskQueue?.allDone && allFinished) {
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
					tracking.handle.abort({ reason: "phase exit" });
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
