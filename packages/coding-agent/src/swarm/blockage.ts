/**
 * Blockage decision — pure logic extracted from LoopController.#detectBlockage.
 *
 * Decides WHETHER the loop is stuck (and why); the controller keeps the async
 * "pause and await user resolution" mechanics. Keeping the decision pure makes
 * the stagnation / crash-deadlock thresholds trivially unit-testable.
 */

/** Default thresholds (mirrors the previous inline constants). */
export const STAGNATION_THRESHOLD = 3;
export const CRASH_THRESHOLD = 3;

export interface BlockageInput {
	/** Consecutive rounds with stagnant cloner findings. */
	stagnationCount: number;
	/** Per-worker crash counts. */
	workerCrashCounts: Record<string, number>;
	/** Override the stagnation threshold (defaults to STAGNATION_THRESHOLD). */
	stagnationThreshold?: number;
	/** Override the crash threshold (defaults to CRASH_THRESHOLD). */
	crashThreshold?: number;
}

export interface BlockageDecision {
	/** True when the loop should block and await user resolution. */
	blocked: boolean;
	/** Which condition triggered the block (undefined when not blocked). */
	cause?: "stagnation" | "deadlock";
	/** Human-readable reason (undefined when not blocked). */
	reason?: string;
}

/**
 * Evaluate whether the loop is blocked.
 *
 * Stagnation takes precedence over deadlock in the reason message (matching
 * the original behavior where `stagnated` was checked first).
 */
export function evaluateBlockage(input: BlockageInput): BlockageDecision {
	const stagnationThreshold = input.stagnationThreshold ?? STAGNATION_THRESHOLD;
	const crashThreshold = input.crashThreshold ?? CRASH_THRESHOLD;

	const stagnated = input.stagnationCount >= stagnationThreshold;
	const deadlocked = Object.values(input.workerCrashCounts).some((c) => c >= crashThreshold);

	if (!stagnated && !deadlocked) {
		return { blocked: false };
	}

	if (stagnated) {
		return {
			blocked: true,
			cause: "stagnation",
			reason: `Cloner findings have stagnated for ${input.stagnationCount} consecutive iterations`,
		};
	}
	return {
		blocked: true,
		cause: "deadlock",
		reason: `Worker crash deadlock detected (a worker crashed ${crashThreshold}+ times)`,
	};
}
