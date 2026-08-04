/**
 * CommChannel — Unified agent communication channel.
 *
 * Replaces ad-hoc IrcBus.sendToGroup / collectResponses patterns with a
 * single, testable abstraction.  Built directly on IrcBus (not AgentChannel)
 * to avoid circular dependencies — AgentChannel delegates to CommChannel,
 * not the other way around.
 *
 * Capabilities:
 * - send: broadcast to all members + silent CC to observers
 * - roundtable: structured multi-round discussion (delegates to runRoundtable)
 * - vote: question -> collect -> tally VOTE: patterns (delegates to runVote)
 */

import type { HookPipeline } from "../hooks/hook-pipeline";
import type { HookContext } from "../hooks/types";
import type { ActivityLogger } from "../infra/activity-logger";
import type { IrcBus } from "../irc/bus";
import { type RoundtableConfig, runRoundtable } from "./roundtable";
import { runVote } from "./vote";

// ============================================================================
// Types
// ============================================================================

export interface RoundtableOpts {
	/** Number of discussion rounds (default 2). */
	rounds?: number;
	/** Per-round response timeout in ms (default 30s). */
	timeoutMs?: number;
	/**
	 * Agent IDs participating in the roundtable.
	 * Defaults to all channel members if omitted.
	 */
	agentIds?: string[];
	/** Jaccard convergence threshold (default 0.85). */
	convergenceThreshold?: number;
	/** Consecutive rounds above threshold before early exit (default 2). */
	convergenceStreak?: number;
	/**
	 * Workflow phase to attach to roundtable hook events (defaults to "stage"
	 * inside runRoundtable). Lets phase-filtered hooks observe the roundtable
	 * lifecycle.
	 */
	phase?: string;
}

export interface RoundtableResult {
	/** Whether the roundtable converged before exhausting all rounds. */
	converged: boolean;
	/** Number of rounds actually executed. */
	rounds: number;
	/** All response strings across all rounds, in chronological order. */
	responses: string[];
	/** Response strings from the last executed round. */
	finalPositions: string[];
}

export interface VoteOpts {
	/** Agent IDs eligible to vote. */
	eligibleIds: string[];
	/** Pre-defined candidate IDs (optional — if empty, any VOTE target is accepted). */
	candidates?: string[];
	/** Vote collection timeout in ms. */
	timeoutMs: number;
}

export interface VoteResult {
	/** The candidate with the most votes. */
	winner: string;
	/** Candidates ranked by votes (descending), excluding the winner. */
	deputyIds: string[];
	/** Candidate -> vote count. */
	tallies: Map<string, number>;
	/** Candidate -> score (same as vote count in simple plurality). */
	scores: Map<string, number>;
	/** Total number of valid votes cast. */
	totalVotes: number;
}

// ============================================================================
// CommChannel
// ============================================================================

export class CommChannel {
	readonly #ircBus: IrcBus;
	readonly #members = new Set<string>();
	readonly #observers = new Set<string>();
	readonly #activityLogger?: ActivityLogger;

	readonly #hookPipeline: HookPipeline | undefined;
	readonly #afterSend?: (from: string, body: string) => void | Promise<void>;

	constructor(
		ircBus: IrcBus,
		members: string[],
		observers: string[],
		activityLogger?: ActivityLogger,
		hookPipeline?: HookPipeline,
		afterSend?: (from: string, body: string) => void | Promise<void>,
	) {
		this.#ircBus = ircBus;
		this.#activityLogger = activityLogger;
		this.#hookPipeline = hookPipeline;
		this.#afterSend = afterSend;
		for (const m of members) this.#members.add(m);
		for (const o of observers) this.#observers.add(o);
	}

	// -- accessors -------------------------------------------------------

	get members(): ReadonlySet<string> {
		return this.#members;
	}

	get observers(): ReadonlySet<string> {
		return this.#observers;
	}

	get ircBus(): IrcBus {
		return this.#ircBus;
	}

	// -- membership ------------------------------------------------------

