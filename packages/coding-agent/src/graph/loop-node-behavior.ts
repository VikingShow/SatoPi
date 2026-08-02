/**
 * LoopNodeBehavior — executes a loop node by iterating over a collection.
 *
 * A `type: loop` node repeatedly executes a body (a single `custom` node in
 * v1) for each item in an iteration source. The source is either a literal
 * array (`"[1,2,3]"`) or a field reference (`"${node}.items"` resolved from
 * upstream outputs). Execution stops after `loop_max_iterations` or when
 * `loop_break_when` evaluates truthy.
 *
 * The loop maintains iteration state and injects `loop.item` / `loop.index`
 * into each body execution so the body's task can reference the current item.
 *
 * The loop is a node-level behavior — the surrounding scheduler treats it as
 * a single node, so it composes cleanly with conditional routing and
 * subgraphs from phases 1–2.
 */

import { logger } from "@satopi/pi-utils";
import { jaccardSimilarity } from "../swarm/core/convergence";
import type { AgentSpec } from "./agent-spec";
import { evaluateCondition } from "./condition";
import type { NodeBehavior } from "./schema";
import type { GateResult, GateSpec, LoopBodySpec, NodeContext, NodeResult } from "./types";

export class LoopNodeBehavior implements NodeBehavior {
	readonly name = "loop";

	async prepare(_ctx: NodeContext): Promise<AgentSpec[]> {
		// Loop nodes spawn no direct agents; body execution happens in execute().
		return [];
	}

	async execute(ctx: NodeContext, _prepared: AgentSpec[]): Promise<NodeResult> {
		const node = ctx.node;

		// Resolve the iteration source.
		let items: unknown[];
		try {
			items = await resolveIterationSource(node.loopOver, ctx);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { nodeId: node.id, success: false, error: `Failed to resolve iteration source: ${msg}` };
		}
		if (!Array.isArray(items)) {
			return { nodeId: node.id, success: false, error: "Iteration source did not resolve to an array" };
		}

		const maxIterations = Math.max(1, node.loopMaxIterations ?? Math.max(1, items.length));
		const breakWhen = node.loopBreakWhen;
		const convergenceThreshold = node.loopConvergenceThreshold;

		logger.info("[LoopNodeBehavior] Starting loop", {
			nodeId: node.id,
			itemCount: items.length,
			maxIterations,
			hasBreak: !!breakWhen,
			convergenceThreshold,
		});

		const results: NodeResult[] = [];
		let lastOutput = "";

		for (let i = 0; i < Math.min(items.length, maxIterations); i++) {
			const item = items[i];
			let bodyResult: NodeResult;
			try {
				bodyResult = await this.#executeBody(ctx, i, item);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				bodyResult = { nodeId: `loop-${node.id}-${i}`, success: false, error: msg };
			}
			results.push(bodyResult);

			const currentOutput = bodyResult.output ?? "";
			// Optional convergence detection: when configured, stop early once
			// consecutive iterations produce near-identical output.
			if (i > 0 && convergenceThreshold !== undefined && currentOutput && lastOutput) {
				const similarity = jaccardSimilarity(lastOutput, currentOutput);
				if (similarity >= convergenceThreshold) {
					logger.info("[LoopNodeBehavior] Converged", { nodeId: node.id, iteration: i + 1, similarity });
					break;
				}
			}
			lastOutput = currentOutput;

			// Break condition: evaluate against the current iteration context.
			if (breakWhen && evaluateLoopBreak(breakWhen, item, i, bodyResult)) {
				logger.info("[LoopNodeBehavior] Break condition met", { nodeId: node.id, iteration: i + 1 });
				break;
			}
		}

		const success = results.every(r => r.success);
		const output = aggregateLoopOutput(results);
		const error = success ? undefined : `${results.filter(r => !r.success).length} iteration(s) failed`;

		logger.info("[LoopNodeBehavior] Loop complete", {
			nodeId: node.id,
			iterations: results.length,
			successCount: results.filter(r => r.success).length,
		});

		return {
			nodeId: node.id,
			success,
			output,
			error,
			metadata: {
				loopIterations: results.length,
				loopResults: results.map(r => ({ success: r.success, output: r.output, error: r.error })),
			},
		};
	}

	async validate(result: NodeResult, _gate?: GateSpec): Promise<GateResult> {
		return {
			passed: result.success,
			failures: result.success ? [] : [result.error ?? "Loop execution failed"],
			humanReviewRequired: false,
		};
	}

	async cleanup(_ctx: NodeContext): Promise<void> {
		// Per-iteration cleanup handled in execute().
	}

