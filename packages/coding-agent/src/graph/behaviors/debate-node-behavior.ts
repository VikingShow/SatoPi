/**
 * DebateNodeBehavior — NodeBehavior for the `debate` graph node.
 *
 * Runs between Script and Stage: a multi-agent roundtable critiques the
 * draft plan and converges on a refined version before execution begins.
 * The debate is driven by the injected debateRoundtableFactory (the same
 * DebateRoundtable machinery GraphRunner.debatePlan uses) and gated by
 * the `magicKeywords.swarm.enableDebate` setting — when disabled, the
 * plan passes through unchanged.
 *
 * The refined plan is persisted via the NodeContext.onPlanUpdated callback
 * (GraphRunner.onPlanUpdated), so Stage parses the debated plan.
 *
 * Lifecycle: prepare → (no-op) → execute (run the debate) → validate
 * (pass-through — GraphRunner drives gates) → cleanup.
 */

import { logger } from "@satopi/pi-utils";
import type { SwarmRuntime } from "../../swarm/core/swarm-runtime";
import type { AgentSpec } from "../agent-spec";
import type { NodeBehaviorFactoryConfig } from "../node-behavior";
import type { GateResult, GateSpec, NodeBehavior, NodeContext, NodeResult } from "../schema";

// ============================================================================
// DebateNodeBehavior
// ============================================================================

export class DebateNodeBehavior implements NodeBehavior {
	readonly name = "debate";

	/** Plan-debate factory injected by GraphRunner (debateRoundtableFactory). */
	readonly #factory: NodeBehaviorFactoryConfig["debateRoundtableFactory"];

	constructor(config: NodeBehaviorFactoryConfig) {
		this.#factory = config.debateRoundtableFactory;
	}

	// ======================================================================
	// prepare
	// ======================================================================

	async prepare(_ctx: NodeContext): Promise<AgentSpec[]> {
		return [];
	}

	// ======================================================================
	// execute
	// ======================================================================

	async execute(ctx: NodeContext, _prepared: AgentSpec[]): Promise<NodeResult> {
		const nodeId = ctx.node.id;
		const planContent = ctx.planContent ?? "";

		if (!planContent.trim()) {
			return { nodeId, success: true, output: "No plan to debate — plan passed through unchanged." };
		}

		const enabled = (ctx.settings.get("magicKeywords.swarm.enableDebate") as boolean) ?? false;
		if (!enabled || !this.#factory) {
			logger.info("[DebateNodeBehavior] Plan debate disabled — passing plan through", { nodeId });
			return { nodeId, success: true, output: "Plan debate disabled — plan passed through unchanged." };
		}

		try {
			const debate = this.#factory({
				agentCount: 2,
				maxRounds: 2,
				convergenceThreshold: 2,
				// GraphRunner always passes the full SwarmRuntime; NodeContext
				// narrows it to AgentSpawner for generic node behaviors.
				runtime: ctx.runtime as unknown as SwarmRuntime,
			});

			const result = await debate.debate(planContent, ctx.workspace, ctx.modelRegistry, ctx.settings, ctx.signal);

			if (result.refinedPlan && result.refinedPlan !== planContent) {
				ctx.onPlanUpdated?.(result.refinedPlan);
			}

			logger.info("[DebateNodeBehavior] Plan debate finished", {
				nodeId,
				converged: result.converged,
				roundCount: result.rounds.length,
			});

			return {
				nodeId,
				success: true,
				output: result.converged
					? `Plan debate converged after ${result.rounds.length} round(s) — refined plan persisted.`
					: `Plan debate completed after ${result.rounds.length} round(s) without convergence — refined plan persisted.`,
				metadata: { converged: result.converged, roundCount: result.rounds.length },
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("[DebateNodeBehavior] Plan debate failed, continuing with draft plan", {
				nodeId,
				error: message,
			});
			return { nodeId, success: true, output: `Plan debate failed (${message}) — continuing with draft plan.` };
		}
	}

	// ======================================================================
	// validate
	// ======================================================================

	async validate(result: NodeResult, gate?: GateSpec): Promise<GateResult> {
		if (!gate) {
			return { passed: true, failures: [], humanReviewRequired: false };
		}
		return {
			passed: result.success,
			failures: result.error ? [result.error] : [],
			humanReviewRequired: false,
		};
	}

	// ======================================================================
	// cleanup
	// ======================================================================

	async cleanup(_ctx: NodeContext): Promise<void> {
		// The debate spawns its own agent sessions via DebateRoundtable —
		// nothing held here to abort.
	}
}
