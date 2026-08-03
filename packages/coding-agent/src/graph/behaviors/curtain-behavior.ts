/**
 * CurtainBehavior — PhaseBehavior implementation for the Curtain (reporting) phase.
 *
 * Wraps the CurtainRunner reporting logic into a pluggable behavior that
 * the orchestrator can drive through the standard PhaseBehavior lifecycle.
 *
 * Data flow:
 *   1. enter() → elect reporter via vote → spawn reporter + reflector agents
 *   2. handleHumanMessage() → human applaud / feedback
 *   3. handleAgentEvent() → track reporter + reflector completion
 *   4. checkCompletion() → detect when report is done and human has applauded
 *   5. exit() → clean up agent handles and channel
 *
 * This behavior does NOT import CurtainRunner — it uses the runtime's spawn,
 * IrcBus, and HookPipeline directly.
 */

import { logger } from "@satopi/pi-utils";
import type { CommChannel } from "../../comm/comm-channel";
import type { AgentSession } from "../../session/agent-session";
import type { Chapter } from "../../swarm/core/state";
import type { PhaseBehavior, PhaseCompletion, PhaseContext, PhaseEnterResult } from "./index";

// ============================================================================
// CurtainBehavior
// ============================================================================

export class CurtainBehavior implements PhaseBehavior {
	readonly phase: Chapter = "curtain";

	/** Reporter agent handle (elected from stage agents). */
	#reporter?: AgentSession;

	/** Reflector agent handle (lessons learned). */
	#reflector?: AgentSession;

	/** Both spawned agent handles. */
	#agents: AgentSession[] = [];
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: set during reporter election
	#electionChannel?: CommChannel;

	/** Raw dissatisfaction feedback text (forwarded to ScriptBehavior on re-entry). */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: set on human dissatisfaction
	#dissatisfactionFeedback = "";

	/** Whether the human has applauded / acknowledged the report. */
	#humanApplauded = false;

	/** Whether the human expressed dissatisfaction (triggers re-plan path). */
	#humanDissatisfied = false;

	/** Whether the reporter has finished. */
	#reporterCompleted = false;

	/** Whether the reflector has finished. */
	#reflectorCompleted = false;

	/** The elected reporter agent ID. */
	#electedReporterId?: string;

	// ==========================================================================
	// Lifecycle: enter
	// ==========================================================================

	async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
		const channels: CommChannel[] = [];

		// 1. Build list of eligible agent IDs from StateTracker
		//    (agents that participated in the stage phase)
		const agentStates = ctx.stateTracker.state.agents;
		const agentIds = Object.keys(agentStates);

		let reporterId: string;

		if (agentIds.length === 0) {
			// No agents in state — fall back to spawning a default reporter
			logger.warn("[CurtainBehavior] No agents in state, using default reporter");
			reporterId = "reporter";
		} else if (agentIds.length === 1) {
			// Only one agent — skip voting, use it directly
			reporterId = agentIds[0];
			logger.info("[CurtainBehavior] Single agent, skipping vote", {
				reporterId,
			});
		} else {
			// 2. Elect reporter via vote
			const voteChannel = ctx.ircBus.groupChannel("election", agentIds, ctx.activityLogger);
			this.#electionChannel = voteChannel;
			channels.push(voteChannel);

			try {
				const voteResult = await voteChannel.vote(
					"Who should report to the human? Consider: most work completed, highest quality output, clearest communication.",
					{
						eligibleIds: agentIds,
						timeoutMs: 15_000,
					},
				);

				reporterId = voteResult.winner;

				logger.info("[CurtainBehavior] Reporter elected via vote", {
					winner: voteResult.winner,
					totalVotes: voteResult.totalVotes,
					deputyIds: voteResult.deputyIds,
				});

				// Log the nomination
				const voteRecord: Record<string, string[]> = {};
				for (const [candidate, tally] of voteResult.tallies) {
					voteRecord[candidate] = Array(tally).fill("vote");
				}
				await ctx.activityLogger.logNomination(1, voteResult.winner, voteRecord);
			} catch (err) {
				// Vote failed — fall back to best-scoring agent
				const best = ctx.stateTracker.getBestAgent();
				reporterId = best ?? agentIds[0] ?? "reporter";
				logger.warn("[CurtainBehavior] Vote failed, falling back to best agent", {
					reporterId,
					error: String(err),
				});
			}
		}

		this.#electedReporterId = reporterId;

		// 3. Spawn reporter + reflector in parallel
		const agentSpecs = [
			// Reporter: reuses an existing agent identity to report what was built
			{
				id: reporterId,
				role: "reporter",
				roleSource: "library" as const,
				task:
					"Summarize the completed build for the user. " +
					"Report what was built, key files created/modified, " +
					"test results, and any issues or remaining work.",
				phase: this.phase,
			},
			// Reflector: analyzes the run and extracts lessons learned
			{
				id: "reflector",
				role: "reflector",
				roleSource: "library" as const,
				task:
					"Analyze the completed swarm run and extract lessons learned. " +
					"What went well? What could be improved? " +
					"Are there patterns that should be reused or avoided in future runs?",
				phase: this.phase,
			},
		];