	/** Execute one loop-body iteration, spawning a single agent via the shared runtime. */
	async #executeBody(ctx: NodeContext, index: number, item: unknown): Promise<NodeResult> {
		const body = ctx.node.loopBody ?? ({} as LoopBodySpec);
		const task = buildBodyTask(body, ctx, index, item);

		const spec: AgentSpec = {
			id: `loop-${ctx.node.id}-${index}`,
			role: body.role ?? ctx.node.role,
			roleSource: "library",
			task,
		};

		try {
			const sessions = await ctx.runtime.spawn([spec]);
			const session = sessions[0]!;
			const result = await session.wait();
			const output = typeof result?.output === "string" ? result.output : String(result ?? "");
			return {
				nodeId: `loop-${ctx.node.id}-${index}`,
				success: !result?.error,
				output,
				error: result?.error,
				exitCode: result?.exitCode,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { nodeId: `loop-${ctx.node.id}-${index}`, success: false, error: msg };
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the iteration source for a loop node. Supports:
 * - literal JSON array: `"[1,2,3]"` or `"[\"a\",\"b\"]"` (double quotes required)
 * - field reference: `${upstreamNode}.items` or `${upstreamNode.items}` — reads
 *   `result.items` from the upstream node's output
 */
async function resolveIterationSource(source: string | undefined, ctx: NodeContext): Promise<unknown[]> {
	if (!source || source.trim().length === 0) {
		throw new Error("loop_over is required and must not be empty");
	}

	// Literal JSON array (double quotes).
	if (source.trim().startsWith("[")) {
		try {
			const parsed = JSON.parse(source) as unknown;
			if (Array.isArray(parsed)) return parsed;
			throw new Error(`not an array`);
		} catch {
			throw new Error(
				`invalid array literal '${source}'. Use JSON syntax with double quotes, e.g. "[1,2,3]" or '["a","b"]'`,
			);
		}
	}

	// Field reference: ${node}.field or ${node.field}
	const matchDot = source.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_-]*)\}\.([a-zA-Z_][a-zA-Z0-9_-]*)$/);
	const matchInner = source.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_-]*)\.([a-zA-Z_][a-zA-Z0-9_-]*)\}$/);
	const match = matchDot ?? matchInner;
	if (match) {
		const [, nodeId, field] = match;
		const upstream = ctx.upstreamOutputs[nodeId];
		if (!upstream) throw new Error(`upstream node '${nodeId}' not found`);
		const result = upstream.result;
		if (typeof result !== "object" || result === null) {
			throw new Error(
				`field '${nodeId}.${field}' is not accessible: upstream result is ${typeof result === "string" ? `a string "${String(result).slice(0, 50)}"` : String(result)}, not an object`,
			);
		}
		const value = (result as Record<string, unknown>)[field];
		if (!Array.isArray(value)) {
			throw new Error(`field '${nodeId}.${field}' is not an array (got ${typeof value})`);
		}
		return value;
	}

	throw new Error(`invalid iteration source '${source}'`);
}

/** Build the body agent task, injecting loop context. */
function buildBodyTask(body: LoopBodySpec, ctx: NodeContext, index: number, item: unknown): string {
	const parts: string[] = [body.description ?? `Process loop item ${index}`];
	parts.push(`\nLoop item (index ${index}):`);
	parts.push(JSON.stringify(item, null, 2));

	// Include upstream context so the body can reference prior outputs.
	const upstreamIds = ctx.node.dependsOn ?? [];
	if (upstreamIds.length > 0) {
		parts.push("\n## Upstream Outputs");
		for (const id of upstreamIds) {
			const out = ctx.upstreamOutputs[id];
			if (out) {
				parts.push(`\n### ${out.nodeId}\n${out.summary}`);
			}
		}
	}
	return parts.join("\n");
}

/** Evaluate a break condition against the current iteration context. */
function evaluateLoopBreak(condition: string, item: unknown, index: number, result: NodeResult): boolean {
	const ctx = {
		loop: {
			item,
			index,
			result: {
				success: result.success,
				output: result.output,
				error: result.error,
				exitCode: result.exitCode,
				metadata: result.metadata,
			},
		},
	};
	try {
		return evaluateCondition(condition, ctx);
	} catch (err) {
		logger.warn("[LoopNodeBehavior] Break condition eval error", {
			condition,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

/** Aggregate per-iteration results into a compact summary. */
function aggregateLoopOutput(results: NodeResult[]): string {
	const lines: string[] = [`Loop executed: ${results.length} iteration(s)`];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		lines.push(`\n### Iteration ${i + 1}`);
		lines.push(`Status: ${r.success ? "OK" : "FAILED"}`);
		if (r.output) lines.push(`Output: ${r.output.slice(0, 500)}`);
		if (r.error) lines.push(`Error: ${r.error}`);
	}
	return lines.join("\n");
}
