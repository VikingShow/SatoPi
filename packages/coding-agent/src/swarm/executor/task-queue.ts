/**
 * TaskQueue — DAG-based task coordination for the Stage phase.
 *
 * Agents work concurrently on a shared task queue rather than
 * iterating through fixed rounds. Tasks have dependencies (dependsOn),
 * and the ready queue contains tasks whose predecessors are all completed.
 *
 * Inspired by busytown's cursor-based delivery and lopi's priority queues.
 *
 * Lifecycle:
 *   pending → ready (all deps satisfied) → in_progress (claimed) → completed
 *                                                              → blocked (issues found)
 */

import { EventEmitter } from "node:events";

// ============================================================================
// Types
// ============================================================================

export type TaskType = "develop" | "test" | "review" | "docs" | "config" | "fix";
export type TaskStatus = "pending" | "ready" | "in_progress" | "completed" | "blocked";

export interface Task {
	id: string;
	title: string;
	type: TaskType;
	/** Files this task is expected to touch. */
	files?: string[];
	/** Task IDs that must complete before this one can start. */
	dependsOn: string[];
	/** Estimated minutes to complete (for scheduling). */
	estimatedMinutes: number;
	/** Which role should handle this task. */
	assignedRole: string;
	status: TaskStatus;
	/** Agent currently working on this task (if in_progress). */
	assignedTo?: string;
	/** When the task was completed. */
	completedAt?: number;
}

export interface TaskClaimResult {
	ok: boolean;
	task?: Task;
	reason?: string;
}

export interface TaskSnapshot {
	tasks: Task[];
	readyQueue: string[];
	inProgress: Map<string, string>;
	completed: string[];
}

export declare interface TaskQueue {
	on(event: "task:ready", listener: (taskId: string) => void): this;
	on(event: "task:completed", listener: (taskId: string, agentId: string) => void): this;
	on(event: "task:blocked", listener: (taskId: string, reason: string) => void): this;
	on(event: "all-complete", listener: () => void): this;
}

// ============================================================================
// TaskQueue
// ============================================================================

export class TaskQueue extends EventEmitter {
	readonly #tasks = new Map<string, Task>();
	readonly #readyQueue: string[] = [];
	readonly #inProgress = new Map<string, string>(); // taskId → agentId
	readonly #completed = new Set<string>();

	// ── Construction ──────────────────────────────────────────────────────

	/**
	 * Create a TaskQueue from an array of tasks.
	 * Validates the DAG (no cycles, all dependencies exist).
	 */
	constructor(tasks: Omit<Task, "status">[]) {
		super();
		for (const t of tasks) {
			const task: Task = { ...t, status: "pending" };
			this.#tasks.set(task.id, task);
		}
		this.#validate();
		this.#computeReady();
	}

	// ── Query ────────────────────────────────────────────────────────────

	get tasks(): ReadonlyMap<string, Task> {
		return this.#tasks;
	}

	get readyQueue(): readonly string[] {
		return this.#readyQueue;
	}

