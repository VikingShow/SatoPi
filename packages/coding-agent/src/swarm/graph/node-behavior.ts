/**
 * NodeBehavior — Interface and implementations for Theatre Graph node execution.
 *
 * Each node type (custom, script, stage, curtain) implements the NodeBehavior
 * lifecycle: prepare → execute → validate → cleanup. The GraphExecutor drives
 * this lifecycle per node, feeding NodeContext assembled from graph definition,
 * upstream outputs, and runtime services.
 *
 * ADR-3: Node type system
 *   - custom: default — spawns one agent with role + task
 *   - script: interactive planning with human review
 *   - stage: parallel worker agents via task queue
 *   - curtain: reflective — reporter + reflector, lesson extraction
 *
 * For v1, only CustomNodeBehavior is a real implementation. Script, Stage,
 * and Curtain are stubs that delegate to CustomNodeBehavior pending their
 * full wiring through PhaseBehaviorNodeAdapter in a follow-up task.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentHandle } from "../agent-runtime/agent-handle";
import type { AgentSpec } from "../agent-runtime/agent-spec";
import type {
	GateSpec,
	NodeDefinition,
	NodeExecutionOutput,
	NodeContext,
	NodeResult,
	GateResult,
	NodeBehavior,
} from "./schema";

// ============================================================================
// CustomNodeBehavior (default)
// ============================================================================

/**
 * Default node behavior — spawns a single agent with role + task and waits.
 *
 * This is the simplest behavior and handles the `custom` node type (the
 * default when no type is specified). For v1 it is also the fallback for
 * Script, Stage, and Curtain stubs.
 *
 * Lifecycle:
 *   1. prepare → build one AgentSpec from NodeDefinition
 *   2. execute → spawn via AgentRuntime, wait for SingleResult
 *   3. validate → if gate passed, check for test command; gate result
 *   4. cleanup  → abort any agent still running (no-op when wait() resolved)
 */
export class CustomNodeBehavior implements NodeBehavior {
	readonly name = "custom";

	/** Track spawned handles for cleanup. */
	#handles: AgentHandle[] = [];

	// ======================================================================
	// prepare
	// ======================================================================

	async prepare(ctx: NodeContext): Promise<AgentSpec[]> {
		const { node, workspace, experience } = ctx;

		// Build a task description from node metadata + upstream context
		const taskParts: string[] = [node.description];

		// Inject upstream outputs as context
		const upstreamIds = node.dependsOn ?? [];
		if (upstreamIds.length > 0) {
			taskParts.push("\n## Upstream Outputs");
			for (const id of upstreamIds) {
				const out = ctx.upstreamOutputs[id];
				if (out) {
					taskParts.push(`\n### ${out.nodeId}\n${out.summary}`);
					if (out.artifacts.length > 0) {
						taskParts.push(`Artifacts: ${out.artifacts.join(", ")}`);
					}
				}
			}
		}

		// Inject experience / lessons from prior runs
		if (experience) {
			taskParts.push(`\n## Prior Experience\n${experience}`);
		}

		const task = taskParts.join("\n");

		logger.info("[CustomNodeBehavior] Preparing agent spec", {
			nodeId: node.id,
			role: node.role,
			toolCount: node.tools.length,
			workspace,
		});

		const spec: AgentSpec = {
			id: `node-${node.id}`,
			role: node.role,
			roleSource: "library",
			task,
			profileId: node.profileId,
		};

		return [spec];
	}

	// ======================================================================
	// execute
	// ======================================================================

	async execute(ctx: NodeContext, prepared: AgentSpec[]): Promise<NodeResult> {
		if (prepared.length === 0) {
			return { nodeId: ctx.node.id, success: true, output: "(no agents to execute)" };
		}

		const spec = prepared[0]!;

		logger.info("[CustomNodeBehavior] Spawning agent", {
			nodeId: ctx.node.id,
			agentId: spec.id,
		});

		try {
			const handles = await ctx.runtime.spawn([spec]);
			this.#handles = handles;

			const handle = handles[0]!;
			const result = await handle.wait();

			const output = typeof result?.output === "string" ? result.output : String(result ?? "");
			const success = !result?.error;

			logger.info("[CustomNodeBehavior] Agent completed", {
				nodeId: ctx.node.id,
				agentId: spec.id,
				success,
				outputLength: output.length,
			});

			return {
				nodeId: ctx.node.id,
				success,
				output,
				error: result?.error,
				agentResults: [{ agentId: spec.id, output, error: result?.error }],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("[CustomNodeBehavior] Agent failed", {
				nodeId: ctx.node.id,
				agentId: spec.id,
				error: message,
			});

			return {
				nodeId: ctx.node.id,
				success: false,
				error: message,
				agentResults: [{ agentId: spec.id, output: "", error: message }],
			};
		}
	}

	// ======================================================================
	// validate
	// ======================================================================

	async validate(result: NodeResult, gate?: GateSpec): Promise<GateResult> {
		if (!gate) {
			return { passed: true, failures: [], humanReviewRequired: false };
		}

		const failures: string[] = [];

		// Gate type determines which checks run (all stubs for v1).
		switch (gate.type) {
			case "compile-check":
				logger.debug("[CustomNodeBehavior] Compile gate: not yet wired");
				break;
			case "test":
				logger.debug("[CustomNodeBehavior] Test gate: not yet wired", { cmd: gate.command });
				break;
			case "lsp":
				logger.debug("[CustomNodeBehavior] LSP gate: not yet wired");
				break;
			case "human-review":
				// Handled below via mode check.
				break;
			case "script":
				logger.debug("[CustomNodeBehavior] Script gate: not yet wired");
				break;
		}

		// Failure-driven human review via gate mode.
		if (!result.success && gate.mode !== "never") {
			failures.push("Agent execution failed");
		}

		const passed = failures.length === 0;
		const humanReviewRequired =
			gate.mode === "always" || (gate.mode !== "never" && !passed);

		return { passed, failures, humanReviewRequired };
	}

	// ======================================================================
	// cleanup
	// ======================================================================

	async cleanup(_ctx: NodeContext): Promise<void> {
		for (const handle of this.#handles) {
			try {
				handle.abort();
			} catch {
				// Agent already terminated — ignore
			}
		}
		this.#handles = [];
	}
}

// ============================================================================
// ScriptNodeBehavior (stub — delegates to CustomNodeBehavior for v1)
// ============================================================================

/**
 * Stub behavior for the Script (planning) phase.
 *
 * In the full implementation, this will spawn a Planner agent via AgentRuntime,
 * present the plan for human review through a dedicated channel, and support
 * multi-turn plan refinement before confirmation.
 *
 * For v1, it delegates to CustomNodeBehavior. The real implementation will be
 * wired through PhaseBehaviorNodeAdapter in a follow-up task.
 */
export class ScriptNodeBehavior implements NodeBehavior {
	readonly name = "script";

