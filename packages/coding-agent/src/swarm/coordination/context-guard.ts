/**
 * ContextGuard — model-aware token budget management.
 *
 * Uses countTokens() from pi-agent-core to check context size against the
 * model's contextWindow (from ModelRegistry).  Warns at 80% utilisation,
 * suggests compaction at 90%, and returns the guard result so callers can
 * decide whether to compact or abort.
 *
 * ## Thresholds
 *
 * | % of contextWindow | Action                                    |
 * |--------------------|-------------------------------------------|
 * | 0 – 79%            | silent pass                               |
 * | 80 – 89%           | logger.warn + optional compaction         |
 * | 90 – 99%           | logger.warn + recommended compaction      |
 * | >= 100%            | logger.error — caller MUST compact/abort  |
 *
 * ## Model-aware
 *
 * Context window is read from ModelRegistry's `contextWindow` field (default
 * 128K for DeepSeek V3).  This avoids hard-coding thresholds that don't match
 * the actual model.
 */

import { countTokens } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Types
// ============================================================================

export interface ContextGuardResult {
	/** Total tokens counted. */
	tokens: number;
	/** Model's maximum context window (read from ModelRegistry). */
	contextWindow: number;
	/** Percentage utilisation (0-100+). */
	utilisation: number;
	/** Should the caller consider compacting? */
	shouldCompact: boolean;
	/** Has the context exceeded the model's window? */
	exceeded: boolean;
}

// ============================================================================
// Defaults
// ============================================================================

/** Default context window when no ModelRegistry override is available. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Warn above this utilisation. */
const WARN_THRESHOLD = 0.80;

/** Recommend compaction above this utilisation. */
const COMPACT_THRESHOLD = 0.90;

// ============================================================================
// Guard
// ============================================================================

export interface ContextGuardOptions {
	/** Text to tokenise (usually the full task passed to the LLM). */
	text: string;
	/** Model context window size.  Defaults to {@link DEFAULT_CONTEXT_WINDOW}. */
	contextWindow?: number;
	/** Caller label for log messages (e.g. "Worker #spawnWorkers", "Socrates"). */
	label?: string;
}

/**
 * Check token budget and return a structured guard result.
 *
 * This is a **pure guard** — it never mutates state or triggers compaction.
 * The caller decides how to respond (compact, warn, or proceed).
 */
export function checkContextBudget(options: ContextGuardOptions): ContextGuardResult {
	const { text, contextWindow = DEFAULT_CONTEXT_WINDOW, label = "context" } = options;
	const tokens = countTokens(text);
	const utilisation = tokens / contextWindow;
	const exceeded = tokens > contextWindow;
	const shouldCompact = utilisation >= COMPACT_THRESHOLD;

	if (exceeded) {
		logger.error(
			`[ContextGuard] ${label}: ${tokens} / ${contextWindow} tokens ` +
			`(${(utilisation * 100).toFixed(1)}%) — EXCEEDED model window! ` +
			`Compaction required.`,
		);
	} else if (shouldCompact) {
		logger.warn(
			`[ContextGuard] ${label}: ${tokens} / ${contextWindow} tokens ` +
			`(${(utilisation * 100).toFixed(1)}%) — approaching limit. ` +
			`Compaction recommended.`,
		);
	} else if (utilisation >= WARN_THRESHOLD) {
		logger.info(
			`[ContextGuard] ${label}: ${tokens} / ${contextWindow} tokens ` +
			`(${(utilisation * 100).toFixed(1)}%) — high utilisation.`,
		);
	}

	return { tokens, contextWindow, utilisation, shouldCompact, exceeded };
}

/**
 * Convenience: guard + summed token count for task pieces.
 *
 * Joins the pieces (like the current task array join("\n") pattern),
 * counts tokens, and returns the guard result.
 */
export function guardTaskBudget(
	pieces: string[],
	contextWindow?: number,
	label?: string,
): ContextGuardResult {
	return checkContextBudget({ text: pieces.join("\n"), contextWindow, label });
}