		const sessions = await ctx.runtime.spawn(agentSpecs);

		// The first session may be the reporter (if the ID matched an existing agent
		// already in the state) or may be a new agent. Track both separately.
		for (const session of sessions) {
			if (session.role === "reporter" || session.id === reporterId) {
				this.#reporter = session;
			} else if (session.role === "reflector" || session.id === "reflector") {
				this.#reflector = session;
			}
		}

		this.#agents = sessions;

		logger.info("[CurtainBehavior] Reporter + Reflector spawned", {
			reporterId: this.#reporter?.id,
			reflectorId: this.#reflector?.id,
		});

		return {
			agents: sessions,
			channels,
			initialUIMessage:
				"Curtain phase: reporter is summarizing the build and reflector is analyzing lessons learned.",
		};
	}

	// ==========================================================================
	// Lifecycle: handleHumanMessage
	// ==========================================================================

	async handleHumanMessage(
		msg: { from: string; body: string; type?: "applaud" | "dissatisfied" | "feedback" | "steer" },
		_ctx: PhaseContext,
	): Promise<void> {
		const trimmed = msg.body.trim().toLowerCase();

		// Detect applaud / acknowledgment signals
		const applaudPatterns = [
			/^applaud$/,
			/^approve$/,
			/^done$/,
			/^good$/,
			/^thanks$/,
			/^thank you$/,
			/^great$/,
			/^awesome$/,
			/^nice$/,
			/^looks good$/,
			/^looks good!$/,
			/^well done$/,
			/^perfect$/,
			/^love it$/,
			/^:+\)/, // :)
			/^👍/,
		];

		if (applaudPatterns.some(p => p.test(trimmed))) {
			this.#humanApplauded = true;
			logger.info("[CurtainBehavior] Human applauded");
			return;
		}

		if (msg.type === "dissatisfied") {
			this.#humanDissatisfied = true;
			this.#dissatisfactionFeedback = msg.body;
			return;
		}

		if (this.#reporter && this.#reporter.status === "running") {
			await this.#reporter
				.steer(msg.body)
				.catch(err => logger.error("Reporter steer failed", { error: String(err) }));
		}
	}

	// ==========================================================================
	// Lifecycle: handleAgentEvent
	// ==========================================================================

	async handleAgentEvent(
		event: { agentId: string; status: string; result?: unknown },
		_ctx: PhaseContext,
	): Promise<void> {
		const isReporter = event.agentId === this.#reporter?.id || event.agentId === this.#electedReporterId;
		const isReflector = event.agentId === this.#reflector?.id || event.agentId === "reflector";

		switch (event.status) {
			case "completed": {
				if (isReporter) {
					this.#reporterCompleted = true;
					logger.info("[CurtainBehavior] Reporter completed");
				} else if (isReflector) {
					this.#reflectorCompleted = true;
					logger.info("[CurtainBehavior] Reflector completed");
				}
				break;
			}
			case "failed": {
				const error =
					typeof event.result === "string"
						? event.result
						: ((event.result as { error?: string })?.error ?? "unknown error");

				if (isReporter) {
					// Reporter failed — still mark as "completed" for transition
					// purposes since we can't recover
					this.#reporterCompleted = true;
					logger.error("[CurtainBehavior] Reporter failed", { error });
				} else if (isReflector) {
					this.#reflectorCompleted = true;
					logger.error("[CurtainBehavior] Reflector failed", { error });
				}
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
		// Both reporter and reflector must complete
		if (!this.#reporterCompleted || !this.#reflectorCompleted) {
			return null;
		}

		// Dissatisfaction path — send human back to Script phase for re-planning.
		// The feedback text is embedded in the message so ScriptBehavior can
		// inject it as an initial prompt when the Planner re-enters.
		if (this.#humanDissatisfied) {
			return {
				nextPhase: "script",
				needConfirmRetry: true,
				message: "User expressed dissatisfaction. Confirm re-planning?",
			};
		}

		// If human has already applauded, transition to idle
		if (this.#humanApplauded) {
			return {
				nextPhase: "idle",
				message: "Curtain complete. Returning to idle.",
			};
		}

		// Report is ready but human hasn't applauded yet — signal need for applaud
		return {
			nextPhase: "idle",
			needApplaud: true,
			message: "Reporter and reflector have finished. Please review and applaud to complete.",
		};
	}

	// ==========================================================================
	// Lifecycle: exit
	// ==========================================================================

	async exit(): Promise<void> {
		// Abort any still-running agents
		for (const agent of this.#agents) {
			if (agent.status === "running") {
				try {
					agent.abort({ reason: "phase exit" });
				} catch {
					// Best-effort abort
				}
			}
		}

		this.#reporter = undefined;
		this.#reflector = undefined;
		this.#agents = [];
		this.#electionChannel = undefined;
		this.#humanApplauded = false;
		this.#humanDissatisfied = false;
		this.#dissatisfactionFeedback = "";
		this.#reporterCompleted = false;
		this.#reflectorCompleted = false;
		this.#electedReporterId = undefined;

		logger.info("[CurtainBehavior] Cleaned up");
	}
}