	get completed(): readonly string[] {
		return [...this.#completed];
	}

	get inProgress(): ReadonlyMap<string, string> {
		return this.#inProgress;
	}

	get pendingCount(): number {
		return [...this.#tasks.values()].filter(t => t.status === "pending").length;
	}

	get isAllComplete(): boolean {
		return this.#completed.size === this.#tasks.size;
	}

	get progress(): { total: number; completed: number; inProgress: number; pending: number; ready: number } {
		return {
			total: this.#tasks.size,
			completed: this.#completed.size,
			inProgress: this.#inProgress.size,
			pending: this.pendingCount,
			ready: this.#readyQueue.length,
		};
	}

	snapshot(): TaskSnapshot {
		return {
			tasks: [...this.#tasks.values()],
			readyQueue: [...this.#readyQueue],
			inProgress: new Map(this.#inProgress),
			completed: [...this.#completed],
		};
	}

	// ── Operations ───────────────────────────────────────────────────────

	/**
	 * Claim a task from the ready queue. Atomic — first agent to claim wins.
	 * Returns the task if claimed, or a reason if nothing is available.
	 */
	claim(agentId: string, preferredRole?: string): TaskClaimResult {
		if (this.#readyQueue.length === 0) {
			return { ok: false, reason: "No ready tasks available" };
		}

		// Try to find a task matching the preferred role
		let taskId: string | undefined;
		if (preferredRole) {
			const idx = this.#readyQueue.findIndex(id => this.#tasks.get(id)?.assignedRole === preferredRole);
			if (idx >= 0) {
				taskId = this.#readyQueue.splice(idx, 1)[0];
			}
		}

		// Fallback: take the first ready task
		if (!taskId) {
			taskId = this.#readyQueue.shift()!;
		}

		const task = this.#tasks.get(taskId)!;
		task.status = "in_progress";
		task.assignedTo = agentId;
		this.#inProgress.set(taskId, agentId);

		return { ok: true, task: { ...task } };
	}

	/**
	 * Mark a task as completed. Triggers dependent tasks to be re-evaluated.
	 * Emits "task:completed" and potentially "all-complete".
	 */
	complete(taskId: string): boolean {
		const task = this.#tasks.get(taskId);
		if (!task) return false;
		if (task.status !== "in_progress") return false;

		task.status = "completed";
		task.completedAt = Date.now();
		this.#inProgress.delete(taskId);
		this.#completed.add(taskId);

		// Re-evaluate: any tasks now have all deps satisfied?
		this.#computeReady();

		this.emit("task:completed", taskId, task.assignedTo ?? "unknown");

		if (this.isAllComplete) {
			this.emit("all-complete");
		}

		return true;
	}

	/**
	 * Mark a task as blocked (e.g. reviewer found issues).
	 * Creates a follow-up fix task if fixTask is provided.
	 */
	block(taskId: string, reason: string, fixTask?: Omit<Task, "status">): boolean {
		const task = this.#tasks.get(taskId);
		if (!task) return false;

		task.status = "blocked";
		this.#inProgress.delete(taskId);

		if (fixTask) {
			this.#tasks.set(fixTask.id, { ...fixTask, status: "pending" });
			// The fix task depends on nothing (or the blocked task) → re-evaluate
			this.#computeReady();
		}

		this.emit("task:blocked", taskId, reason);
		return true;
	}

	/**
	 * Add a new task to the queue dynamically (e.g. reviewer-created fix tasks).
	 */
	addTask(task: Omit<Task, "status">): void {
		if (this.#tasks.has(task.id)) return;
		this.#tasks.set(task.id, { ...task, status: "pending" });
		this.#computeReady();
		if (this.#readyQueue.includes(task.id)) {
			this.emit("task:ready", task.id);
		}
	}

	// ── Task parsing (from plan.md todo-tasks) ──────────────────────────

	/**
	 * Parse tasks from plan.md style todo list.
	 * Expects format like:
	 *   ## Tasks
	 *   - [ ] implement-auth (develop, files: src/auth/*.ts, depends: setup-db)
	 *   - [ ] test-auth (test, depends: implement-auth)
	 *
	 * Falls back to simple line-by-line parsing without dependencies.
	 */
	static parseFromPlan(planContent: string): Omit<Task, "status">[] {
		const tasks: Omit<Task, "status">[] = [];
		const lines = planContent.split("\n");

		// Find the tasks section
		let inTasks = false;
		for (const line of lines) {
			const trimmed = line.trim();

			// Detect task section headers
			if (/^#{1,3}\s*(tasks?|todo|deliverables|implementation|work items?)/i.test(trimmed)) {
				inTasks = true;
				continue;
			}
			if (inTasks && /^#{1,3}\s/.test(trimmed) && !/^#{1,3}\s*(tasks?|todo|deliverables)/i.test(trimmed)) {
				inTasks = false;
				continue;
			}
			if (!inTasks) continue;

			// Match: - [ ] task-name (type, ...options)
			const match = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)/);
			if (!match) continue;

			const title = match[2].trim();
			const id = slugify(title);

			// Extract metadata from parentheses
			let type: TaskType = "develop";
			let files: string[] | undefined;
			let dependsOn: string[] = [];
			let estimatedMinutes = 30;
			let assignedRole = "developer";

			const metaMatch = title.match(/\(([^)]+)\)$/);
			if (metaMatch) {
				const meta = metaMatch[1];
				for (const part of meta.split(/,\s*/)) {
					const [key, ...rest] = part.split(/:\s*/);
					const value = rest.join(":").trim();
					switch (key.toLowerCase()) {
						case "type":
							type = value as TaskType;
							if (type === "test") assignedRole = "tester";
							else if (type === "review") assignedRole = "reviewer";
							else if (type === "docs") assignedRole = "developer";
							break;
						case "files":
							files = value.split(/\s+/).filter(Boolean);
							break;
						case "depends":
							dependsOn = value.split(/\s+/).filter(Boolean).map(slugify);
							break;
						case "est":
							estimatedMinutes = parseInt(value, 10) || 30;
							break;
						case "role":
							assignedRole = value;
							break;
					}
				}
			}

			tasks.push({
				id,
				title: title.replace(/\s*\([^)]*\)$/, "").trim(),
				type,
				files,
				dependsOn,
				estimatedMinutes,
				assignedRole,
			});
		}

		return tasks;
	}

	// ── Internal ─────────────────────────────────────────────────────────

	/** Validate the task DAG: no cycles, all deps exist. */
	#validate(): void {
		for (const [id, task] of this.#tasks) {
			for (const dep of task.dependsOn) {
				if (!this.#tasks.has(dep)) {
					throw new Error(`Task "${id}" depends on unknown task "${dep}"`);
				}
				if (dep === id) {
					throw new Error(`Task "${id}" cannot depend on itself`);
				}
			}
		}
		// Cycle detection: topological sort must succeed
		const visited = new Set<string>();
		const visiting = new Set<string>();
		const dfs = (id: string): void => {
			if (visiting.has(id)) throw new Error(`Cycle detected involving task "${id}"`);
			if (visited.has(id)) return;
			visiting.add(id);
			const task = this.#tasks.get(id);
			if (task) {
				for (const dep of task.dependsOn) dfs(dep);
			}
			visiting.delete(id);
			visited.add(id);
		};
		for (const id of this.#tasks.keys()) dfs(id);
	}

	/** Recompute the ready queue: tasks whose deps are all complete and not yet claimed. */
	#computeReady(): void {
		// Clear existing ready queue entries
		this.#readyQueue.length = 0;

		for (const [id, task] of this.#tasks) {
			if (task.status !== "pending") continue;
			const depsSatisfied = task.dependsOn.every(depId => {
				const dep = this.#tasks.get(depId);
				return dep?.status === "completed";
			});
			if (depsSatisfied) {
				task.status = "ready";
				this.#readyQueue.push(id);
			}
		}

		// Stable ordering: sort by estimated minutes (shortest first)
		this.#readyQueue.sort((a, b) => {
			const ta = this.#tasks.get(a);
			const tb = this.#tasks.get(b);
			return (ta?.estimatedMinutes ?? 30) - (tb?.estimatedMinutes ?? 30);
		});
	}
}

// ============================================================================
// Helpers
// ============================================================================

function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}
