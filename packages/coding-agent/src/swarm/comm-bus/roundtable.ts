/**
 * runRoundtable — standalone pure function implementing the roundtable algorithm.
 *
 * Extracted from CommChannel for independent testability.  Conducts a
 * structured multi-round discussion among `members` on a given `topic`.
 *
 * Convergence is detected via Jaccard text similarity between consecutive
 * rounds: if the similarity stays at or above `convergenceThreshold` for
 * `convergenceStreak` consecutive rounds, the roundtable exits early.
 */

import type { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Types
// ============================================================================

export interface RoundtableConfig {
	/** Maximum number of discussion rounds (default 2). */
	rounds: number;
	/** Per-round response timeout in milliseconds (default 30_000). */
	timeoutMs: number;
	/**
	 * Jaccard similarity threshold for convergence (default 0.85).
	 * When the combined text of one round is this similar to the
	 * previous round's combined text, the round is considered "stable."
	 */
	convergenceThreshold: number;
	/**
	 * Number of consecutive rounds that must stay at or above
	 * `convergenceThreshold` before early exit (default 2).
	 */
	convergenceStreak: number;
}

export interface RoundtableResult {
	/** Whether the roundtable converged before exhausting all rounds. */
	converged: boolean;
	/** Number of rounds actually executed. */
	rounds: number;
	/** All response bodies across all rounds, in chronological order. */
	responses: string[];
	/** Response bodies from the last executed round (one per respondent). */
	finalPositions: string[];
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: RoundtableConfig = {
	rounds: 2,
	timeoutMs: 30_000,
	convergenceThreshold: 0.85,
	convergenceStreak: 2,
};

function resolveConfig(partial?: Partial<RoundtableConfig>): RoundtableConfig {
	return { ...DEFAULT_CONFIG, ...partial };
}

// ============================================================================
// Jaccard similarity
// ============================================================================

/**
 * Tokenize a string by splitting on non-alphanumeric boundaries,
 * lowercasing, and filtering out tokens of length <= 2.
 */
export function tokenize(text: string): Set<string> {
	const tokens = text
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.filter(t => t.length > 2);
	return new Set(tokens);
}

/**
 * Compute Jaccard similarity between two strings:
 *   |intersection| / |union|
 *
 * Returns 0 when both strings are effectively empty.
 */
export function jaccardSimilarity(a: string, b: string): number {
	const setA = tokenize(a);
	const setB = tokenize(b);

	if (setA.size === 0 && setB.size === 0) return 1; // both empty → identical

	const intersection = new Set([...setA].filter(t => setB.has(t)));
	const union = new Set([...setA, ...setB]);

	return intersection.size / union.size;
}

// ============================================================================
// Roundtable execution
// ============================================================================

/**
 * Run a structured multi-round discussion.
 *
 * Round 1 asks each member to state their position on `topic`.
 * Subsequent rounds feed the previous round's responses back and ask
 * members to refine or restate their positions.
 *
 * @param ircBus    - The IRC bus to use for messaging.
 * @param members   - Participant agent IDs.
 * @param topic     - The discussion topic.
 * @param partial   - Optional config overrides.
 */
export async function runRoundtable(
	ircBus: IrcBus,
	members: string[],
	topic: string,
	partial?: Partial<RoundtableConfig>,
): Promise<RoundtableResult> {
	if (members.length === 0) {
		return { converged: true, rounds: 0, responses: [], finalPositions: [] };
	}

	const config = resolveConfig(partial);
	const facilitatorId = members[0];

	const allResponses: string[] = [];
	let previousCombinedText = "";
	let convergenceCounter = 0;
	let lastRoundResponses: string[] = [];

	for (let round = 1; round <= config.rounds; round++) {
		// ── Build prompt ──────────────────────────────────────────
		let prompt: string;
		if (round === 1) {
			prompt = `State your position on: ${topic}`;
		} else {
			const previousSummary = formatPreviousRound(previousCombinedText, round);
			prompt =
				`${previousSummary}\n\n` +
				`Respond to the previous round's discussion. ` +
				`Has your position changed? State your current position on: ${topic}`;
		}

		// ── Collect responses ──────────────────────────────────────
		logRoundStart(topic, round, config.rounds);

		const responseMap = await ircBus.collectResponses(
			facilitatorId,
			members,
			{ from: facilitatorId, body: prompt },
			{},
			config.timeoutMs,
		);

		const roundResponses: string[] = [];
		for (const [, msg] of responseMap) {
			roundResponses.push(msg.body);
			allResponses.push(msg.body);
		}
		lastRoundResponses = roundResponses;

		logger.debug("CommChannel: roundtable round complete", {
			topic,
			round,
			respondentCount: roundResponses.length,
			totalMembers: members.length,
		});

		// ── Check convergence (skip round 1 — nothing to compare) ──
		if (round > 1) {
			const combinedText = roundResponses.join("\n\n---\n\n");
			const similarity = jaccardSimilarity(previousCombinedText, combinedText);

			if (similarity >= config.convergenceThreshold) {
				convergenceCounter++;
				logger.debug("CommChannel: roundtable convergence step", {
					topic,
					round,
					similarity: similarity.toFixed(3),
					streak: convergenceCounter,
					needed: config.convergenceStreak,
				});
			} else {
				convergenceCounter = 0;
			}

			if (convergenceCounter >= config.convergenceStreak && round < config.rounds) {
				logger.debug("CommChannel: roundtable converged early", {
					topic,
					round,
					similarity: similarity.toFixed(3),
				});
				return {
					converged: true,
					rounds: round,
					responses: allResponses,
					finalPositions: roundResponses,
				};
			}
		}

		// Store for next round's comparison
		previousCombinedText = roundResponses.join("\n\n---\n\n");
	}

	// Ran all rounds — check if last comparison converged
	const converged = convergenceCounter >= config.convergenceStreak;

	logger.debug("CommChannel: roundtable finished", {
		topic,
		totalRounds: config.rounds,
		converged,
		totalResponses: allResponses.length,
	});

	return {
		converged,
		rounds: config.rounds,
		responses: allResponses,
		finalPositions: lastRoundResponses,
	};
}

// ============================================================================
// Helpers
// ============================================================================

function formatPreviousRound(text: string, round: number): string {
	const truncated = text.length > 2000 ? text.slice(0, 2000) + "\n\n[...truncated]" : text;
	return `Round ${round - 1} positions:\n\n${truncated}`;
}

function logRoundStart(topic: string, round: number, total: number): void {
	logger.debug("CommChannel: starting roundtable round", {
		topic: topic.slice(0, 80),
		round,
		total,
	});
}
