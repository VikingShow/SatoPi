/**
 * PhaseBehaviorNodeAdapter — wraps a PhaseBehavior as a NodeBehavior.
 *
 * Bridges the PhaseBehavior lifecycle (enter → handleAgentEvent →
 * checkCompletion → exit) into the graph engine's NodeBehavior contract
 * (prepare → execute → validate → cleanup).
 *
 * PhaseBehavior has no prepare step, so prepare() is a no-op. The
 * execute() method calls enter() and returns the spawned agents and
 * channels. validate() delegates to checkCompletion(). cleanup()
 * delegates to exit().
 *
 * Additional handleAgentEvent() and handleHumanMessage() methods are
 * exposed for the GraphRunner to call when events arrive — these are
 * not part of the NodeBehavior interface.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentHandle } from "../agent-runtime/agent-handle";
import type { CommChannel } from "../comm-bus/comm-channel";
import type { Chapter } from "../core/state";
import type {
	PhaseBehavior,
	PhaseCompletion,
	PhaseContext,
	PhaseEnterResult,
} from "../behaviors/index";
import type { GateSpec, NodeType } from "./schema";

// ============================================================================
// Stub types (will migrate to graph/schema.ts or node-behavior.ts)
// ============================================================================

/** Context passed to each NodeBehavior method by the graph engine. */
export interface NodeContext {
	/** Stable identifier for this node in the graph. */
	nodeId: string;
	/** PhaseContext bridging to the existing swarm infrastructure. */
	phaseContext: PhaseContext;
	/** AbortSignal for cooperative cancellation. */
	signal: AbortSignal;
}

/** Result of prepare() — carries prepared state forwarded to execute(). */
export interface PreparedNode {
	nodeId: string;
}

/** Result returned by execute(). */
export interface NodeResult {
	nodeId: string;
	/** Agent handles spawned during execute(). */
	agents: AgentHandle[];
	/** Communication channels created during execute(). */
	channels: CommChannel[];
	/** Optional structured output from the execution. */
	output?: unknown;
}

/** Result returned by validate(). */
export interface GateResult {
	/** Whether the gate condition was satisfied. */
	passed: boolean;
	/** Human-readable status or transition message. */
	message?: string;
}

/**
 * NodeBehavior — contract every graph node must implement.
 *
 * Lifecycle: prepare → execute → validate → cleanup.
 * Defined here as a stub; will migrate to graph/node-behavior.ts.
 */
export interface NodeBehavior {
	/** The theatre phase this node corresponds to. */
	readonly nodeType: NodeType;

	/** Validate inputs and allocate resources before execution. */
	prepare(ctx: NodeContext): Promise<PreparedNode>;

	/** Run the node: spawn agents, poll events, drive to completion. */
	execute(ctx: NodeContext, prepared: PreparedNode): Promise<NodeResult>;

	/** Check whether the gate condition is satisfied. */
	validate(result: NodeResult, gate: GateSpec): Promise<GateResult>;

	/** Release resources after the node completes or is aborted. */
	cleanup(ctx: NodeContext): Promise<void>;
}

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
 *   const scriptNode = new PhaseBehaviorNodeAdapter(new ScriptBehavior());
 *   const prepared = await scriptNode.prepare(ctx);
 *   const result = await scriptNode.execute(ctx, prepared);
 *   const gate = await scriptNode.validate(result, { type: "script" });
 *   await scriptNode.cleanup(ctx);
 */
export class PhaseBehaviorNodeAdapter implements NodeBehavior {
	readonly nodeType: NodeType;

	#behavior: PhaseBehavior;
	/** PhaseContext stored from execute() for use in validate() and event delegation. */
	#phaseContext?: PhaseContext;
	/** Agent handles from the last enter() call. */
	#agents: AgentHandle[] = [];
	/** Channels from the last enter() call. */
	#channels: CommChannel[] = [];

	constructor(behavior: PhaseBehavior) {
		this.#behavior = behavior;
		this.nodeType = CHAPTER_TO_NODE_TYPE[behavior.phase] ?? "custom";
	}

	// ==========================================================================
	// NodeBehavior: prepare
	// ==========================================================================

	/**
	 * No-op — PhaseBehavior has no prepare step.
	 * Returns a minimal PreparedNode carrying only the nodeId.
	 */
	async prepare(ctx: NodeContext): Promise<PreparedNode> {
		return { nodeId: ctx.nodeId };
	}

	// ==========================================================================
	// NodeBehavior: execute
	// ==========================================================================

	/**
	 * Calls PhaseBehavior.enter() to spawn agents and create channels.
	 * Stores the PhaseContext for later use by validate() and event delegates.
	 */
	async execute(ctx: NodeContext, _prepared: PreparedNode): Promise<NodeResult> {
		this.#phaseContext = ctx.phaseContext;

		const result: PhaseEnterResult = await this.#behavior.enter(ctx.phaseContext);
		this.#agents = result.agents;
		this.#channels = result.channels;

		logger.info("[PhaseBehaviorNodeAdapter] Phase entered", {
			nodeType: this.nodeType,
			phase: this.#behavior.phase,
			agentCount: result.agents.length,
			channelCount: result.channels.length,
		});

		return {
			nodeId: ctx.nodeId,
			agents: result.agents,
			channels: result.channels,
		};
	}

	// ==========================================================================
	// NodeBehavior: validate
	// ==========================================================================

	/**
	 * Delegates to PhaseBehavior.checkCompletion().
	 *
	 * Returns { passed: true } when the phase signals completion via a
	 * non-null PhaseCompletion. Returns { passed: false } while the phase
	 * is still running (checkCompletion returns null).
	 */
	async validate(result: NodeResult, gate: GateSpec): Promise<GateResult> {
		const phaseCtx = this.#phaseContext;
		if (!phaseCtx) {
			return { passed: false, message: "No phase context available for validation" };
		}

		const completion: PhaseCompletion | null =
			await this.#behavior.checkCompletion(phaseCtx);

		if (completion === null) {
			return { passed: false, message: "Phase still running" };
		}

		return {
			passed: true,
			message: completion.message ?? `Phase complete, next: ${completion.nextPhase}`,
		};
	}

	// ==========================================================================
	// NodeBehavior: cleanup
	// ==========================================================================

	/**
	 * Calls PhaseBehavior.exit() to release agent handles, channels, and
	 * internal state. Resets all adapter state.
	 */
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

	/**
	 * Delegate agent lifecycle events to the wrapped PhaseBehavior.
	 *
	 * Called by the GraphRunner when an agent status changes. The
	 * PhaseBehavior's handleAgentEvent implementation handles
	 * coordination logic: conflict detection, task re-assignment,
	 * completion tracking.
	 */
	async handleAgentEvent(
		event: { agentId: string; status: string; result?: unknown },
	): Promise<void> {
		const phaseCtx = this.#phaseContext;
		if (!phaseCtx) return;
		await this.#behavior.handleAgentEvent(event, phaseCtx);
	}

	/**
	 * Delegate human messages to the wrapped PhaseBehavior.
	 *
	 * Called by the GraphRunner when a human message arrives through
	 * the CommBus. The PhaseBehavior routes the message to the
	 * appropriate agent(s).
	 */
	async handleHumanMessage(msg: { from: string; body: string }): Promise<void> {
		const phaseCtx = this.#phaseContext;
		if (!phaseCtx) return;
		await this.#behavior.handleHumanMessage(msg, phaseCtx);
	}
}
