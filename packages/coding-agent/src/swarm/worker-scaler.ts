/**
 * WorkerScaler — pure decision logic for dynamic worker-count scaling (GAP 2).
 *
 * Extracted from LoopController.runLoop so the voting/median math can be unit
 * tested in isolation. This module is intentionally SIDE-EFFECT FREE: it only
 * computes a signed delta from cloner suggestions. The controller remains
 * responsible for the actual roster mutation (add/remove workers) and for
 * clamping the delta to [min, max] while spawning/despawning.
 *
 * Decision rules (unchanged from the original inline logic):
 *  1. Gate: only consider scaling when at least ceil(clonerCount / 2) cloners
 *     submitted a suggestion.
 *  2. Fast scaling: a super-majority (>= ceil(2/3 * clonerCount)) in one
 *     direction AND |medianDelta| >= 2 → jump by the median delta.
 *  3. Conservative up: simple majority of up-votes → +1.
 *  4. Conservative down: simple majority of down-votes AND above min → -1.
 *  5. Otherwise → 0 (no change).
 */

export interface ScaleDeltaParams {
	/** Per-cloner suggested worker-count deltas (may be empty). */
	suggestions: number[];
	/** Number of cloners eligible to vote. */
	clonerCount: number;
	/** Current number of active workers. */
	currentWorkerCount: number;
	/** Minimum allowed workers. */
	min: number;
}

/**
 * Compute the signed worker-count delta from cloner suggestions.
 * Returns 0 when no scaling should occur. Does NOT clamp to max — the caller
 * clamps against `max - currentWorkerCount` when adding, and against
 * `currentWorkerCount - min` when removing.
 */
export function computeScaleDelta(params: ScaleDeltaParams): number {
	const { suggestions, clonerCount, currentWorkerCount, min } = params;

	// Gate: not enough cloners voted.
	if (suggestions.length < Math.ceil(clonerCount / 2)) return 0;

	const upVotes = suggestions.filter((d) => d > 0).length;
	const downVotes = suggestions.filter((d) => d < 0).length;
	const superMajority = Math.ceil((clonerCount * 2) / 3);
	const majority = Math.ceil(clonerCount / 2);

	// Median of a sorted COPY (never mutate the caller's array).
	const sorted = [...suggestions].sort((a, b) => a - b);
	const medianDelta = sorted[Math.floor(sorted.length / 2)] ?? 0;

	// Fast scaling: super-majority + strong signal.
	if ((upVotes >= superMajority || downVotes >= superMajority) && Math.abs(medianDelta) >= 2) {
		return medianDelta;
	}
	// Conservative up.
	if (upVotes >= majority) return 1;
	// Conservative down (only when above the floor).
	if (downVotes >= majority && currentWorkerCount > min) return -1;

	return 0;
}
