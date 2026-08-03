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
 * All node types are wired through selectNodeBehavior():
 *   - custom: CustomNodeBehavior (direct agent spawn)
 *   - script/stage/curtain: PhaseBehaviorNodeAdapter wrapping the real
 *     ScriptBehavior/StageBehavior/CurtainBehavior implementations
 */

import { logger } from "@satopi/pi-utils";
import type { ContextPipeline } from "../context/context-pipeline";
import type { HookPipeline } from "../hooks/hook-pipeline";
import type { AgentSession } from "../session/agent-session";
import type { LoopSwarmConfig } from "../swarm/core/schema";
import type { SwarmRuntime } from "../swarm/core/swarm-runtime";
import type { AgentSpec } from "./agent-spec";
import { CurtainBehavior } from "./behaviors/curtain-behavior";
import { ScriptBehavior } from "./behaviors/script-behavior";
import { StageBehavior } from "./behaviors/stage-behavior";
import { LoopNodeBehavior } from "./loop-node-behavior";
import { PhaseBehaviorNodeAdapter } from "./phase-behavior-adapter";
import type { GateResult, GateSpec, NodeBehavior, NodeContext, NodeResult } from "./schema";
import { SubgraphNodeBehavior } from "./subgraph-behavior";

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
	#sessions: AgentSession[] = [];

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

		// If node references a persistent agent, route to it
		if (ctx.node.profileId && ctx.agentRegistry) {
			return this.#executePersistent(ctx, prepared[0]!);
		}

		const spec = prepared[0]!;

		logger.info("[CustomNodeBehavior] Spawning agent", {
			nodeId: ctx.node.id,
			agentId: spec.id,
		});

		try {
			const sessions = await ctx.runtime.spawn([spec]);
			this.#sessions = sessions;

			const session = sessions[0]!;
			const result = await session.wait();

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

	/**
	 * Route execution to a persistent agent identified by ctx.node.profileId.
	 * Identity-level reuse: if an idle persistent agent with the same profileId
	 * already exists, a new agent is spawned with the same identity, which the
	 * AgentRegistry merges (disposing the old session). This preserves profile
	 * credit tracking, lifecycle status, and dashboard identity across tasks.
	 *
	 * Process-level reuse (steering an existing agent via its handle) is a
	 * future optimization tracked under P3.
	 */
	async #executePersistent(ctx: NodeContext, spec: AgentSpec): Promise<NodeResult> {
		const registry = ctx.agentRegistry!;
		const existing = registry.list().find(ref => ref.profileId === ctx.node.profileId);

		if (existing && existing.status === "idle") {
			logger.info("[CustomNodeBehavior] Reusing persistent agent identity", {
				nodeId: ctx.node.id,
				profileId: ctx.node.profileId,
				existingAgentId: existing.id,
			});
			// Identity-level reuse: spawn a new agent with the same profileId.
			// AgentRegistry.register() disposes the old session on duplicate id.
		}

		// Spawn new persistent agent
		logger.info("[CustomNodeBehavior] Spawning new persistent agent", {
			nodeId: ctx.node.id,
			profileId: ctx.node.profileId,
		});

		const sessions = await ctx.runtime.spawn([spec]);
		this.#sessions = sessions;

		const session = sessions[0]!;
		const result = await session.wait();

		const output = typeof result?.output === "string" ? result.output : String(result ?? "");
		const success = !result?.error;

		return {
			nodeId: ctx.node.id,
			success,
			output,
			error: result?.error,
			agentResults: [{ agentId: spec.id, output, error: result?.error }],
		};
	}

	// ======================================================================
	// validate
	// ======================================================================

	async validate(result: NodeResult, gate?: GateSpec): Promise<GateResult> {
		if (!gate) {
			return { passed: true, failures: [], humanReviewRequired: false };
		}

		const failures: string[] = [];

		switch (gate.type) {
			case "compile-check": {
				const cmd = gate.command ?? "bun check";
				try {
					const proc = Bun.spawn(["/bin/sh", "-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
					const exitCode = await proc.exited;
					const stderr = await new Response(proc.stderr).text();
					if (exitCode !== 0) {
						failures.push(`Compile gate failed (exit ${exitCode}): ${stderr.trim()}`);
					}
				} catch (err) {
					failures.push(`Compile gate error: ${String(err)}`);
				}
				break;
			}
			case "test": {
				const cmd = gate.command ?? "bun test";
				try {
					const proc = Bun.spawn(["/bin/sh", "-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
					const exitCode = await proc.exited;
					const stderr = await new Response(proc.stderr).text();
					if (exitCode !== 0) {
						failures.push(`Test gate failed (exit ${exitCode}): ${stderr.trim()}`);
					}
				} catch (err) {
					failures.push(`Test gate error: ${String(err)}`);
				}
				break;
			}
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
		const humanReviewRequired = gate.mode === "always" || (gate.mode !== "never" && !passed);

		return { passed, failures, humanReviewRequired };
	}

	// ======================================================================
	// cleanup
	// ======================================================================

	async cleanup(_ctx: NodeContext): Promise<void> {
		for (const session of this.#sessions) {
			try {
				session.abort({ reason: "cleanup" });
			} catch {
				// Agent already terminated — ignore
			}
		}
		this.#sessions = [];
	}
}

// ============================================================================
// Factory
// ============================================================================

// ============================================================================
// NodeBehaviorFactory — pluggable behavior construction
// ============================================================================

/**
 * Configuration bag passed to NodeBehavior factories so Script, Stage, and
 * Curtain behaviors can wrap real PhaseBehavior implementations through
 * PhaseBehaviorNodeAdapter instead of using stubs.
 */
export interface NodeBehaviorFactoryConfig {
	runtime: SwarmRuntime;
	hookPipeline: HookPipeline;
	contextPipeline: ContextPipeline;
	workspace: string;
	swarmDir: string;
	loopConfig: LoopSwarmConfig;
	/** Current plan.md content from the Script phase (if already produced). */
	planContent: string;
}

/**
 * Factory signature for constructing a NodeBehavior from configuration.
 *
 * Registered via {@link registerNodeBehavior} for each node type.
 */
export type NodeBehaviorFactory = (config: NodeBehaviorFactoryConfig) => NodeBehavior;

/**
 * Registry mapping node types to their behavior factories.
 *
 * New node types can be added at runtime via {@link registerNodeBehavior}
 * without editing the selectNodeBehavior switch.
 */
const behaviorRegistry: Map<string, NodeBehaviorFactory> = new Map<string, NodeBehaviorFactory>([
	["script", config => new PhaseBehaviorNodeAdapter(new ScriptBehavior(), config)],
	["stage", config => new PhaseBehaviorNodeAdapter(new StageBehavior(), config)],
	["curtain", config => new PhaseBehaviorNodeAdapter(new CurtainBehavior(), config)],
	["subgraph", _config => new SubgraphNodeBehavior()],
	["loop", _config => new LoopNodeBehavior()],
]);

/**
 * Register a NodeBehavior factory for a node type.
 *
 * Re-registering an existing type overwrites the previous factory
 * (last-write-wins).
 *
 * @param type    Node type string (e.g. "script", "stage", "review").
 * @param factory Factory function that constructs a NodeBehavior.
 */
export function registerNodeBehavior(type: string, factory: NodeBehaviorFactory): void {
	behaviorRegistry.set(type, factory);
}

/**
 * Select the appropriate NodeBehavior for a node's type.
 *
 * All node types are wired through the behavior registry:
 *   - script/stage/curtain: PhaseBehaviorNodeAdapter wrapping the real
 *     ScriptBehavior/StageBehavior/CurtainBehavior implementations
 *   - custom / unregistered: CustomNodeBehavior (direct agent spawn)
 *
 * @param type — node type from GraphNode.type (undefined = "custom")
 * @param config — service configuration for PhaseBehaviorNodeAdapter construction
 */
export function selectNodeBehavior(type: string | undefined, config: NodeBehaviorFactoryConfig): NodeBehavior {
	const factory = type ? behaviorRegistry.get(type) : undefined;
	if (factory) {
		return factory(config);
	}
	return new CustomNodeBehavior();
}
