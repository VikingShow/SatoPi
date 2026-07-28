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

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { AgentRuntime } from "../agent-runtime";
import type { AgentSpec } from "../agent-runtime/agent-spec";
import { CurtainBehavior } from "../behaviors/curtain-behavior";
import { ScriptBehavior } from "../behaviors/script-behavior";
import { StageBehavior } from "../behaviors/stage-behavior";
import type { ContextPipeline } from "../context-manager/context-pipeline";
import type { LoopSwarmConfig } from "../core/schema";
import type { WorkflowFsm } from "../core/workflow-fsm";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import { createStageController, type StageResult } from "../stage/stage-controller";
import { PhaseBehaviorNodeAdapter } from "./phase-behavior-adapter";
import type { GateResult, GateSpec, NodeBehavior, NodeContext, NodeResult } from "./schema";

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
// StageNodeBehavior — Drives real parallel worker agents via StageController
// ============================================================================

/**
 * Stage (execution) phase behavior.
 *
 * Parses the plan from the upstream script node, builds a StageController
 * with real parallel worker agents, and collects per-agent results.
 *
 * Falls back to CustomNodeBehavior when roleAssetManager or profileRegistry
 * are not available in the NodeContext.
 */
export class StageNodeBehavior implements NodeBehavior {
	readonly name = "stage";

	#delegate = new CustomNodeBehavior();

	async prepare(ctx: NodeContext): Promise<AgentSpec[]> {
		if (!(ctx.roleAssetManager && ctx.profileRegistry && ctx.stateTracker && ctx.activityLogger)) {
			return this.#delegate.prepare(ctx);
		}
		// StageController manages its own agent creation — no pre-spawn needed.
		return [];
	}

	async execute(ctx: NodeContext, _prepared: AgentSpec[]): Promise<NodeResult> {
		if (!(ctx.roleAssetManager && ctx.profileRegistry && ctx.stateTracker && ctx.activityLogger)) {
			logger.info("[StageNodeBehavior] Services unavailable, delegating to CustomNodeBehavior");
			return this.#delegate.execute(ctx, _prepared);
		}

		const planContent = this.#extractPlanContent(ctx);
		const loopConfig = this.#buildLoopConfig();

		logger.info("[StageNodeBehavior] Creating StageController", {
			nodeId: ctx.node.id,
			planLength: planContent.length,
		});

		const stageController = createStageController({
			workspace: ctx.workspace,
			swarmName: `graph-${ctx.node.id}`,
			planContent,
			loopConfig,
			stateTracker: ctx.stateTracker!,
			activityLogger: ctx.activityLogger!,
			modelRegistry: ctx.modelRegistry,
			settings: ctx.settings,
			signal: ctx.signal,
			profileRegistry: ctx.profileRegistry!,
			roleAssetManager: ctx.roleAssetManager!,
			runtime: ctx.runtime,
			ircBus: ctx.runtime.ircBus,
		});

		try {
			const result: StageResult = await stageController.run();

			logger.info("[StageNodeBehavior] Stage complete", {
				nodeId: ctx.node.id,
				status: result.status,
				agentCount: result.agents.length,
				tasksCompleted: result.taskProgress.completed,
			});

			return this.#toNodeResult(ctx.node.id, result);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("[StageNodeBehavior] Stage failed", { nodeId: ctx.node.id, error: msg });
			return { nodeId: ctx.node.id, success: false, error: msg };
		}
	}

	async validate(result: NodeResult, gate?: GateSpec): Promise<GateResult> {
		return this.#delegate.validate(result, gate);
	}

	async cleanup(ctx: NodeContext): Promise<void> {
		return this.#delegate.cleanup(ctx);
	}

	// ── private helpers ───────────────────────────────────────────────────

	#extractPlanContent(ctx: NodeContext): string {
		for (const [, output] of Object.entries(ctx.upstreamOutputs)) {
			if (output.result && typeof output.result === "string") {
				return output.result;
			}
			if (output.summary) {
				return output.summary;
			}
		}
		logger.warn("[StageNodeBehavior] No plan content found in upstream outputs, using empty plan");
		return "# Plan\n\nNo plan content available from upstream script node.";
	}

	#buildLoopConfig(): LoopSwarmConfig {
		return {
			maxIterations: 5,
			autoRetry: true,
			humanEscalation: true,
			agents: {
				initial: 4,
				min: 1,
				max: 12,
				auto: true,
				maxRounds: 5,
				roundsConvergenceThreshold: 3,
			},
			debate: {
				enabled: true,
				maxRounds: 2,
			},
			planDebate: {
				enabled: true,
				agentCount: 2,
				maxRounds: 3,
				convergenceThreshold: 2,
			},
			convergenceThreshold: 2,
			iterationTimeoutMs: 300_000,
			enableDeliberation: true,
		};
	}

	#toNodeResult(nodeId: string, result: StageResult): NodeResult {
		const agentResults: Array<{ agentId: string; output: string; error?: string }> = [];
		for (const [agentId, singles] of result.agentResults) {
			for (const s of singles) {
				agentResults.push({
					agentId,
					output: s.output ?? "",
					error: s.error,
				});
			}
		}

		return {
			nodeId,
			success: result.status === "completed",
			output: `Stage ${result.status} — ${result.taskProgress.completed}/${result.taskProgress.total} tasks by ${result.agents.length} agents`,
			error: result.errors.length > 0 ? result.errors.join("; ") : undefined,
			agentResults,
		};
	}
}

// ============================================================================
// Factory
// ============================================================================

// ============================================================================
// NodeBehaviorFactoryConfig — shared config for behavior construction
// ============================================================================

/**
 * Configuration bag passed to NodeBehavior factories so Script, Stage, and
 * Curtain behaviors can wrap real PhaseBehavior implementations through
 * PhaseBehaviorNodeAdapter instead of using stubs.
 */
export interface NodeBehaviorFactoryConfig {
	runtime: AgentRuntime;
	fsm: WorkflowFsm;
	hookPipeline: HookPipeline;
	contextPipeline: ContextPipeline;
	workspace: string;
	swarmDir: string;
	loopConfig: LoopSwarmConfig;
}

/**
 * Select the appropriate NodeBehavior for a node's type.
 *
 * All node types are wired through selectNodeBehavior():
 *   - custom: CustomNodeBehavior (direct agent spawn)
 *   - script/stage/curtain: PhaseBehaviorNodeAdapter wrapping the real
 *     ScriptBehavior/StageBehavior/CurtainBehavior implementations
 *
 * @param type — node type from GraphNode.type (undefined = "custom")
 * @param config — service configuration for PhaseBehaviorNodeAdapter construction
 */
export function selectNodeBehavior(type: string | undefined, config: NodeBehaviorFactoryConfig): NodeBehavior {
	switch (type) {
		case "script":
			return new PhaseBehaviorNodeAdapter(new ScriptBehavior(), config);
		case "stage":
			return new PhaseBehaviorNodeAdapter(new StageBehavior(), config);
		case "curtain":
			return new PhaseBehaviorNodeAdapter(new CurtainBehavior(), config);
		default:
			return new CustomNodeBehavior();
	}
}
