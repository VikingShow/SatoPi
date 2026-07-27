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
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { AgentHandle } from "../agent-runtime/agent-handle";
import type { AgentSpec } from "../agent-runtime/agent-spec";
import type { AgentRuntime } from "../agent-runtime";

// ============================================================================
// Types
// ============================================================================

/**
 * Gate specification for node-level validation.
 *
 * Gates run after node execution to decide whether the result is acceptable
 * or needs retry / human intervention.
 */
export interface GateSpec {
	/** Run a compile check (e.g. `tsc --noEmit`). */
	compile?: boolean;

	/** Test command to run (e.g. `bun test`). */
	test?: string;

	/** Run LSP diagnostics on produced files. */
	lsp?: boolean;

	/** Human review policy. */
	humanReview?: "always" | "on-failure" | "never";

	/** Retry strategy when a gate fails. */
	retryStrategy?: "immediate" | "fixup" | "human";
}

/**
 * Minimal node definition consumed by NodeBehavior.
 *
 * The full schema lives in graph/schema.ts (GraphNode). This subset covers
 * everything a behavior needs to prepare and execute an agent.
 */
export interface NodeDefinition {
	/** Unique node identifier within the graph. */
	id: string;

	/** Human-readable label for UI rendering. */
	label: string;

	/** Natural-language description of what this node does. */
	description: string;

	/** Node type — drives which behavior is selected. */
	type?: "script" | "stage" | "curtain" | "custom";

	/** Role name resolved via RoleProvider (e.g. "backend", "reviewer"). */
	role: string;

	/** Tools available to the agent spawned by this node. */
	tools: string[];

	/** Node IDs this node depends on (upstream). */
	dependsOn: string[];

	/** Gate to run after execution. */
	gate?: GateSpec;

	/** Timeout string (e.g. "30m", "2h"). */
	timeout?: string;

	/** Explicit AgentProfile binding. */
	profileId?: string;
}

/**
 * Output produced by an upstream node, injected into downstream NodeContext.
 */
export interface NodeOutput {
	/** The node that produced this output. */
	nodeId: string;

	/** File paths produced as artifacts. */
	artifacts: string[];

	/** Human-readable summary of what the node did. */
	summary: string;

	/** Raw execution result for downstream consumption. */
	result?: unknown;
}

/**
 * Context assembled by GraphExecutor and injected into every NodeBehavior method.
 *
 * Includes the node definition, runtime services, upstream outputs, and
 * accumulated experience from prior runs.
 */
export interface NodeContext {
	/** The node definition being executed. */
	node: NodeDefinition;

	/** Absolute path to the project workspace. */
	workspace: string;

	/** Model registry for resolving model references. */
	modelRegistry: ModelRegistry;

	/** Application settings (provider keys, concurrency, etc.). */
	settings: Settings;

	/** Outputs from nodes listed in node.dependsOn (keyed by node ID). */
	upstreamOutputs: Record<string, NodeOutput>;

	/** Concatenated lessons / hints from prior runs (ExperienceStore). */
	experience: string;

	/** AbortSignal for cooperative cancellation. */
	signal: AbortSignal;

	/** Agent runtime for spawning sub-agents. */
	runtime: AgentRuntime;
}

/**
 * Result of a single node execution.
 */
export interface NodeResult {
	/** Whether the agent completed without errors. */
	success: boolean;

	/** Agent output text. */
	output?: string;

	/** File paths produced by this node. */
	artifacts?: string[];

	/** Error message if execution failed. */
	error?: string;

	/** Per-agent results for downstream consumption. */
	agentResults?: Array<{ agentId: string; output: string; error?: string }>;
}

/**
 * Outcome of gate validation after node execution.
 */
export interface GateResult {
	/** Whether all gates passed. */
	passed: boolean;

	/** Descriptions of failed gates. */
	failures: string[];

	/** Whether the human must review before proceeding. */
	humanReviewRequired: boolean;

	/** Recommended retry strategy based on failure type. */
	retryStrategy?: "immediate" | "fixup" | "human";
}

// ============================================================================
// NodeBehavior interface (ADR-3)
// ============================================================================

/**
 * Pluggable behavior contract for a single Theatre Graph node.
 *
 * The GraphExecutor drives the lifecycle:
 *   1. prepare(ctx)     — assemble AgentSpecs
 *   2. execute(ctx, p)  — spawn agents, wait for results
 *   3. validate(r, g)   — run gate checks against the result
 *   4. cleanup(ctx)     — abort agents, release resources
 *
 * Behaviors receive NodeContext (assembled by GraphExecutor) and do not
 * import concrete infrastructure directly.
 */
export interface NodeBehavior {
	/** Human-readable name for diagnostics and logging. */
	readonly name: string;

	/**
	 * Prepare: assemble agent specs from the node definition.
	 *
	 * Called once before execute(). The returned AgentSpec[] is passed
	 * verbatim to execute() so the behavior can carry state without
	 * mutable fields.
	 */
	prepare(ctx: NodeContext): Promise<AgentSpec[]>;

	/**
	 * Execute: spawn the prepared agents and collect results.
	 *
	 * @param ctx     — assembled node context
	 * @param prepared — agent specs from prepare()
	 */
	execute(ctx: NodeContext, prepared: AgentSpec[]): Promise<NodeResult>;

	/**
	 * Validate: run gate checks against the execution result.
	 *
	 * Called after execute() regardless of success/failure. The gate
	 * decides whether the node passes or needs retry / human intervention.
	 *
	 * @param result — result from execute()
	 * @param gate   — gate spec from the node definition (undefined = auto-pass)
	 */
	validate(result: NodeResult, gate?: GateSpec): Promise<GateResult>;

	/**
	 * Cleanup: abort any still-running agents and release resources.
	 *
	 * Called after validate(), even if execute() threw. Must be idempotent.
	 */
	cleanup(ctx: NodeContext): Promise<void>;
}

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
			return { success: true, output: "(no agents to execute)" };
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

		// Compile gate — placeholder; real implementation uses LSP/tool bridge
		if (gate.compile) {
			// TODO: wire bash tool to run tsc --noEmit in workspace
			logger.debug("[CustomNodeBehavior] Compile gate: not yet wired");
		}

		// Test gate — placeholder
		if (gate.test) {
			// TODO: wire bash tool to run the test command
			logger.debug("[CustomNodeBehavior] Test gate: not yet wired", { cmd: gate.test });
		}

		// LSP gate — placeholder
		if (gate.lsp) {
			// TODO: wire LSP diagnostics reader
			logger.debug("[CustomNodeBehavior] LSP gate: not yet wired");
		}

		// Failure-driven human review
		if (!result.success && gate.humanReview !== "never") {
			failures.push("Agent execution failed");
		}

		const passed = failures.length === 0;
		const humanReviewRequired =
			gate.humanReview === "always" || (gate.humanReview !== "never" && !passed);

		return {
			passed,
			failures,
			humanReviewRequired,
			retryStrategy: passed ? undefined : gate.retryStrategy ?? "fixup",
		};
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
