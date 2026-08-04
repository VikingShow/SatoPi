/**
 * SubgraphNodeBehavior — executes a nested Theatre Graph as a single node.
 *
 * A `type: subgraph` node references another `.graph.yaml` file via
 * `subgraph_path`. When executed, this behavior loads the subgraph, runs it
 * through a nested {@link GraphEngine}, and aggregates the subgraph's results
 * into the parent node's {@link NodeResult}.
 *
 * The nested engine's per-node executor is implemented here: each subgraph
 * `custom` node spawns one agent via `ctx.runtime` (the shared SwarmRuntime),
 * mirroring {@link CustomNodeBehavior}. The nested engine reuses the full
 * scheduling lifecycle (waves / dynamic + conditional routing) so subgraph
 * internals behave exactly like a top-level graph.
 *
 * Checkpointing: the nested engine runs with an in-memory checkpoint store —
 * subgraphs are intended to run to completion within the parent node. This
 * keeps subgraph recovery scoped to the parent node's checkpoint.
 */

import * as path from "node:path";
import { logger } from "@satopi/pi-utils";
import type { AgentSpec } from "./agent-spec";
import type { CheckpointStore } from "./checkpoint";
import { buildExecutionWaves } from "./dag";
import { GraphEngine, type GraphEngineConfig, type NodeExecutionContext, type NodeExecutor } from "./graph-engine";
import { LoopNodeBehavior } from "./loop-node-behavior";
import type { NodeBehavior } from "./schema";
import { buildGraphDependencyMap, loadGraphDefinition } from "./schema";
import type { GateResult, GateSpec, GraphDefinition, NodeContext, NodeResult } from "./types";

export class SubgraphNodeBehavior implements NodeBehavior {
	readonly name = "subgraph";

	#subgraphDef: GraphDefinition | null = null;
	#subgraphName = "";