	addMember(agentId: string): void {
		this.#members.add(agentId);
		this.send("system", `[System] ${agentId} has joined the channel`).catch(() => {});
	}

	removeMember(agentId: string): void {
		this.#members.delete(agentId);
		this.send("system", `[System] ${agentId} has left the channel`).catch(() => {});
	}

	/**
	 * Send a one-time context message to a specific member.
	 * Used when an agent joins mid-discussion — injects the existing
	 * conversation summary so the new member can catch up.
	 */
	async injectContext(agentId: string, summary: string): Promise<void> {
		await this.#ircBus.send({ from: "system", to: agentId, body: `[System] Discussion context:\n${summary}` });
	}

	addObserver(observerId: string): void {
		this.#observers.add(observerId);
	}

	removeObserver(observerId: string): void {
		this.#observers.delete(observerId);
	}

	// -- messaging -------------------------------------------------------

	/**
	 * Broadcast a message to all members (visible) and silently CC all
	 * observers (suppressRelay).  Equivalent to AgentChannel.broadcast().
	 */
	async send(from: string, body: string): Promise<void> {
		// Hook: comm:beforeBroadcast
		if (this.#hookPipeline) {
			const ctx: HookContext = { phase: undefined, agentId: from };
			await this.#hookPipeline.trigger("comm:beforeBroadcast", { from, message: body }, ctx);
		}

		this.#activityLogger?.logBroadcast(from, body);
		const memberList = [...this.#members];

		await Promise.all(memberList.map(to => this.#ircBus.send({ from, to, body })));

		// Secret CC to observers — suppressed from UI relay
		await Promise.all([...this.#observers].map(to => this.#ircBus.send({ from, to, body }, { suppressRelay: true })));

		// Persist transcript via callback (e.g. CrewManager)
		await this.#afterSend?.(from, body);

		// Hook: comm:afterBroadcast
		if (this.#hookPipeline) {
			const ctx: HookContext = { phase: undefined, agentId: from };
			await this.#hookPipeline.trigger("comm:afterBroadcast", { from, message: body }, ctx);
		}
	}

	/**
	 * Send a message to a specific subset of members (sub-group).
	 * Observers still receive a silent copy.
	 */
	async sendToGroup(from: string, body: string, memberIds: string[]): Promise<void> {
		await Promise.all(memberIds.map(to => this.#ircBus.send({ from, to, body })));

		// Observers monitor silently
		await Promise.all([...this.#observers].map(to => this.#ircBus.send({ from, to, body }, { suppressRelay: true })));
	}

	/**
	 * An observer sends a steering directive to a specific member.
	 */
	async interrupt(observerId: string, agentId: string, reason: string): Promise<void> {
		this.#activityLogger?.logSteering(observerId, agentId, reason);
		await this.#ircBus.send({
			from: observerId,
			to: agentId,
			body: `[STEERING] ${reason}`,
		});
	}

	// -- higher-level protocols ------------------------------------------

	/**
	 * Run a structured multi-round discussion among agents.
	 *
	 * Delegates to the standalone `runRoundtable()` pure function for
	 * the algorithm logic.  The first participant acts as the facilitator.
	 */
	async roundtable(topic: string, opts: RoundtableOpts): Promise<RoundtableResult> {
		const participants = opts.agentIds ?? [...this.#members];

		// Build config for the standalone function
		const config: Partial<RoundtableConfig> = {
			rounds: opts.rounds ?? 2,
			timeoutMs: opts.timeoutMs ?? 30_000,
			convergenceThreshold: opts.convergenceThreshold,
			convergenceStreak: opts.convergenceStreak,
			phase: opts.phase,
		};

		return runRoundtable(this.#ircBus, participants, topic, config, this.#hookPipeline);
	}

	/**
	 * Run a vote among eligible members.
	 *
	 * Delegates to the standalone `runVote()` pure function for parsing
	 * and tallying logic.
	 */
	async vote(question: string, opts: VoteOpts): Promise<VoteResult> {
		return runVote(this.#ircBus, opts.eligibleIds, question, opts.candidates ?? [], opts.timeoutMs);
	}
}
