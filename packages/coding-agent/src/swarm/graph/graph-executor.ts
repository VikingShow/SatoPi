/**
 * Graph Executor — scheduling strategies for Theatre Graph node execution.
 *
 * Two strategies implement {@link SchedulingStrategy}:
 * - {@link WaveScheduler}: topology-sorted waves, all nodes within a wave
 *   run concurrently via Promise.all, with a barrier between waves.
 * - {@link DynamicScheduler}: semaphore-gated ready queue where nodes become
 *   eligible as soon as all upstream dependencies complete.
 *
 * ADR-1: Execution strategy selection.
 * ADR-6: Wave-level pause gate integration point.
 */


import type { NodeResult } from "./schema";

// ============================================================================
// Scheduling types
// ============================================================================

/**
 * Per-node metadata needed by schedulers.
 */
export interface SchedulerNodeInfo {
	continueOnFailure: boolean;
}

/**
 * Runner interface — the executor calls these hooks per node.
 * Implemented by GraphRunner.
 */
export interface NodeRunner {
	/** Execute a single node. MUST NOT throw; errors go in NodeResult. */
	runNode(nodeId: string): Promise<NodeResult>;
	/** Called after every node completes (success or failure). */
	onNodeComplete(nodeId: string, result: NodeResult): void;
}

// ============================================================================
// SchedulingStrategy
// ============================================================================

/**
 * Schedules nodes for execution.
 *
 * `waves` is the output of {@link buildExecutionWaves} — a topological
 * ordering where each inner array is a group of nodes with no mutual
 * dependencies.  `runner` is the callback interface for node execution.
 */
export interface SchedulingStrategy {
	schedule(waves: string[][], runner: NodeRunner): Promise<void>;
}

// ============================================================================
// WaveScheduler — sequential waves, parallel within each wave
// ============================================================================

/**
 * Runs waves sequentially.  All nodes in a wave are launched concurrently.
 * The scheduler waits for every node in the current wave to settle
 * (complete or fail) before advancing to the next wave.
 *
 * A node whose {@link SchedulerNodeInfo.continueOnFailure} is `true` will
 * NOT block the wave barrier — its failure is logged via
 * {@link NodeRunner.onNodeComplete} but the wave continues.
 */
export class WaveScheduler implements SchedulingStrategy {
	#nodes: Record<string, SchedulerNodeInfo>;

	constructor(nodes?: Record<string, SchedulerNodeInfo>) {
		this.#nodes = nodes ?? {};
	}

	async schedule(waves: string[][], runner: NodeRunner): Promise<void> {
		for (const wave of waves) {
			const results = await Promise.all(
				wave.map((nodeId) => this.#runAndCatch(nodeId, runner)),
			);

			// Check for hard failures that should abort
			for (const result of results) {
				if (!result.success && !(this.#nodes[result.nodeId]?.continueOnFailure ?? false)) {
					throw new Error(
						`Wave aborted: node "${result.nodeId}" failed (continueOnFailure=false)`,
					);
				}
			}
		}
	}

	/** Run a single node, catching errors into a NodeResult. */
	async #runAndCatch(
		nodeId: string,
		runner: NodeRunner,
	): Promise<NodeResult> {
		let result: NodeResult;
		try {
			result = await runner.runNode(nodeId);
		} catch (err: unknown) {
			const message =
				err instanceof Error ? err.message : String(err);
			result = { nodeId, success: false, error: message };
		}
		runner.onNodeComplete(nodeId, result);
		return result;
	}

}

// ============================================================================
// DynamicScheduler — semaphore-gated ready queue
// ============================================================================

/**
 * Semaphore-gated scheduler.  Nodes enter the ready queue as soon as all
 * upstream dependencies have completed (successfully or with
 * continueOnFailure).  At most `maxConcurrency` nodes execute at once.
 */
export class DynamicScheduler implements SchedulingStrategy {
	/** Per-node dependency tracking. */
	#deps: Map<string, Set<string>>;
	/** Reverse index: node → nodes that depend on it. */
	#dependents: Record<string, string[]>;
	/** Per-node metadata. */
	#nodes: Record<string, SchedulerNodeInfo>;
	/** Maximum concurrent executions. */
	#maxConcurrency: number;
	/** Current in-flight count (the semaphore). */
	#inFlight = 0;

	/**
	 * @param deps — dependency graph (nodeId → set of nodeIds it depends on)
	 * @param nodes — per-node metadata keyed by nodeId
	 * @param maxConcurrency — max nodes running simultaneously
	 */
	constructor(
		deps: Map<string, Set<string>>,
		nodes: Record<string, SchedulerNodeInfo>,
		maxConcurrency: number,
	) {
		this.#deps = deps;
		this.#nodes = nodes;
		this.#maxConcurrency = Math.max(1, maxConcurrency);
		this.#dependents = this.#buildDependents(deps);
	}

