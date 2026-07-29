/**
 * GraphEngine — pure DAG executor for Theatre Graphs.
 *
 * Owns wave scheduling, checkpoint persistence, upstream-output
 * collection, and result tracking. Delegates per-node execution
 * to a pluggable {@link NodeExecutor}.
 *
 * Zero swarm imports. Designed to be used by GraphRunner (which
 * implements NodeExecutor with swarm services) and testable in
 * isolation.
 */

import { logger } from "@satopi/pi-utils";
import type { CheckpointStore } from "./checkpoint";
import type { NodeRunner, SchedulerNodeInfo } from "./graph-executor";
import { WaveScheduler } from "./graph-executor";
import type { GraphDefinition, NodeExecutionOutput, NodeResult, NodeStatus } from "./types";

// ============================================================================
// NodeExecutor — per-node execution contract
// ============================================================================

/**
 * Context passed to {@link NodeExecutor.execute} for a single node.
 * GraphEngine collects upstream outputs from completed dependencies
 * and provides an abort signal so the executor can respond to cancellation.
 */
export interface NodeExecutionContext {
	/** Outputs from all direct upstream dependencies, keyed by upstream nodeId. */
	upstreamOutputs: Record<string, NodeExecutionOutput>;
	/** Abort signal tied to the graph run's lifecycle. */
	signal: AbortSignal;
}

/**
 * Pluggable per-node execution contract.
 *
 * GraphEngine calls this for every node in each wave. The executor
 * is responsible for the full lifecycle: behavior dispatch, gate
 * evaluation, retry, and cleanup. GraphEngine only handles
 * scheduling, upstream-output plumbing, and checkpoint persistence.
 */
export interface NodeExecutor {
	/**
	 * Execute a single graph node.
	 *
	 * @param nodeId  The node to execute.
	 * @param execCtx Execution context with upstream outputs and abort signal.
	 * @returns A NodeResult indicating success/failure and optional output.
	 */
	execute(nodeId: string, execCtx: NodeExecutionContext): Promise<NodeResult>;
}

// ============================================================================
// Configuration
// ============================================================================

/** Configuration for {@link GraphEngine}. */
export interface GraphEngineConfig {
	/** The parsed graph definition (nodes, edges, hooks). */
	graph: GraphDefinition;
	/** Topologically-sorted execution waves from {@link buildExecutionWaves}. */
	waves: string[][];
	/** Checkpoint persistence backend. */
	checkpointStore: CheckpointStore;
	/** Human-readable graph name for logging and checkpoint recovery. */
	graphName: string;
	/** Optional abort signal for cancelling a running graph. */
	abortSignal?: AbortSignal;
}

// ============================================================================
// Run result
// ============================================================================

/** Aggregate result produced by {@link GraphEngine.run}. */
export interface GraphRunResult {
	/** Number of nodes that completed successfully. */
	completedCount: number;
	/** Total number of nodes in the graph. */
	totalNodes: number;
	/** Error messages collected during execution. */
	executionErrors: string[];
	/** Per-node results keyed by nodeId. */
	nodeResults: Map<string, NodeResult>;
	/** Node metadata for curtain reporting. */
	agentsList: Array<{ id: string; role: string }>;
	/** True if at least one checkpoint write failed (degraded durability). */
	checkpointDegraded: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build upstream-output map from a node's dependency list and
 * the accumulated results of already-executed nodes.
 */
function buildUpstreamOutputs(
	dependsOn: string[] | undefined,
	resultsMap: Map<string, NodeResult>,
): Record<string, NodeExecutionOutput> {
	if (!dependsOn || dependsOn.length === 0) return {};
	const outputs: Record<string, NodeExecutionOutput> = {};
	for (const depId of dependsOn) {
		const result = resultsMap.get(depId);
		if (!result) continue;
		outputs[depId] = {
			nodeId: depId,
			artifacts: [],
			summary: result.output ?? result.error ?? "",
			result: result.output ?? "",
		};
	}
	return outputs;
}

// ============================================================================
// GraphEngine
// ============================================================================

/**
 * Pure DAG executor for Theatre Graphs.
 *
 * ## Lifecycle
 *
 * ```
 * const engine = new GraphEngine({ graph, waves, checkpointStore, graphName });
 * const result = await engine.run(executor);
 * ```
 *
 * Internally:
 * 1. Builds per-node metadata (continueOnFailure) from the graph.
 * 2. Recovers any prior checkpoint for the same graph.
 * 3. Creates a WaveScheduler and runs all waves.
 * 4. For each node: collects upstream outputs, builds a
 *    {@link NodeExecutionContext}, and delegates to
 *    {@link NodeExecutor.execute}.
 * 5. Writes a checkpoint after every node completion.
 * 6. Returns an aggregate {@link GraphRunResult}.
 *
 * Gate evaluation, retry, and behavior dispatch are the executor's
 * responsibility — GraphEngine only provides the scheduling and
 * state-management scaffold.
 */
export class GraphEngine {
	readonly #graph: GraphDefinition;
	readonly #waves: string[][];
	readonly #checkpointStore: CheckpointStore;
	readonly #graphName: string;
	readonly #abortSignal: AbortSignal | undefined;
	#checkpointDegraded = false;

	constructor(config: GraphEngineConfig) {
		this.#graph = config.graph;
		this.#waves = config.waves;
		this.#checkpointStore = config.checkpointStore;
		this.#graphName = config.graphName;
		this.#abortSignal = config.abortSignal;
	}

