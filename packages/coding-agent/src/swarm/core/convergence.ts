/**
 * Convergence & summary utilities — pure functions extracted from
 * LoopController.runLoop for isolated unit testing.
 *
 * These are all SIDE-EFFECT FREE string/similarity helpers used to decide
 * whether the swarm has converged:
 *    structured sections out of a worker's free-form output.
 *  - jaccardSimilarity / findingsSimilarity: measure how much two rounds'
 *    findings overlap (the fallback convergence signal when no reviewer JSON).
 */

/** Structured round summary produced by the elected reviewer. */
export interface RoundSummaryData {
	round: number;
	reviewer: string;
	accomplished: Record<string, string>;
	issues: Array<{
		severity: "blocker" | "major" | "minor";
		agentIds: string[];
		file?: string;
		description: string;
		resolution?: string;
	}>;
	remaining: string[];
	recommended_division: Record<string, string>;
	convergence_opinion: "converging" | "diverging" | "stalled";
}

/**
 * Extract the `## Round Summary` section from a worker's output.
 * Falls back to the first 2000 chars when no summary section is found.
 */
export function extractRoundSummary(output: string): string {
	const match = output.match(/## Round Summary\n([\s\S]*?)(?=\n## |\n```|\n---\n|---|\n\*\*\*|\n___|$)/);
	return match?.[1]?.trim() || output.slice(0, 2000);
}

/** Jaccard similarity between two arrays of tokens. Returns 0–1. */
export function jaccardSimilarity(a: string[], b: string[]): number {
	const setA = new Set(a);
	const setB = new Set(b);
	if (setA.size === 0 && setB.size === 0) return 1;
	let intersection = 0;
	for (const item of setA) {
		if (setB.has(item)) intersection++;
	}
	const union = new Set([...setA, ...setB]).size;
	return union === 0 ? 0 : intersection / union;
}

/** Compute Jaccard similarity between two sets of findings. */
export function findingsSimilarity(prev: string[], curr: string[]): number {
	const prevTokens = prev.flatMap((f) => f.toLowerCase().split(/[^a-z0-9]+/)).filter((t) => t.length > 2);
	const currTokens = curr.flatMap((f) => f.toLowerCase().split(/[^a-z0-9]+/)).filter((t) => t.length > 2);
	return jaccardSimilarity(prevTokens, currTokens);
}

/**
 * Parse the reviewer's Round Summary JSON from a worker's output.
 * Looks for a JSON code block after `## Round Summary`.
 * Returns null if no valid JSON round summary is found.
 */
export function parseRoundSummaryJson(output: string): RoundSummaryData | null {
	const jsonBlock = output.match(/```json\n([\s\S]*?)\n```/);
	if (!jsonBlock?.[1]) return null;
	try {
		const parsed = JSON.parse(jsonBlock[1]) as RoundSummaryData;
		if (typeof parsed.round !== "number" || typeof parsed.convergence_opinion !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}