	async prepare(ctx: NodeContext): Promise<AgentSpec[]> {
		const relPath = ctx.node.subgraphPath;
		if (!relPath) {
			throw new Error(`Node '${ctx.node.id}': subgraph_path not specified`);
		}

		// Subgraph path is relative to the parent graph's directory (graphDir
		// when available, falling back to workspace). This keeps nested subgraph
		// references correct even when the parent graph lives outside workspace.
		const baseDir = ctx.graphDir ?? ctx.workspace;
		const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(baseDir, relPath);

		try {
			this.#subgraphDef = await loadGraphDefinition(absPath);
			this.#subgraphName = this.#subgraphDef.name;
			logger.info("[SubgraphNodeBehavior] Loaded subgraph", {
				nodeId: ctx.node.id,
				subgraphPath: absPath,
				subgraphName: this.#subgraphName,
				nodeCount: Object.keys(this.#subgraphDef.nodes).length,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Node '${ctx.node.id}': failed to load subgraph '${absPath}': ${msg}`);
		}

		// Subgraphs spawn no direct agents — the nested engine spawns its own.
		return [];
	}

	async execute(ctx: NodeContext, _prepared: AgentSpec[]): Promise<NodeResult> {
		const def = this.#subgraphDef;
		if (!def) {
			return { nodeId: ctx.node.id, success: false, error: "Subgraph not loaded (prepare() not called)" };
		}

		const executor = new SubgraphNodeExecutor(def, ctx);

		const engineConfig: GraphEngineConfig = {
			graph: def,
			waves: buildExecutionWaves(buildGraphDependencyMap(def)),
			checkpointStore: inMemoryCheckpointStore(),
			graphName: this.#subgraphName,
			abortSignal: ctx.signal,
		};
		const engine = new GraphEngine(engineConfig);

		try {
			const runResult = await engine.run(executor);
			const output = aggregateSubgraphOutput(runResult);
			const success = runResult.executionErrors.length === 0;
			logger.info("[SubgraphNodeBehavior] Subgraph execution complete", {
				nodeId: ctx.node.id,
				subgraphName: this.#subgraphName,
				completed: runResult.completedCount,
				total: runResult.totalNodes,
				errors: runResult.executionErrors.length,
			});
			return {
				nodeId: ctx.node.id,
				success,
				output,
				error: success ? undefined : runResult.executionErrors.join("; "),
				metadata: {
					subgraphName: this.#subgraphName,
					completedCount: runResult.completedCount,
					totalNodes: runResult.totalNodes,
					errorCount: runResult.executionErrors.length,
				},
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("[SubgraphNodeBehavior] Subgraph execution failed", { nodeId: ctx.node.id, error: msg });
			return { nodeId: ctx.node.id, success: false, error: msg };
		}
	}

	async validate(_result: NodeResult, _gate?: GateSpec): Promise<GateResult> {
		// Subgraph internal validation is delegated to the nested engine.
		return { passed: true, failures: [], humanReviewRequired: false };
	}

	async cleanup(_ctx: NodeContext): Promise<void> {
		this.#subgraphDef = null;
	}
}

// ============================================================================
// SubgraphNodeExecutor — executes subgraph nodes via the parent's SwarmRuntime
// ============================================================================

/**
 * NodeExecutor for the nested subgraph engine. Each subgraph node is executed
 * like a {@link CustomNodeBehavior} node: build an AgentSpec from the node
 * definition + upstream outputs, spawn via the shared runtime, wait, and
 * return a {@link NodeResult}. Supports `custom` nodes (and defaults for any
 * other type to a plain agent spawn). Conditional routing inside the subgraph
 * is handled by the nested GraphEngine itself.
 */
class SubgraphNodeExecutor implements NodeExecutor {
	readonly #graph: GraphDefinition;
	readonly #parentCtx: NodeContext;

	constructor(graph: GraphDefinition, parentCtx: NodeContext) {
		this.#graph = graph;
		this.#parentCtx = parentCtx;
	}

	async execute(nodeId: string, execCtx: NodeExecutionContext): Promise<NodeResult> {
		const node = this.#graph.nodes[nodeId];
		if (!node) return { nodeId, success: false, error: `Unknown subgraph node: ${nodeId}` };

		// Nested subgraphs are supported recursively.
		if (node.type === "subgraph") {
			const nested = new SubgraphNodeBehavior();
			const nestedCtx = this.#buildNodeContext(nodeId, node, execCtx);
			try {
				await nested.prepare(nestedCtx);
				return await nested.execute(nestedCtx, []);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { nodeId, success: false, error: msg };
			}
		}

		// Loop nodes inside a subgraph are executed by LoopNodeBehavior.
		if (node.type === "loop") {
			const loopBehavior = new LoopNodeBehavior();
			const loopCtx = this.#buildNodeContext(nodeId, node, execCtx);
			try {
				await loopBehavior.prepare(loopCtx);
				return await loopBehavior.execute(loopCtx, []);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { nodeId, success: false, error: msg };
			}
		}

		// script/stage/curtain need full swarm infrastructure, which a nested
		// subgraph does not carry — reject them explicitly rather than silently
		// spawning a single agent.
		if (node.type === "script" || node.type === "stage" || node.type === "curtain") {
			return {
				nodeId,
				success: false,
				error: `Node type '${node.type}' is not supported inside a subgraph (custom, loop, subgraph only)`,
			};
		}

		// Build the agent task from description + upstream outputs.
		const taskParts: string[] = [node.description ?? ""];
		const upstreamIds = node.depends_on ?? [];
		if (upstreamIds.length > 0) {
			taskParts.push("\n## Upstream Outputs");
			for (const id of upstreamIds) {
				const out = execCtx.upstreamOutputs[id];
				if (out) {
					taskParts.push(`\n### ${out.nodeId}\n${out.summary}`);
					if (out.artifacts.length > 0) {
						taskParts.push(`Artifacts: ${out.artifacts.join(", ")}`);
					}
				}
			}
		}

		const spec: AgentSpec = {
			id: `subgraph-${nodeId}`,
			role: node.role,
			roleSource: "library",
			task: taskParts.join("\n"),
			profileId: node.profile_id,
		};

		try {
			const sessions = await this.#parentCtx.runtime.spawn([spec]);
			const session = sessions[0]!;
			const result = await session.wait();
			const output = typeof result?.output === "string" ? result.output : String(result ?? "");
			return {
				nodeId,
				success: !result?.error,
				output,
				error: result?.error,
				exitCode: result?.exitCode,
				agentResults: [{ agentId: spec.id, output, error: result?.error }],
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { nodeId, success: false, error: msg, agentResults: [{ agentId: spec.id, output: "", error: msg }] };
		}
	}

	/** Build a minimal NodeContext for a nested subgraph node. */
	#buildNodeContext(
		nodeId: string,
		node: GraphDefinition["nodes"][string],
		execCtx: NodeExecutionContext,
	): NodeContext {
		return {
			node: {
				id: nodeId,
				label: node.label,
				description: node.description,
				role: node.role,
				profileId: node.profile_id,
				tools: node.tools ?? [],
				type: node.type ?? "custom",
				dependsOn: node.depends_on ?? [],
				subgraphPath: node.subgraph_path,
				gate: node.gate,
				timeout: node.timeout,
				loopOver: node.loop_over,
				loopBody: node.loop_body,
				loopMaxIterations: node.loop_max_iterations,
				loopBreakWhen: node.loop_break_when,
				loopConvergenceThreshold: node.loop_convergence_threshold,
			},
			workspace: this.#parentCtx.workspace,
			modelRegistry: this.#parentCtx.modelRegistry,
			settings: this.#parentCtx.settings,
			upstreamOutputs: execCtx.upstreamOutputs,
			experience: this.#parentCtx.experience,
			signal: execCtx.signal,
			runtime: this.#parentCtx.runtime,
			agentRegistry: this.#parentCtx.agentRegistry,
			roleAssetManager: this.#parentCtx.roleAssetManager,
			profileRegistry: this.#parentCtx.profileRegistry,
			stateTracker: this.#parentCtx.stateTracker,
			activityLogger: this.#parentCtx.activityLogger,
			ircBus: this.#parentCtx.ircBus,
			executeNode: this.#parentCtx.executeNode,
			graphDir: this.#parentCtx.graphDir,
		};
	}
}

// ============================================================================
// Helpers
// ============================================================================

/** In-memory checkpoint store — subgraphs run to completion within the parent node. */
function inMemoryCheckpointStore(): CheckpointStore {
	return {
		write(): boolean {
			return true;
		},
		async recover(): Promise<never> {
			return null as never;
		},
	};
}

/** Aggregate a nested GraphRunResult into a compact text summary. */
function aggregateSubgraphOutput(runResult: {
	completedCount: number;
	totalNodes: number;
	executionErrors: string[];
}): string {
	const lines: string[] = [];
	lines.push(`Subgraph executed: ${runResult.completedCount}/${runResult.totalNodes} nodes completed`);
	if (runResult.executionErrors.length > 0) {
		lines.push("Errors:");
		for (const err of runResult.executionErrors) {
			lines.push(`  - ${err}`);
		}
	}
	return lines.join("\n");
}