	/**
	 * Execute all waves, calling `executor.execute()` for every node.
	 *
	 * Checkpoints are written after each node completes so that
	 * interrupted runs can be resumed.
	 */
	async run(executor: NodeExecutor): Promise<GraphRunResult> {
		const signal = this.#abortSignal ?? new AbortController().signal;

		// Build per-node metadata from graph definition.
		const nodeInfos: Record<string, SchedulerNodeInfo> = {};
		for (const [id, node] of Object.entries(this.#graph.nodes)) {
			nodeInfos[id] = { continueOnFailure: node.continue_on_failure ?? false };
		}

		const scheduler = new WaveScheduler(nodeInfos);

		const totalNodes = Object.keys(this.#graph.nodes).length;
		const executionErrors: string[] = [];
		const agentsList: Array<{ id: string; role: string }> = [];
		const nodeResults = new Map<string, NodeResult>();

		// Recover prior checkpoint so we can skip already-completed nodes.
		const priorCheckpoint = await this.#checkpointStore.recover(this.#graphName);
		const completedNodeIds = new Set<string>();
		if (priorCheckpoint) {
			for (const [nid, ns] of Object.entries(priorCheckpoint.nodes)) {
				if (ns.status === "completed") {
					completedNodeIds.add(nid);
				}
			}
			logger.info("[GraphEngine] Resuming from prior checkpoint", {
				graphName: this.#graphName,
				completedNodes: completedNodeIds.size,
				currentWave: priorCheckpoint.currentWave,
			});
		}

		// Write initial checkpoint.
		this.#writeCheckpoint("running", completedNodeIds, 0);

		try {
			await scheduler.schedule(
				this.#waves,
				this.#buildNodeRunner(executor, signal, nodeResults, {
					executionErrors,
					agentsList,
					completedNodeIds,
				}),
			);
		} catch (err) {
			// WaveScheduler throws when a hard failure aborts the wave.
			// Node-level errors are already captured by onNodeComplete;
			// only add the abort when no individual errors were recorded
			// (e.g. a wave abort from a scheduler-level edge case).
			if (executionErrors.length === 0) {
				const message = err instanceof Error ? err.message : String(err);
				executionErrors.push(message);
			}
		}

		return {
			completedCount: nodeResults.size,
			totalNodes,
			executionErrors,
			nodeResults,
			agentsList,
			checkpointDegraded: this.#checkpointDegraded,
		};
	}

	// ------------------------------------------------------------------
	// Internal
	// ------------------------------------------------------------------

	/**
	 * Build the NodeRunner that WaveScheduler calls.
	 *
	 * `runNode` delegates to the executor after plumbing upstream outputs.
	 * `onNodeComplete` updates tracking state and writes a checkpoint.
	 */
	#buildNodeRunner(
		executor: NodeExecutor,
		signal: AbortSignal,
		nodeResults: Map<string, NodeResult>,
		track: {
			executionErrors: string[];
			agentsList: Array<{ id: string; role: string }>;
			completedNodeIds: Set<string>;
		},
	): NodeRunner {
		const graph = this.#graph;

		const runNode = async (nodeId: string): Promise<NodeResult> => {
			// Check for abort before starting work.
			if (signal.aborted) {
				return { nodeId, success: false, error: "Graph run aborted" };
			}

			// Skip already-completed nodes from checkpoint recovery.
			if (track.completedNodeIds.has(nodeId)) {
				return { nodeId, success: true };
			}

			const node = graph.nodes[nodeId];
			if (!node) return { nodeId, success: false, error: `Unknown node: ${nodeId}` };

			// Build upstream outputs from already-executed dependencies.
			const upstreamOutputs = buildUpstreamOutputs(node.depends_on, nodeResults);

			const execCtx: NodeExecutionContext = { upstreamOutputs, signal };

			try {
				const result = await executor.execute(nodeId, execCtx);
				nodeResults.set(nodeId, result);
				track.completedNodeIds.add(nodeId);
				this.#writeCheckpoint("running", track.completedNodeIds, 0);
				return result;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const result: NodeResult = { nodeId, success: false, error: message };
				nodeResults.set(nodeId, result);
				return result;
			}
		};

		const onNodeComplete = (nodeId: string, result: NodeResult): void => {
			const node = graph.nodes[nodeId];
			if (node) {
				track.agentsList.push({ id: nodeId, role: node.role });
			}
			if (result.error) {
				track.executionErrors.push(`${nodeId}: ${result.error}`);
			}
		};

		return { runNode, onNodeComplete };
	}

	/**
	 * Write a full-state checkpoint via the configured store.
	 * Sets the degraded flag if the write fails.
	 */
	#writeCheckpoint(
		status: "running" | "completed" | "failed",
		completedNodeIds: Set<string>,
		currentWave: number,
	): void {
		const nodes: Record<string, { nodeId: string; status: NodeStatus }> = {};
		for (const nodeId of Object.keys(this.#graph.nodes)) {
			nodes[nodeId] = {
				nodeId,
				status: completedNodeIds.has(nodeId) ? "completed" : "pending",
			};
		}

		const ok = this.#checkpointStore.write({
			graphName: this.#graphName,
			runId: `graph-${this.#graphName}-${Date.now()}`,
			startedAt: Date.now(),
			nodes,
			currentWave,
			status,
		});

		if (!ok) {
			this.#checkpointDegraded = true;
		}
	}
}
