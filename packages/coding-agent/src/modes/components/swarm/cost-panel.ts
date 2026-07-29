/**
 * Cost estimation panel for swarm dashboards.
 *
 * Computes estimated API cost from `SwarmState.totalTokens` and per-model
 * pricing metadata. The panel itself is a utility string — callers embed the
 * returned line directly into their layout.
 */

import type { Theme } from "../../theme/theme";

// ============================================================================
// Types
// ============================================================================

/** Per-million-token pricing pair (from Model.cost). */
export interface ModelCostInfo {
	input: number;
	output: number;
}

// ============================================================================
// Cost calculation
// ============================================================================

/**
 * Estimate blended API cost from aggregate token count and per-model pricing.
 *
 * Since `totalTokens` is an aggregate (input + output) and pricing differs
 * between input and output tiers, we use the arithmetic mean as a blended
 * per-million-token rate. This is a reasonable approximation for coding
 * workloads, where input and output token volumes tend to be within an
 * order of magnitude of each other.
 */
export function estimateCost(totalTokens: number, modelCost: ModelCostInfo): number {
	const blendedRate = (modelCost.input + modelCost.output) / 2;
	return (totalTokens / 1_000_000) * blendedRate;
}

// ============================================================================
// Rendering
// ============================================================================

/**
 * Render a single-line cost estimate suitable for a status bar.
 *
 * When `modelCost` is omitted, only the token count is shown (no cost).
 *
 * Format examples:
 *   "Tokens: 142K · Est: ~$0.42"
 *   "Tokens: 1.2M · Est: ~$3.50"
 *   "Tokens: 0" (when no tokens recorded)
 *   "Tokens: 142K" (when modelCost unavailable — pricing unknown)
 */
export function renderCostLine(
	totalTokens: number | undefined,
	modelCost: ModelCostInfo | undefined,
	theme: Theme,
): string {
	if (!totalTokens) {
		return theme.fg("dim", "Tokens: 0");
	}

	const tokStr = formatTokenCount(totalTokens);
	const parts = [theme.fg("dim", `Tokens: ${tokStr}`)];

	if (modelCost) {
		const cost = estimateCost(totalTokens, modelCost);
		const costStr = cost < 0.01 ? "< $0.01" : `~$${cost.toFixed(2)}`;
		parts.push(theme.fg("dim", `· Est: ${costStr}`));
	}

	return parts.join(" ");
}

// ============================================================================
// Helpers
// ============================================================================

function formatTokenCount(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) {
		const k = n / 1000;
		return k >= 100 ? `${Math.round(k)}K` : k >= 10 ? `${k.toFixed(1)}K` : `${k.toFixed(2)}K`;
	}
	const m = n / 1_000_000;
	return m >= 100 ? `${Math.round(m)}M` : m >= 10 ? `${m.toFixed(1)}M` : `${m.toFixed(2)}M`;
}
