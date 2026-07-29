/**
 * runVote — standalone pure function implementing structured voting.
 *
 * Extracted from CommChannel for independent testability.  Broadcasts a
 * question with candidate options to all members, collects responses, and
 * tallies votes expressed as `VOTE: <candidate-id>`.
 */

import type { IrcBus } from "@satopi/pi-coding-agent/irc/bus";
import { logger } from "@satopi/pi-utils";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import type { HookContext } from "../hook-system/types";

// ============================================================================
// Types
// ============================================================================

export interface VoteResult {
	/** The candidate with the most votes. */
	winner: string;
	/**
	 * Candidates ordered by vote count (descending), excluding the winner.
	 * Used for deputy / fallback assignment.
	 */
	deputyIds: string[];
	/** Candidate → total score (same as vote count in simple plurality). */
	scores: Map<string, number>;
	/** Candidate → raw vote count. */
	tallies: Map<string, number>;
	/** Total number of votes cast. */
	totalVotes: number;
}

// ============================================================================
// Vote parsing
// ============================================================================

const VOTE_PATTERN = /VOTE:\s*(\S+)/i;

/**
 * Parse a "VOTE: <candidate-id>" line from a response body.
 * Returns the candidate ID, or null if no vote pattern is found.
 */
export function parseVote(body: string): string | null {
	const match = body.match(VOTE_PATTERN);
	return match ? match[1] : null;
}

// ============================================================================
// Vote execution
// ============================================================================

const DEFAULT_VOTE_TIMEOUT_MS = 30_000;

/**
 * Conduct a vote among `members` on a `question` with a set of `candidates`.
 *
 * Each member receives the question and candidate list and is expected to
 * reply with `VOTE: <candidate-id>`.  Responses without a valid VOTE pattern
 * are silently ignored.
 *
 * @param ircBus     - The IRC bus to use for messaging.
 * @param members    - Voter agent IDs.
 * @param question   - The question to put to voters.
 * @param candidates - Valid candidate IDs.
 * @param timeoutMs  - Per-voter response timeout (default 30_000).
 */
export async function runVote(
	ircBus: IrcBus,
	members: string[],
	question: string,
	candidates: string[],
	timeoutMs: number = DEFAULT_VOTE_TIMEOUT_MS,
	hookPipeline?: HookPipeline,
): Promise<VoteResult> {
	if (members.length === 0) {
		return {
			winner: "",
			deputyIds: [],
			scores: new Map(),
			tallies: new Map(),
			totalVotes: 0,
		};
	}

	const facilitatorId = members[0];
	const isOpen = candidates.length === 0;

	const prompt = isOpen
		? [question, "", 'Reply with "VOTE: <candidate-id>" to cast your vote.'].join("\n")
		: [
				question,
				"",
				"Candidates:",
				...candidates.map((c, i) => `  ${i + 1}. ${c}`),
				"",
				'Reply with "VOTE: <candidate-id>" to cast your vote.',
			].join("\n");

	logger.debug("CommChannel: running vote", {
		question: question.slice(0, 80),
		candidates: isOpen ? "<open>" : candidates,
		voterCount: members.length,
	});

	// Hook: vote:start
	if (hookPipeline) {
		const vtx: HookContext = { phase: undefined };
		await hookPipeline.trigger("vote:start", { agentIds: members, topic: question }, vtx);
	}

	const responseMap = await ircBus.collectResponses(
		facilitatorId,
		members,
		{ from: facilitatorId, body: prompt },
		{},
		timeoutMs,
	);

	// ── Tally ──────────────────────────────────────────────────
	const tallies = new Map<string, number>();
	if (!isOpen) {
		// Pre-populate candidates with zero counts
		for (const c of candidates) tallies.set(c, 0);
	}

	let totalVotes = 0;
	for (const [, msg] of responseMap) {
		const vote = parseVote(msg.body);
		if (!vote) {
			logger.debug("CommChannel: invalid vote ignored (no VOTE pattern)", {
				from: msg.from,
				body: msg.body.slice(0, 120),
			});
			continue;
		}
		if (!isOpen && !candidates.includes(vote)) {
			logger.debug("CommChannel: vote for unrecognised candidate ignored", {
				from: msg.from,
				parsed: vote,
			});
			continue;
		}
		tallies.set(vote, (tallies.get(vote) ?? 0) + 1);
		totalVotes++;
	}

	// Hook: vote:tally
	if (hookPipeline) {
		const vtx: HookContext = { phase: undefined };
		await hookPipeline.trigger("vote:tally", { agentIds: members, topic: question }, vtx);
	}

	// ── Rank ──────────────────────────────────────────────────
	const ranked = [...tallies.entries()].sort((a, b) => b[1] - a[1]);

	const winner = ranked[0]?.[0] ?? "";
	const deputyIds = ranked.slice(1).map(([id]) => id);

	const scores = new Map<string, number>();
	for (const [id, count] of ranked) scores.set(id, count);

	logger.debug("CommChannel: vote complete", {
		winner,
		totalVotes,
		tallies: Object.fromEntries(tallies),
	});

	// Hook: vote:result
	if (hookPipeline) {
		const vtx: HookContext = { phase: undefined };
		await hookPipeline.trigger("vote:result", { agentIds: members, topic: question }, vtx);
	}

	return { winner, deputyIds, scores, tallies, totalVotes };
}
