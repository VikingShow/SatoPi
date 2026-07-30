/**
 * ScriptBehavior — PhaseBehavior implementation for the Script (planning) phase.
 *
 * Wraps the ScriptManager planning logic into a pluggable behavior that
 * the orchestrator can drive through the standard PhaseBehavior lifecycle.
 *
 * Data flow:
 *   1. enter() → spawn Planner agent via AgentRuntime → create Human↔Planner channel
 *   2. handleHumanMessage() → route user message to Planner for multi-turn dialogue
 *   3. handleAgentEvent() → track planner completion / output
 *   4. checkCompletion() → detect when the plan is ready (or confirm was called)
 *   5. exit() → clean up agent handle and conversation state
 *
 * This behavior does NOT import ScriptManager — it uses AgentRuntime,
 * IrcBus, and HookPipeline directly, following the v3 unified architecture.
 */

import { logger } from "@satopi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { CommChannel } from "../../comm/comm-channel";
import type { Chapter } from "../../swarm/core/state";
import type { PhaseBehavior, PhaseCompletion, PhaseContext, PhaseEnterResult } from "./index";

// ============================================================================
// ScriptBehavior
// ============================================================================

export class ScriptBehavior implements PhaseBehavior {
	readonly phase: Chapter = "script";

	/** The Planner agent handle — the single agent for this phase. */
	#planner?: AgentSession;
	/** The human↔planner direct communication channel. */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: set during script dialogue
	#channel?: CommChannel;

	/** Full conversation history (human + assistant turns). */
	#conversation: Array<{ role: "user" | "assistant"; content: string }> = [];

	/** Set to true when the human confirms the plan. */
	#planConfirmed = false;

	/** Planner output accumulator for completion detection. */
	#plannerOutput = "";

	/** Whether the planner has finished its current turn. */
	#plannerFinished = false;

	// ==========================================================================
	// Lifecycle: enter
	// ==========================================================================

	async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
		// The MAIN model (this conversation) IS the planner. ScriptBehavior
		// does not spawn a separate Planner agent. Plan.md is captured via
		// the beforeToolCall hook in agent-session.ts. checkCompletion()
		// detects plan readiness via onPlanUpdated → #planConfirmed flag.
		logger.info("[ScriptBehavior] Script phase started — MAIN model is the planner");

		return {
			agents: [],
			channels: [],
			initialUIMessage: "Script phase: the agent will research and write a plan.",
		};
	}

	// ==========================================================================
	// Lifecycle: handleHumanMessage
	// ==========================================================================

	async handleHumanMessage(msg: { from: string; body: string }, ctx: PhaseContext): Promise<void> {
		this.#conversation.push({ role: "user", content: msg.body });

		// Check for confirm signal
		if (this.#isConfirmMessage(msg.body)) {
			this.#planConfirmed = true;
			logger.info("[ScriptBehavior] Plan confirmed by human");
			return;
		}

		// Route the message to the Planner for the next turn
		if (this.#planner && this.#planner.status === "running") {
			this.#plannerFinished = false;
			this.#plannerOutput = "";
			await this.#planner.steer(msg.body);
			logger.info("[ScriptBehavior] Routed human message to Planner", {
				bodyLength: msg.body.length,
			});
		} else if (this.#planner && this.#planner.status === "completed") {
			// Planner finished a previous turn — spawn a fresh follow-up
			// with the accumulated conversation history.
			// For simplicity, we send to the planner via AgentRuntime.
			await ctx.runtime.sendHumanMessage("planner", msg.body);
			logger.info("[ScriptBehavior] Queued follow-up message to Planner");
		}
	}

	// ==========================================================================
	// Lifecycle: handleAgentEvent
	// ==========================================================================

	async handleAgentEvent(
		event: { agentId: string; status: string; result?: unknown },
		_ctx: PhaseContext,
	): Promise<void> {
		if (event.agentId !== "planner") return;

		switch (event.status) {
			case "completed": {
				this.#plannerFinished = true;

				// Extract text from result
				const output =
					typeof event.result === "string" ? event.result : ((event.result as { output?: string })?.output ?? "");
				this.#plannerOutput = output;

				// Record the assistant turn
				if (output) {
					this.#conversation.push({ role: "assistant", content: output });
				}

				logger.info("[ScriptBehavior] Planner completed turn", {
					outputLength: output.length,
				});
				break;
			}
			case "failed": {
				this.#plannerFinished = true;
				const error =
					typeof event.result === "string"
						? event.result
						: ((event.result as { error?: string })?.error ?? "unknown error");
				logger.error("[ScriptBehavior] Planner failed", { error });
				break;
			}
			case "aborted": {
				// SatoPi: handle aborted status — the planner was terminated
				// externally (e.g. abort controller, timeout, or parent shutdown).
				this.#plannerFinished = true;
				const reason =
					typeof event.result === "string"
						? event.result
						: ((event.result as { reason?: string })?.reason ?? "aborted");
				logger.warn("[ScriptBehavior] Planner aborted", { reason });
				break;
			}
			default:
				break;
		}
	}

	// ==========================================================================
	// Lifecycle: checkCompletion
	// ==========================================================================

	async checkCompletion(_ctx: PhaseContext): Promise<PhaseCompletion | null> {
		// Completion condition 1: Human explicitly confirmed
		if (this.#planConfirmed) {
			return {
				nextPhase: "stage",
				message: "Plan confirmed. Transitioning to Stage.",
			};
		}

		// Completion condition 2: Planner output contains a completion signal
		//    and the planner has finished its current turn
		if (this.#plannerFinished && this.#plannerOutput) {
			const completionSignals = [
				/plan is complete/i,
				/plan is ready/i,
				/build plan is finalized/i,
				/ready to proceed/i,
			];

			for (const signal of completionSignals) {
				if (signal.test(this.#plannerOutput)) {
					logger.info("[ScriptBehavior] Completion signal detected in planner output");
					return {
						nextPhase: "script-confirm",
						message: "Planner has completed the plan. Please review and confirm to proceed.",
					};
				}
			}
		}

		// Still running
		return null;
	}

	// ==========================================================================
	// Lifecycle: exit
	// ==========================================================================

	async exit(): Promise<void> {
		this.#planner = undefined;
		this.#channel = undefined;
		this.#conversation = [];
		this.#planConfirmed = false;
		this.#plannerOutput = "";
		this.#plannerFinished = false;
		logger.info("[ScriptBehavior] Cleaned up");
	}

	// ==========================================================================
	// Internal helpers
	// ==========================================================================

	/** Detect common confirm-like messages from the human. */
	#isConfirmMessage(body: string): boolean {
		const trimmed = body.trim().toLowerCase();
		const confirmPatterns = [
			/^confirm$/,
			/^yes$/,
			/^y$/,
			/^proceed$/,
			/^go ahead$/,
			/^continue$/,
			/^ok$/,
			/^okay$/,
			/^approve$/,
			/^looks good$/,
			/^looks good!$/,
			/^i approve$/,
			/^i confirm$/,
		];
		return confirmPatterns.some(p => p.test(trimmed));
	}
}
