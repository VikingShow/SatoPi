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
import { evaluateCondition } from "./condition";
import type { NodeRunner, SchedulerNodeInfo } from "./graph-executor";
import { DynamicScheduler, WaveScheduler } from "./graph-executor";
import type { GraphDefinition, GraphEdge, NodeExecutionOutput, NodeResult, NodeRunState, RouteDecision } from "./types";

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

/** Simple glob matcher: supports trailing wildcard (e.g. "*.ts") and exact match. */
function matchGlob(pattern: string, candidate: string): boolean {
	// Exact match
	if (!pattern.includes("*")) return pattern === candidate;
	// Suffix match: "*.ext" → candidate ends with ".ext"
	if (pattern.startsWith("*.") && !pattern.slice(2).includes("*")) {
		return candidate.endsWith(pattern.slice(1));
	}
	// Prefix match: "prefix*"
	if (pattern.endsWith("*") && !pattern.slice(0, -1).includes("*")) {
		return candidate.startsWith(pattern.slice(0, -1));
	}
	// Fallback: exact match
	return pattern === candidate;
}

/**
 * Build upstream-output map from a node's dependency list and
 * the accumulated results of already-executed nodes.
 *
 * Artifact filtering: for each (from → to) edge with `artifacts` defined,
 * only artifact paths matching at least one glob pattern are passed through.
 * When no edge exists or the edge has no artifact filter, all artifacts pass.
 * When an upstream node produced `output` text but no explicit `artifacts`,
 * a synthetic `"output.txt"` artifact is injected so downstream nodes can
 * always reference upstream text output.
 */
function buildUpstreamOutputs(
	dependsOn: string[] | undefined,
	resultsMap: Map<string, NodeResult>,
	edges: GraphEdge[] | undefined,
	targetNodeId: string,
): Record<string, NodeExecutionOutput> {
	if (!dependsOn || dependsOn.length === 0) return {};

	// Index edges by (from → to) for O(1) lookup per dependency.
	const edgeMap = new Map<string, GraphEdge>();
	if (edges) {
		for (const edge of edges) {
			edgeMap.set(`${edge.from}→${edge.to}`, edge);
		}
	}

	const outputs: Record<string, NodeExecutionOutput> = {};
	for (const depId of dependsOn) {
		const result = resultsMap.get(depId);
		if (!result) continue;

		// Determine artifact paths: use explicit artifacts, or fall back to
		// a synthetic "output.txt" when the node produced text output.
		let artifactPaths: string[];
		if (result.artifacts && result.artifacts.length > 0) {
			artifactPaths = result.artifacts;
		} else if (result.output) {
			artifactPaths = ["output.txt"];
		} else {
			artifactPaths = [];
		}

		// Filter by edge artifact globs.
		const edge = edgeMap.get(`${depId}→${targetNodeId}`);
		if (edge?.artifacts && edge.artifacts.length > 0) {
			artifactPaths = artifactPaths.filter(p => edge.artifacts!.some(pattern => matchGlob(pattern, p)));
		}

		outputs[depId] = {
			nodeId: depId,
			artifacts: artifactPaths,
			summary: result.output ?? result.error ?? "",
			result:
				result.metadata !== undefined ? { output: result.output ?? "", ...result.metadata } : (result.output ?? ""),
		};
	}
	return outputs;
}

/**
 * Build the dependency map from a graph definition — nodes depend on
 * `depends_on`, route targets, and conditional edge sources.
 */
function buildDependencyMap(def: GraphDefinition): Map<string, Set<string>> {
	const deps = new Map<string, Set<string>>();
	for (const name of Object.keys(def.nodes)) {
		deps.set(name, new Set());
	}
	for (const [name, node] of Object.entries(def.nodes)) {
		for (const dep of node.depends_on) {
			deps.get(name)!.add(dep);
		}
		if (node.routes) {
			for (const cond of node.routes.conditions) {
				if (deps.has(cond.to)) deps.get(cond.to)!.add(name);
			}
			if (node.routes.default && deps.has(node.routes.default)) {
				deps.get(node.routes.default)!.add(name);
			}
		}
	}
	if (def.edges) {
		for (const edge of def.edges) {
			if (deps.has(edge.to)) deps.get(edge.to)!.add(edge.from);
		}
	}
	return deps;
}

/**
 * Build a condition context for a single upstream node result. Field
 * references like `${build}.exitCode` map onto this shape.
 */
function buildConditionContext(nodeId: string, result: NodeResult): Record<string, unknown> {
	return {
		[nodeId]: {
			success: result.success,
			output: result.output,
			error: result.error,
			exitCode: result.exitCode,
			artifacts: result.artifacts,
			metadata: result.metadata,
		},
	};
}

