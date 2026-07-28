/**
 * Convergence utilities for swarm roundtable discussions.
 *
 * Provides tokenization and Jaccard similarity for detecting
 * when multi-agent discussions have stabilized.
 */

/**
 * Tokenize text into a set of lowercase words, filtering tokens
 * of length <= 2 to reduce noise.
 */
export function tokenize(text: string): Set<string> {
	const tokens = text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(t => t.length > 2);
	return new Set(tokens);
}

/**
 * Compute Jaccard similarity between two strings:
 *   |intersection| / |union|
 *
 * Returns 1 when both strings are effectively empty (identical),
 * returns 0 when only one is empty.
 */
export function jaccardSimilarity(a: string, b: string): number {
	const setA = tokenize(a);
	const setB = tokenize(b);

	if (setA.size === 0 && setB.size === 0) return 1;
	if (setA.size === 0 || setB.size === 0) return 0;

	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) intersection++;
	}

	return intersection / (setA.size + setB.size - intersection);
}
