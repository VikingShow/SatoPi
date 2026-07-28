/**
 * PhaseBehaviorNodeAdapter — wraps a PhaseBehavior as a NodeBehavior.
 *
 * Bridges the PhaseBehavior lifecycle (enter → handleAgentEvent →
 * checkCompletion → exit) into the graph engine's NodeBehavior contract
 * (prepare → execute → validate → cleanup).
 *
 * PhaseBehavior has no prepare step, so prepare() is a no-op. The
 * execute() method builds a PhaseContext from NodeContext + factory
 * config, calls enter(), and returns results as a NodeResult.
 * validate() delegates to checkCompletion(). cleanup() delegates
 * to exit().
 *
 * Additional handleAgentEvent() and handleHumanMessage() methods are
 * exposed for the GraphRunner to call when events arrive — these are
 * not part of the NodeBehavior interface.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSpec } from "../agent-runtime/agent-spec";
import type { PhaseBehavior, PhaseCompletion, PhaseContext, PhaseEnterResult } from "../behaviors/index";
import type { CommChannel } from "../comm-bus/comm-channel";
import type { NodeBehaviorFactoryConfig } from "./node-behavior";
import type { GateResult, GateSpec, NodeBehavior, NodeContext, NodeResult, NodeType } from "./schema";

// ============================================================================
// PhaseBehaviorNodeAdapter
// ============================================================================

/** Chapter values that map to the narrow NodeType union. */
const CHAPTER_TO_NODE_TYPE: Record<string, NodeType> = {
	script: "script",
	stage: "stage",
	curtain: "curtain",
};

/**
 * Wraps a PhaseBehavior instance as a NodeBehavior for the theatre graph engine.
 *
 * Usage:
 *   const scriptNode = new PhaseBehaviorNodeAdapter(new ScriptBehavior(), config);
 *   const prepared = await scriptNode.prepare(ctx);
 *   const result = await scriptNode.execute(ctx, prepared);
 *   const gate = await scriptNode.validate(result, { type: "script" });
 *   await scriptNode.cleanup(ctx);
 */
export class PhaseBehaviorNodeAdapter implements NodeBehavior {
	readonly name: string;
	readonly nodeType: NodeType;

	#behavior: PhaseBehavior;
	#config: NodeBehaviorFactoryConfig;
	/** PhaseContext stored from execute() for use in validate() and event delegation. */
	#phaseContext?: PhaseContext;
	/** Agent handles from the last enter() call. */
	#agents: AgentSession[] = [];
	/** Channels from the last enter() call. */
	#channels: CommChannel[] = [];

	constructor(behavior: PhaseBehavior, config: NodeBehaviorFactoryConfig) {
		this.#behavior = behavior;
		this.#config = config;
		this.name = behavior.phase;
		this.nodeType = CHAPTER_TO_NODE_TYPE[behavior.phase] ?? "custom";
	}

	// ==========================================================================
	// NodeBehavior: prepare
	// ==========================================================================

	/**
	 * No-op — PhaseBehavior has no prepare step. Returns an empty array
	 * since agents are spawned internally by the behavior's enter() method.
	 */
	async prepare(_ctx: NodeContext): Promise<AgentSpec[]> {
		return [];
	}

	// ==========================================================================
	// NodeBehavior: execute
	// ==========================================================================

	/**
	 * Builds a PhaseContext from NodeContext + constructor config, then
	 * calls PhaseBehavior.enter() to spawn agents and create channels.
	 */
	async execute(ctx: NodeContext, _prepared: AgentSpec[]): Promise<NodeResult> {
		// Build PhaseContext from NodeContext + constructor config
		const phaseCtx: PhaseContext = {
			fsm: this.#config.fsm,
			ircBus: this.#config.runtime.ircBus,
			runtime: this.#config.runtime,
			contextPipeline: this.#config.contextPipeline,
			hookPipeline: this.#config.hookPipeline,
			stateTracker: ctx.stateTracker!,
			activityLogger: ctx.activityLogger!,
			workspace: ctx.workspace,
			swarmDir: this.#config.swarmDir,
			planContent: "",
			loopConfig: this.#config.loopConfig,
			signal: ctx.signal,
		};

		this.#phaseContext = phaseCtx;

		const result: PhaseEnterResult = await this.#behavior.enter(phaseCtx);
		this.#agents = result.agents;
		this.#channels = result.channels;

		logger.info("[PhaseBehaviorNodeAdapter] Phase entered", {
			nodeType: this.nodeType,
			phase: this.#behavior.phase,
			agentCount: result.agents.length,
			channelCount: result.channels.length,
		});

		return {
			nodeId: ctx.node.id,
			success: true,
			output: `Phase ${this.#behavior.phase} entered — ${result.agents.length} agents, ${result.channels.length} channels`,
		};
	}

	// ==========================================================================
	// NodeBehavior: validate
	// ==========================================================================

	/**
	 * Delegates to PhaseBehavior.checkCompletion().
	 */
	async validate(_result: NodeResult, _gate?: GateSpec): Promise<GateResult> {
		const phaseCtx = this.#phaseContext;
		if (!phaseCtx) {
			return {
				passed: false,
				failures: ["No phase context available for validation"],
				humanReviewRequired: false,
			};
		}

		const completion: PhaseCompletion | null = await this.#behavior.checkCompletion(phaseCtx);

		if (completion === null) {
			return {
				passed: false,
				failures: ["Phase still running"],
				humanReviewRequired: false,
			};
		}

		return {
			passed: true,
			failures: [],
			humanReviewRequired: false,
		};
	}

	// ==========================================================================
	// NodeBehavior: cleanup
	// ==========================================================================

	async cleanup(_ctx: NodeContext): Promise<void> {
		await this.#behavior.exit();
		this.#phaseContext = undefined;
		this.#agents = [];
		this.#channels = [];
		logger.info("[PhaseBehaviorNodeAdapter] Cleaned up", {
			nodeType: this.nodeType,
			phase: this.#behavior.phase,
		});
	}

	// ==========================================================================
	// Event delegation (called by GraphRunner, not part of NodeBehavior)
	// ==========================================================================

	async handleAgentEvent(event: { agentId: string; status: string; result?: unknown }): Promise<void> {
		const phaseCtx = this.#phaseContext;
		if (!phaseCtx) return;
		await this.#behavior.handleAgentEvent(event, phaseCtx);
	}

	async handleHumanMessage(msg: { from: string; body: string }): Promise<void> {
		const phaseCtx = this.#phaseContext;
		if (!phaseCtx) return;
		await this.#behavior.handleHumanMessage(msg, phaseCtx);
	}
}