/**
 * Evaluate a node's `routes` against completed upstream results. Returns the
 * selected {@link RouteDecision}, or undefined when the node has no routes.
 * The first matching condition wins; falls back to `routes.default`.
 */
function evaluateNodeRoutes(
	graph: GraphDefinition,
	nodeId: string,
	nodeResults: Map<string, NodeResult>,
): RouteDecision | undefined {
	const node = graph.nodes[nodeId];
	const routes = node?.routes;
	if (!routes) return undefined;

	// Build a context containing the routing node itself plus every completed
	// upstream node result, so conditions can reference the routing source
	// (e.g. `${build}.exitCode`) and any of its dependencies.
	const ctx: Record<string, unknown> = {};
	for (const [id, result] of nodeResults) {
		Object.assign(ctx, buildConditionContext(id, result));
	}

	for (const cond of routes.conditions) {
		if (evaluateCondition(cond.when, ctx)) {
			return { from: nodeId, to: cond.to, matched: cond.when };
		}
	}
	if (routes.default) {
		return { from: nodeId, to: routes.default, matched: "default" };
	}
	return { from: nodeId, to: "", matched: "none" };
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

		// Select scheduler: dynamic when the graph opts in via `strategy: dynamic`
		// OR when any node declares routes / any edge has a condition. Waves
		// otherwise, preserving legacy behavior.
		const usesConditional = this.#usesConditionalRouting();
		const scheduler = usesConditional
			? new DynamicScheduler(
					buildDependencyMap(this.#graph),
					nodeInfos,
					this.#graph.max_concurrency ?? 4,
					this.#buildConditionalGate(),
					this.#routeSourceIds(),
				)
			: new WaveScheduler(nodeInfos);

		const totalNodes = Object.keys(this.#graph.nodes).length;
		const executionErrors: string[] = [];
		const agentsList: Array<{ id: string; role: string }> = [];
		const nodeResults = new Map<string, NodeResult>();
		const decisions: RouteDecision[] = [];

		// Recover prior checkpoint so we can skip already-completed nodes and
		// rebuild their results for conditional-routing reconstruction.
		const priorCheckpoint = await this.#checkpointStore.recover(this.#graphName);
		const completedNodeIds = new Set<string>();
		if (priorCheckpoint) {
			for (const [nid, ns] of Object.entries(priorCheckpoint.nodes)) {
				if (ns.status === "completed") {
					completedNodeIds.add(nid);
					if (ns.result) {
						nodeResults.set(nid, {
							nodeId: nid,
							success: ns.result.success,
							output: ns.result.output,
							error: ns.result.error,
							exitCode: ns.result.exitCode,
							metadata: ns.result.metadata,
						});
					}
				}
			}
			if (priorCheckpoint.decisions) {
				decisions.push(...priorCheckpoint.decisions);
			}
			logger.info("[GraphEngine] Resuming from prior checkpoint", {
				graphName: this.#graphName,
				completedNodes: completedNodeIds.size,
				currentWave: priorCheckpoint.currentWave,
			});
		}

		// Write initial checkpoint.
		this.#writeCheckpoint("running", completedNodeIds, 0, decisions);

		try {
			await scheduler.schedule(
				this.#waves,
				this.#buildNodeRunner(executor, signal, nodeResults, decisions, {
					executionErrors,
					agentsList,
					completedNodeIds,
				}),
			);
		} catch (err) {
			// WaveScheduler throws when a hard failure aborts the wave.
			// Node-level errors are already captured by onNodeComplete;
			// only add the abort when no individual errors were recorded
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

	/** True when the graph uses any conditional routing (dynamic scheduling required). */
	#usesConditionalRouting(): boolean {
		if (this.#graph.strategy === "dynamic") return true;
		if (this.#graph.edges?.some(e => e.condition !== undefined)) return true;
		for (const node of Object.values(this.#graph.nodes)) {
			if (node.routes) return true;
		}
		return false;
	}

	/** Node ids that declare `routes` — their failure routes downstream instead of aborting. */
	#routeSourceIds(): Set<string> {
		const ids = new Set<string>();
		for (const [name, node] of Object.entries(this.#graph.nodes)) {
			if (node.routes) ids.add(name);
		}
		return ids;
	}

	/**
	 * Build the conditional gate consulted by DynamicScheduler before a node
	 * runs. The gate evaluates:
	 *   1. Node-level `routes` — a node whose `routes` select a target makes
	 *      only that target runnable; other declared targets are skipped.
	 *   2. Incoming `edge.condition` — a node reached via a conditional edge
	 *      runs only when at least one incoming condition is active.
	 *
	 * A node with no conditional routing always passes.
	 */
	#buildConditionalGate(): (nodeId: string, completedResults: Map<string, NodeResult>) => boolean {
		const graph = this.#graph;

		// Index: route target → routing source node ids.
		const routeTargets = new Map<string, string[]>();
		for (const [name, node] of Object.entries(graph.nodes)) {
			if (!node.routes) continue;
			for (const cond of node.routes.conditions) {
				routeTargets.set(cond.to, [...(routeTargets.get(cond.to) ?? []), name]);
			}
			if (node.routes.default) {
				routeTargets.set(node.routes.default, [...(routeTargets.get(node.routes.default) ?? []), name]);
			}
		}

		// Index: incoming conditional edges per target node.
		const conditionalIncoming = new Map<string, GraphEdge[]>();
		for (const edge of graph.edges ?? []) {
			if (edge.condition === undefined) continue;
			conditionalIncoming.set(edge.to, [...(conditionalIncoming.get(edge.to) ?? []), edge]);
		}

		return (nodeId: string, completedResults: Map<string, NodeResult>): boolean => {
			// Case 1: node is a route target of one or more routing sources.
			const sources = routeTargets.get(nodeId);
			if (sources && sources.length > 0) {
				// The node is runnable if any routing source has completed and
				// selected it as its target.
				for (const source of sources) {
					const srcResult = completedResults.get(source);
					if (!srcResult) continue;
					const decision = evaluateNodeRoutes(graph, source, completedResults);
					if (decision && decision.to === nodeId) return true;
				}
				// No routing source selected this node. If all sources have
				// completed (settled), the node is unreachable → skip. If a
				// source is still pending, defer (DynamicScheduler calls us only
				// once all deps settle, so sources are always completed here).
				return false;
			}

			// Case 2: node is the target of incoming conditional edges.
			const condEdges = conditionalIncoming.get(nodeId);
			if (condEdges && condEdges.length > 0) {
				for (const edge of condEdges) {
					const srcResult = completedResults.get(edge.from);
					if (!srcResult) continue;
					const ctx = buildConditionContext(edge.from, srcResult);
					if (evaluateCondition(edge.condition!, ctx)) return true;
				}
				// No conditional source has settled (all skipped/pending) or none
				// matched — the node is unreachable. Skip it rather than running.
				return false;
			}

			// Case 3: routing source or unconditional node — always runnable.
			return true;
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
		decisions: RouteDecision[],
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

			// Skip already-completed nodes from checkpoint recovery. Return the
			// rebuilt result (if any) so the scheduler's completedResults map gets
			// it — critical for conditional-routing gates that read upstream output.
			if (track.completedNodeIds.has(nodeId)) {
				return nodeResults.get(nodeId) ?? { nodeId, success: true };
			}

			const node = graph.nodes[nodeId];
			if (!node) return { nodeId, success: false, error: `Unknown node: ${nodeId}` };

			// Build upstream outputs from already-executed dependencies.
			const upstreamOutputs = buildUpstreamOutputs(node.depends_on, nodeResults, graph.edges, nodeId);

			const execCtx: NodeExecutionContext = { upstreamOutputs, signal };

			try {
				const result = await executor.execute(nodeId, execCtx);
				nodeResults.set(nodeId, result);
				track.completedNodeIds.add(nodeId);
				// Record routing decision when this node declares routes.
				const routeDecision = evaluateNodeRoutes(graph, nodeId, nodeResults);
				if (routeDecision) {
					decisions.push(routeDecision);
				}
				this.#writeCheckpoint("running", track.completedNodeIds, 0, decisions, nodeResults);
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
		decisions?: RouteDecision[],
		nodeResults?: Map<string, NodeResult>,
	): void {
		const nodes: Record<string, NodeRunState> = {};
		for (const nodeId of Object.keys(this.#graph.nodes)) {
			const result = completedNodeIds.has(nodeId) ? nodeResults?.get(nodeId) : undefined;
			nodes[nodeId] = {
				nodeId,
				status: completedNodeIds.has(nodeId) ? "completed" : "pending",
				result: result
					? {
							success: result.success,
							output: result.output,
							error: result.error,
							exitCode: result.exitCode,
							metadata: result.metadata,
						}
					: undefined,
			};
		}

		const ok = this.#checkpointStore.write({
			graphName: this.#graphName,
			runId: `graph-${this.#graphName}-${Date.now()}`,
			startedAt: Date.now(),
			nodes,
			currentWave,
			status,
			decisions,
		});

		if (!ok) {
			this.#checkpointDegraded = true;
		}
	}
}
