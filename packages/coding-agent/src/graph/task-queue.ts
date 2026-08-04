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

// ============================================================================
// TaskQueue
// ============================================================================

export class TaskQueue extends EventEmitter {
	readonly #tasks = new Map<string, Task>();
	readonly #readyQueue: string[] = [];
	readonly #inProgress = new Map<string, string>(); // taskId → agentId
	readonly #completed: string[] = [];
	readonly #blocked: string[] = [];

	/**
	 * Create a TaskQueue from an array of tasks.
	 * Validates the DAG (no cycles, all dependencies exist).
	 */
	constructor(tasks: Omit<Task, "status">[]) {
		super();
		this.load(tasks);
	}

	/**
	 * Replace the queue contents with a new task set (shared-queue adoption).
	 *
	 * Lets a runtime-owned TaskQueue (assembler → SwarmRuntime) adopt the
	 * tasks parsed by StageBehavior instead of building a private queue, so
	 * context sources like TaskQueueSource observe the live queue state.
	 * Reuses the constructor validation (duplicates, unknown deps, cycles).
	 */
	load(tasks: Omit<Task, "status">[]): void {
		this.#tasks.clear();
		this.#readyQueue.length = 0;
		this.#inProgress.clear();
		this.#completed.length = 0;
		this.#blocked.length = 0;

		const ids = new Set<string>();
		for (const task of tasks) {
			if (ids.has(task.id)) {
				throw new Error(`Duplicate task id: ${task.id}`);
			}
			ids.add(task.id);
			this.#tasks.set(task.id, { ...task, status: "pending" });
		}

		// Validate dependencies
		for (const task of tasks) {
			for (const depId of task.dependsOn) {
				if (!this.#tasks.has(depId)) {
					throw new Error(`Task "${task.id}" depends on unknown task "${depId}"`);
				}
			}
		}

		// Validate no cycles
		this.#validateNoCycles();

		// Build initial ready queue
		this.#rebuildReadyQueue();
	}

	/** Claim the next ready task for an agent. */
	claim(agentId: string, _role?: string): TaskClaimResult {
		const taskId = this.#readyQueue.shift();
		if (!taskId) {
			return { ok: false, reason: "No ready tasks" };
		}

		const task = this.#tasks.get(taskId)!;
		task.status = "in_progress";
		task.assignedTo = agentId;
		this.#inProgress.set(taskId, agentId);

		this.emit("task:claimed", { task, agentId });
		return { ok: true, task: { ...task } };
	}

	/** Mark a task as completed and trigger dependents. */
	complete(taskId: string, agentId?: string): Task | null {
		const task = this.#tasks.get(taskId);
		if (!task) return null;

		if (agentId && task.assignedTo !== agentId) {
			throw new Error(`Task "${taskId}" is assigned to ${task.assignedTo}, not ${agentId}`);
		}

		task.status = "completed";
		task.completedAt = Date.now();
		this.#inProgress.delete(taskId);
		this.#completed.push(taskId);

		// Rebuild ready queue (dependents may now be unblocked)
		this.#rebuildReadyQueue();

		this.emit("task:completed", { task: { ...task }, agentId });
		return { ...task };
	}

	/** Block a task (e.g., issues found by reviewer). */
	block(taskId: string, agentId?: string): Task | null {
		const task = this.#tasks.get(taskId);
		if (!task) return null;

		if (agentId && task.assignedTo !== agentId) {
			throw new Error(`Task "${taskId}" is assigned to ${task.assignedTo}, not ${agentId}`);
		}

		task.status = "blocked";
		this.#inProgress.delete(taskId);
		this.#blocked.push(taskId);

		this.#rebuildReadyQueue();
		this.emit("task:blocked", { task: { ...task }, agentId });
		return { ...task };
	}

	/** Unblock a task, making it ready again. */
	unblock(taskId: string): Task | null {
		const task = this.#tasks.get(taskId);
		if (task?.status !== "blocked") return null;

		task.status = "pending";
		const idx = this.#blocked.indexOf(taskId);
		if (idx >= 0) this.#blocked.splice(idx, 1);

		this.#rebuildReadyQueue();
		this.emit("task:unblocked", { task: { ...task } });
		return { ...task };
	}

	/** Whether all tasks are completed. */
	/** Alias for allDone — used by callers expecting the old API name. */
	get isAllComplete(): boolean {
		for (const task of this.#tasks.values()) {
			if (task.status !== "completed") return false;
		}
		return true;
	}

	get allDone(): boolean {
		return this.isAllComplete;
	}