	#delegate = new CustomNodeBehavior();

	async prepare(ctx: NodeContext): Promise<AgentSpec[]> {
		return this.#delegate.prepare(ctx);
	}

	async execute(ctx: NodeContext, prepared: AgentSpec[]): Promise<NodeResult> {
		return this.#delegate.execute(ctx, prepared);
	}

	async validate(result: NodeResult, gate?: GateSpec): Promise<GateResult> {
		return this.#delegate.validate(result, gate);
	}

	async cleanup(ctx: NodeContext): Promise<void> {
		return this.#delegate.cleanup(ctx);
	}
}

// ============================================================================
// StageNodeBehavior (stub — delegates to CustomNodeBehavior for v1)
// ============================================================================

/**
 * Stub behavior for the Stage (execution) phase.
 *
 * In the full implementation, this will parse the plan, spawn multiple worker
 * agents via AgentRuntime with a DAG-based task queue, support steering
 * directives from the human, and track per-agent completion.
 *
 * For v1, it delegates to CustomNodeBehavior. The real implementation will be
 * wired through PhaseBehaviorNodeAdapter in a follow-up task.
 */
export class StageNodeBehavior implements NodeBehavior {
	readonly name = "stage";

	#delegate = new CustomNodeBehavior();

	async prepare(ctx: NodeContext): Promise<AgentSpec[]> {
		return this.#delegate.prepare(ctx);
	}

	async execute(ctx: NodeContext, prepared: AgentSpec[]): Promise<NodeResult> {
		return this.#delegate.execute(ctx, prepared);
	}

	async validate(result: NodeResult, gate?: GateSpec): Promise<GateResult> {
		return this.#delegate.validate(result, gate);
	}

	async cleanup(ctx: NodeContext): Promise<void> {
		return this.#delegate.cleanup(ctx);
	}
}

// ============================================================================
// CurtainNodeBehavior (stub — delegates to CustomNodeBehavior for v1)
// ============================================================================

/**
 * Stub behavior for the Curtain (reporting) phase.
 *
 * In the full implementation, this will elect a Reporter via CommBus vote,
 * spawn Reporter + Reflector agents, extract lessons into ExperienceStore,
 * and optionally refine the graph definition.
 *
 * For v1, it delegates to CustomNodeBehavior. The real implementation will be
 * wired through PhaseBehaviorNodeAdapter in a follow-up task.
 */
export class CurtainNodeBehavior implements NodeBehavior {
	readonly name = "curtain";

	#delegate = new CustomNodeBehavior();

	async prepare(ctx: NodeContext): Promise<AgentSpec[]> {
		return this.#delegate.prepare(ctx);
	}

	async execute(ctx: NodeContext, prepared: AgentSpec[]): Promise<NodeResult> {
		return this.#delegate.execute(ctx, prepared);
	}

	async validate(result: NodeResult, gate?: GateSpec): Promise<GateResult> {
		return this.#delegate.validate(result, gate);
	}

	async cleanup(ctx: NodeContext): Promise<void> {
		return this.#delegate.cleanup(ctx);
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Select the appropriate NodeBehavior for a node's type.
 *
 * Maps node.type (or lack thereof) to the correct behavior class.
 * Callers should hold the returned instance for the duration of
 * the node's lifecycle (prepare → cleanup).
 *
 * @param type — node type from GraphNode.type (undefined = "custom")
 */
export function selectNodeBehavior(type?: string): NodeBehavior {
	switch (type) {
		case "script":
			return new ScriptNodeBehavior();
		case "stage":
			return new StageNodeBehavior();
		case "curtain":
			return new CurtainNodeBehavior();
		default:
			return new CustomNodeBehavior();
	}
}