	async schedule(_waves: string[][], runner: NodeRunner): Promise<void> {
		// Track per-node state
		// "pending" | "running" | "completed" | "failed"
		const status = new Map<string, string>();
		for (const nodeId of this.#deps.keys()) {
			status.set(nodeId, "pending");
		}

		// Counter-based completion: resolved when settledCount === totalCount
		const totalCount = this.#deps.size;
		let settledCount = 0;
		const { promise: done, resolve: resolveAll } = Promise.withResolvers<void>();
		if (totalCount === 0) return;

		// Track the resolve for each node's deferred (not used for the master wait)
		const completions = new Map<string, () => void>();
		// Track promise per node so we can collect errors
		const promises = new Map<string, Promise<void>>();

		// Global abort flag — set when a hard failure occurs
		let aborted = false;
		let abortError: Error | null = null;

		const onSettle = () => {
			settledCount++;
			if (settledCount >= totalCount) {
				resolveAll();
			}
		};

		const onAbort = (err: Error) => {
			if (!aborted) {
				aborted = true;
				abortError = err;
				for (const [id, resolve] of completions) {
					if (status.get(id) === "pending") {
						status.set(id, "failed");
						resolve();
						onSettle();
					}
				}
			}
		};

		// Kick off initial ready nodes
		for (const nodeId of this.#deps.keys()) {
			if (this.#isReady(nodeId, status)) {
				this.#enqueue(
					nodeId,
					runner,
					status,
					completions,
					promises,
					() => aborted,
					onAbort,
					onSettle,
				);
			}
		}

		await done;

		if (aborted && abortError) {
			throw abortError;
		}
	}
	// ------------------------------------------------------------------

	/** Build reverse-dependency index (node → nodes that depend on it). */
	#buildDependents(deps: Map<string, Set<string>>): Record<string, string[]> {
		const dependents: Record<string, string[]> = {};
		for (const [nodeId] of deps) {
			dependents[nodeId] = [];
		}
		for (const [nodeId, nodeDeps] of deps) {
			for (const dep of nodeDeps) {
				(dependents[dep] ??= []).push(nodeId);
			}
		}
		return dependents;
	}

	/** Check whether all upstream deps have completed (or failed with continueOnFailure). */
	#isReady(nodeId: string, status: Map<string, string>): boolean {
		const nodeDeps = this.#deps.get(nodeId);
		if (!nodeDeps || nodeDeps.size === 0) return true;

		for (const dep of nodeDeps) {
			const depStatus = status.get(dep);
			if (depStatus === "pending" || depStatus === "running") {
				return false;
			}
			// "failed" is allowed only if the dep had continueOnFailure
			if (depStatus === "failed" && !(this.#nodes[dep]?.continueOnFailure ?? false)) {
				return false;
			}
		}
		return true;
	}


	/**
	 * Enqueue a node for execution.  When in-flight slots are available the
	 * node starts immediately; otherwise it waits until a slot opens.
	 */
	#enqueue(
		nodeId: string,
		runner: NodeRunner,
		status: Map<string, string>,
		completions: Map<string, () => void>,
		promises: Map<string, Promise<void>>,
		isAborted: () => boolean,
		onAbort: (err: Error) => void,
		onSettle: () => void,
	): void {
		const { promise, resolve } = Promise.withResolvers<void>();
		promises.set(nodeId, promise);
		completions.set(nodeId, resolve);

		this.#tryStart(nodeId, runner, status, completions, promises, isAborted, onAbort, onSettle);
	}

	#tryStart(
		nodeId: string,
		runner: NodeRunner,
		status: Map<string, string>,
		completions: Map<string, () => void>,
		promises: Map<string, Promise<void>>,
		isAborted: () => boolean,
		onAbort: (err: Error) => void,
		onSettle: () => void,
	): void {
		if (isAborted()) {
			completions.get(nodeId)!();
			onSettle();
			return;
		}

		if (this.#inFlight >= this.#maxConcurrency) {
			queueMicrotask(() =>
				this.#tryStart(
					nodeId, runner, status, completions, promises,
					isAborted, onAbort, onSettle,
				),
			);
			return;
		}

		this.#inFlight++;
		status.set(nodeId, "running");

		this.#executeNode(nodeId, runner, status, completions, promises, isAborted, onAbort, onSettle);
	}

	async #executeNode(
		nodeId: string,
		runner: NodeRunner,
		status: Map<string, string>,
		completions: Map<string, () => void>,
		promises: Map<string, Promise<void>>,
		isAborted: () => boolean,
		onAbort: (err: Error) => void,
		onSettle: () => void,
	): Promise<void> {
		let result: NodeResult;
		try {
			result = await runner.runNode(nodeId);
		} catch (err: unknown) {
			const message =
				err instanceof Error ? err.message : String(err);
			result = { nodeId, success: false, error: message };
		}

		runner.onNodeComplete(nodeId, result);

		this.#inFlight--;

		if (result.success) {
			status.set(nodeId, "completed");
		} else {
			status.set(nodeId, "failed");
			if (!(this.#nodes[nodeId]?.continueOnFailure ?? false)) {
				onAbort(new Error(
					`Dynamic schedule aborted: node "${nodeId}" failed (continueOnFailure=false)`,
				));
			}
		}

		// Cascade: check if any dependent nodes are now ready
		const dependents = this.#dependents[nodeId] ?? [];
		for (const depId of dependents) {
			if (status.get(depId) === "pending" && this.#isReady(depId, status)) {
				this.#enqueue(
					depId, runner, status, completions, promises,
					isAborted, onAbort, onSettle,
				);
			}
		}

		// Resolve this node's deferred and signal settlement
		completions.get(nodeId)!();
		onSettle();
	}
}
