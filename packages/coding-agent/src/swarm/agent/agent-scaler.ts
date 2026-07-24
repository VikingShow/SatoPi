/**
 * AgentScaler — pure decision logic for dynamic agent-count scaling (GAP 2).
 *
 * Extracted from LoopController.runLoop so the voting/median math can be unit
 * tested in isolation. This module is intentionally SIDE-EFFECT FREE: it only
 * computes a signed delta from voter suggestions. The controller remains
 * responsible for the actual roster mutation (add/remove workers) and for
 * clamping the delta to [min, max] while spawning/despawning.
 *
 * Decision rules (unchanged from the original inline logic):
 *  1. Gate: only consider scaling when at least ceil(voterCount / 2) voters
 *     submitted a suggestion.
 *  2. Fast scaling: a super-majority (>= ceil(2/3 * voterCount)) in one
 *     direction AND |medianDelta| >= 2 → jump by the median delta.
 *  3. Conservative up: simple majority of up-votes → +1.
 *  4. Conservative down: simple majority of down-votes AND above min → -1.
 *  5. Otherwise → 0 (no change).
 */

export interface ScaleDeltaParams {
	/** Per-voter suggested agent-count deltas (may be empty). */
	suggestions: number[];
	/** Number of voters eligible to vote. */
	voterCount: number;
	/** Current number of active agents. */
	currentAgentCount: number;
	/** Minimum allowed agents. */
	min: number;
	/**
	 * Optional baseline agent count from TaskComplexityAnalyzer.
	 * When set, the scaler biases toward this count: up-scaling beyond
	 * baseline requires super-majority; down-scaling below it is resisted.
	 */
	baselineAgentCount?: number;
}

/**
 * Compute the signed agent-count delta from voter suggestions.
 * Returns 0 when no scaling should occur. Does NOT clamp to max — the caller
 * clamps against `max - currentAgentCount` when adding, and against
 * `currentAgentCount - min` when removing.
 */
export function computeScaleDelta(params: ScaleDeltaParams): number {
	const { suggestions, voterCount, currentAgentCount, min, baselineAgentCount } = params;

	// Gate: not enough voters voted.
	if (suggestions.length < Math.ceil(voterCount / 2)) return 0;

	const upVotes = suggestions.filter((d) => d > 0).length;
	const downVotes = suggestions.filter((d) => d < 0).length;
	const superMajority = Math.ceil((voterCount * 2) / 3);
	const majority = Math.ceil(voterCount / 2);

	// Median of a sorted COPY (never mutate the caller's array).
	const sorted = [...suggestions].sort((a, b) => a - b);
	const medianDelta = sorted[Math.floor(sorted.length / 2)] ?? 0;

	// Baseline bias: when below the TaskComplexityAnalyzer-recommended count,
	// up-scaling is easier (simple majority) and down-scaling harder (needs super-majority).
	if (baselineAgentCount !== undefined && currentAgentCount < baselineAgentCount) {
		// Below baseline: resist down-scaling, encourage up-scaling
		if (upVotes >= majority) return Math.max(1, medianDelta);
		if (downVotes >= superMajority && currentAgentCount > min) return -1;
		return 0;
	}

	// Fast scaling: super-majority + strong signal.
	if ((upVotes >= superMajority || downVotes >= superMajority) && Math.abs(medianDelta) >= 2) {
		return medianDelta;
	}
	// Conservative up.
	if (upVotes >= majority) return 1;
	// Conservative down (only when above the floor).
	if (downVotes >= majority && currentAgentCount > min) return -1;

	return 0;
}
