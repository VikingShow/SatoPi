/**
 * TaskQueueSource — Injects current task queue state for the Stage phase.
 *
 * Priority: 7.
 * Applies to: "stage" phase only.
 *
 * Formats the TaskQueue state (progress, ready tasks, in-progress tasks,
 * blocked tasks) as system prompt context so the agent has situational
 * awareness of what others are working on and what tasks are available.
 */

import type { TaskQueue } from "../../graph/task-queue";
import type { Chapter } from "../../swarm/core/state";
import type { AgentSpecLike, BuildContext, ContextFragment, ContextSource } from "../context-pipeline";

export class TaskQueueSource implements ContextSource {
	readonly name = "task-queue";
	readonly priority = 7;

	readonly #taskQueue: TaskQueue;

	constructor(taskQueue: TaskQueue) {
		this.#taskQueue = taskQueue;
	}

	appliesTo(phase: Chapter, _agentRole: string): boolean {
		return phase === "stage";
	}

	async build(_spec: AgentSpecLike, _base: BuildContext): Promise<ContextFragment> {
		const progress = this.#taskQueue.progress;

		if (progress.total === 0) {
			return {};
		}

		// Build a summary of the task queue state
		const lines: string[] = [
			"<task_queue_status>",
			`  Progress: ${progress.completed}/${progress.total} completed, ${progress.inProgress} in progress, ${progress.ready} ready, ${progress.pending} pending`,
		];

		// List ready tasks
		const readyTasks = this.#taskQueue.readyQueue;
		if (readyTasks.length > 0) {
			lines.push("  Ready tasks:");
			for (const taskId of readyTasks.slice(0, 10)) {
				const task = this.#taskQueue.tasks.get(taskId);
				if (task) {
					lines.push(
						`    - ${task.id}: ${task.title} (role: ${task.assignedRole}, est: ${task.estimatedMinutes}m)`,
					);
				}
			}
			if (readyTasks.length > 10) {
				lines.push(`    ... and ${readyTasks.length - 10} more`);
			}
		}

		// List in-progress tasks
		const inProgress = this.#taskQueue.inProgress;
		if (inProgress.size > 0) {
			lines.push("  In progress:");
			for (const [taskId, agentId] of inProgress) {
				const task = this.#taskQueue.tasks.get(taskId);
				if (task) {
					lines.push(`    - ${task.id}: ${task.title} (assigned to: ${agentId})`);
				}
			}
		}

		// List completed tasks
		const completed = this.#taskQueue.completed;
		if (completed.length > 0) {
			lines.push(
				`  Completed: ${completed.slice(0, 10).join(", ")}${completed.length > 10 ? ` ... and ${completed.length - 10} more` : ""}`,
			);
		}

		lines.push("</task_queue_status>");

		return {
			systemPromptAddition: lines.join("\n"),
		};
	}
}