	/** Snapshot for context injection. */
	snapshot(): TaskSnapshot {
		return {
			tasks: [...this.#tasks.values()].map(t => ({ ...t })),
			readyQueue: [...this.#readyQueue],
			inProgress: new Map(this.#inProgress),
			completed: [...this.#completed],
		};
	}

	/** Progress summary { completed, total, inProgress, ready, pending }. */
	get progress(): { completed: number; total: number; inProgress: number; ready: number; pending: number } {
		return {
			completed: this.#completed.length,
			total: this.#tasks.size,
			inProgress: this.#inProgress.size,
			ready: this.#readyQueue.length,
			pending: [...this.#tasks.values()].filter(t => t.status === "pending").length,
		};
	}
	/** Tasks currently in progress (taskId → agentId). */
	get inProgress(): ReadonlyMap<string, string> {
		return this.#inProgress;
	}

	/** Completed task IDs in order of completion. */
	get completed(): readonly string[] {
		return this.#completed;
	}

	/** Number of completed tasks. */
	get completedCount(): number {
		return this.#completed.length;
	}

	/** Total number of tasks. */
	get totalCount(): number {
		return this.#tasks.size;
	}

	/** Get a task by id. */
	get(taskId: string): Task | undefined {
		const t = this.#tasks.get(taskId);
		return t ? { ...t } : undefined;
	}

	/** All tasks as a map (read-only snapshot). */
	get tasks(): ReadonlyMap<string, Readonly<Task>> {
		return this.#tasks;
	}

	/** Currently ready task IDs in priority order. */
	get readyQueue(): readonly string[] {
		return this.#readyQueue;
	}

	/** Release a task from in_progress back to pending/ready. */
	release(taskId: string, _reason?: string): Task | null {
		const task = this.#tasks.get(taskId);
		if (task?.status !== "in_progress") return null;

		task.status = "pending";
		task.assignedTo = undefined;
		this.#inProgress.delete(taskId);
		this.#rebuildReadyQueue();
		this.emit("task:released", { task: { ...task } });
		return { ...task };
	}

	// ------------------------------------------------------------------
	// Private helpers
	// ------------------------------------------------------------------

	#rebuildReadyQueue(): void {
		this.#readyQueue.length = 0;

		for (const task of this.#tasks.values()) {
			if (task.status !== "pending") continue;

			// Check if all dependencies are completed
			const allDepsDone = task.dependsOn.every(depId => {
				const dep = this.#tasks.get(depId);
				return dep?.status === "completed";
			});

			if (allDepsDone) {
				this.#readyQueue.push(task.id);
			}
		}

		// Sort alphabetically for deterministic order
		this.#readyQueue.sort();
	}

	#validateNoCycles(): void {
		// Build dependency graph
		const deps = new Map<string, Set<string>>();
		for (const task of this.#tasks.values()) {
			deps.set(task.id, new Set(task.dependsOn));
		}

		// Kahn's algorithm for cycle detection
		const inDegree = new Map<string, number>();
		const forward = new Map<string, string[]>();

		for (const [node, nodeDeps] of deps) {
			inDegree.set(node, nodeDeps.size);
			for (const dep of nodeDeps) {
				const list = forward.get(dep) ?? [];
				list.push(node);
				forward.set(dep, list);
			}
		}

		const queue: string[] = [];
		for (const [node, degree] of inDegree) {
			if (degree === 0) queue.push(node);
		}

		const sorted: string[] = [];
		while (queue.length > 0) {
			const node = queue.shift()!;
			sorted.push(node);
			for (const dep of forward.get(node) ?? []) {
				const d = inDegree.get(dep)! - 1;
				inDegree.set(dep, d);
				if (d === 0) queue.push(dep);
			}
		}

		if (sorted.length < deps.size) {
			const inCycle = [...deps.keys()].filter(k => !sorted.includes(k));
			throw new Error(`Cycle detected in task dependencies: ${inCycle.join(", ")}`);
		}
	}

	// ------------------------------------------------------------------
	// Static helpers
	// ------------------------------------------------------------------

	/**
	 * Parse tasks from plan.md content.
	 *
	 * Extracts task items from markdown checkboxes and headings,
	 * inferring type, role, and dependencies from metadata.
	 *
	 * Format:
	 *   - [ ] **Task: Name** (type: develop) (role: backend) (est: 30m) (depends: task-1)
	 *   - [ ] Task Name  (type: test) (role: qa)
	 */
	static parseFromPlan(content: string): Omit<Task, "status">[] {
		if (!content || content.trim().length === 0) return [];

		const tasks: Omit<Task, "status">[] = [];
		const ids = new Set<string>();

		// Match checkbox items: - [ ] **Task: Name** (type: X) (role: Y) ...
		const checkboxRe =
			/^[-*]\s+\[[ xX]\]\s+(?:\*\*)?(?:Task:\s*)?(.+?)(?:\*\*)?(?:\s*\((?:type|role|est|depends):[^)]+\))*$/gim;

		for (const match of content.matchAll(checkboxRe)) {
			const fullLine = match[0];
			const title = match[1].trim();

			// Parse metadata parens: (type: develop) (role: backend) (est: 30m) (depends: a, b)
			const type = TaskQueue.#extractMeta(fullLine, "type") ?? "develop";
			const role = TaskQueue.#extractMeta(fullLine, "role") ?? "";
			const estStr = TaskQueue.#extractMeta(fullLine, "est") ?? "30m";
			const dependsStr = TaskQueue.#extractMeta(fullLine, "depends");

			const estimatedMinutes = TaskQueue.#parseEstimate(estStr);
			const dependsOn = dependsStr
				? dependsStr
						.split(",")
						.map(s => s.trim())
						.filter(Boolean)
				: [];

			const id = TaskQueue.#uniqueId(slugify(title), ids);
			ids.add(id);

			tasks.push({
				id,
				title,
				type: type as TaskType,
				dependsOn,
				estimatedMinutes,
				assignedRole: role,
			});
		}

		return tasks;
	}

	static #extractMeta(line: string, key: string): string | undefined {
		const re = new RegExp(`\\(${key}:\\s*([^)]+)\\)`, "i");
		const m = line.match(re);
		return m?.[1]?.trim();
	}

	static #parseEstimate(est: string): number {
		const m = est.match(/(\d+)\s*m/i);
		return m ? parseInt(m[1], 10) : 30;
	}

	static #uniqueId(base: string, seen: Set<string>): string {
		if (!base) base = "task";
		if (!seen.has(base)) return base;
		let i = 2;
		while (seen.has(`${base}-${i}`)) i++;
		return `${base}-${i}`;
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
