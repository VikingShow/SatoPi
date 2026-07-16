/**
 * TaskComplexityAnalyzer — Dynamic worker/cloner count evaluation.
 *
 * Runs after plan.md is produced, before the loop starts.
 * Replaces hardcoded YAML defaults with plan-driven recommendations.
 *
 * Two layers:
 *   1. Rule layer (deterministic) — parse plan.md for signals
 *   2. LLM layer (optional) — refine with a cheap model call
 *
 * Fusion: LLM recommendation is baseline; rule signals adjust.
 * On LLM failure: fall back to rules-only + log warning.
 */

import type { LoopSwarmConfig } from "./schema";

// ============================================================================
// Types
// ============================================================================

export interface TaskComplexitySignals {
	/** Count of independent subtasks identified in the plan. */
	parallelism: number;
	/** Count of distinct file paths / module references. */
	codeSurface: number;
	/** Whether plan mentions auth, crypto, data-mutation, or security. */
	safetyCritical: boolean;
	/** Whether plan spans multiple languages. */
	crossLanguage: boolean;
	/** Whether plan spans multiple packages / crates. */
	crossPackage: boolean;
}

export interface TaskComplexityRecommendation {
	workers: number;
	cloners: number;
	/** Recommended max rounds per iteration for peer review. 0 = unlimited. */
	maxRounds: number;
	/** How many consecutive converged rounds to end early. */
	roundsConvergenceThreshold: number;
	complexity: "low" | "medium" | "high";
	parallelism: number;
	safetyCritical: boolean;
	rationale: string;
	/** Where the recommendation came from. */
	source: "rules" | "llm" | "fallback";
}

// ============================================================================
// Signal extraction patterns
// ============================================================================

const SAFETY_KEYWORDS =
	/\b(auth|authenticate|authentication|crypto|encrypt|decrypt|token|password|secret|credential|permission|authorization|sql\s*injection|xss|csrf|sanitize|data\s*loss|mutation|migrate|transaction|rollback|atomic)\b/i;

const LANG_KEYWORDS = /\b(typescript|javascript|python|rust|go|c\+\+|java|ruby|swift|kotlin|elixir|zig|csharp|c#)\b/gi;

const PACKAGE_REF = /\bpackages?\/\S+|crates?\/\S+/gi;

const FILE_REF = /\b(src|lib|tests?|scripts?)\/[\w./-]+\.\w{1,6}\b/gi;

const TASK_HEADING = /^#{1,3}\s+(task|step|phase|item|goal|\d+[.)]\s)/im;

const NUMBERED_ITEM = /^\d+[.)]\s/m;

// ============================================================================
// Rule-based signal extraction
// ============================================================================

function extractSignals(planContent: string): TaskComplexitySignals {
	// Parallelism: count independent task headings + numbered items
	const headingCount = [...planContent.matchAll(TASK_HEADING)].length;
	const numberedCount = [...planContent.matchAll(NUMBERED_ITEM)].length;
	const parallelism = Math.max(1, headingCount + numberedCount);

	// Code surface: extract unique file references
	const fileRefs = new Set([...planContent.matchAll(FILE_REF)].map(m => m[0].toLowerCase()));
	// Also count inline code paths like `src/foo/bar.ts`
	const inlinePaths = planContent.match(/`[^`]*\/[^`]*\.\w{1,6}`/g) ?? [];
	for (const p of inlinePaths) {
		fileRefs.add(p.replace(/`/g, "").toLowerCase());
	}
	const codeSurface = fileRefs.size;

	// Safety critical
	const safetyCritical = SAFETY_KEYWORDS.test(planContent);

	// Cross-language: count unique languages mentioned
	const langMatches = planContent.matchAll(LANG_KEYWORDS);
	const langs = new Set([...langMatches].map(m => m[0].toLowerCase()));
	const crossLanguage = langs.size > 1;

	// Cross-package
	const pkgMatches = planContent.matchAll(PACKAGE_REF);
	const pkgs = new Set([...pkgMatches].map(m => m[0].toLowerCase()));
	const crossPackage = pkgs.size > 1;

	return { parallelism, codeSurface, safetyCritical, crossLanguage, crossPackage };
}

// ============================================================================
// Recommendation from signals (rules-only, no LLM)
// ============================================================================

function recommendFromSignals(
	signals: TaskComplexitySignals,
	loopConfig: LoopSwarmConfig,
): TaskComplexityRecommendation {
	const defaultCloners = loopConfig.cloners.count;

	// Complexity heuristic
	let complexity: "low" | "medium" | "high";
	if (signals.parallelism <= 2 && signals.codeSurface <= 3 && !signals.safetyCritical) {
		complexity = "low";
	} else if (
		signals.parallelism >= 6 ||
		signals.codeSurface >= 10 ||
		(signals.safetyCritical && signals.codeSurface >= 5)
	) {
		complexity = "high";
	} else {
		complexity = "medium";
	}

	// Workers: driven by parallelism
	const workers = signals.parallelism;
	// Cloners: base on default, increase for safety-critical
	let cloners = defaultCloners;
	if (signals.safetyCritical && cloners < 3) cloners = 3;
	if (complexity === "low" && cloners > 1) cloners -= 1;

	// maxRounds: complexity-driven, capped by config (0 = unlimited, honored)
	let maxRounds: number;
	let roundsConvergenceThreshold: number;
	switch (complexity) {
		case "low":
			maxRounds = 2;
			roundsConvergenceThreshold = 2;
			break;
		case "medium":
			maxRounds = 4;
			roundsConvergenceThreshold = 3;
			break;
		case "high":
			maxRounds = 7;
			roundsConvergenceThreshold = 4;
			break;
	}
	if (signals.safetyCritical) {
		maxRounds += 1;
		roundsConvergenceThreshold += 1;
	}
	if (signals.crossPackage) maxRounds += 1;
	// Clamp to config bounds (0 = unlimited from config stays 0)
	const configMaxRounds = loopConfig.workers.maxRounds;
	if (configMaxRounds > 0) maxRounds = Math.min(maxRounds, configMaxRounds);
	roundsConvergenceThreshold = Math.max(1, Math.min(roundsConvergenceThreshold, maxRounds > 0 ? maxRounds : 10));

	return {
		workers,
		cloners,
		maxRounds,
		roundsConvergenceThreshold,
		complexity,
		parallelism: signals.parallelism,
		safetyCritical: signals.safetyCritical,
		rationale: parts.join(", "),
		source: "rules",
	};
}

// ============================================================================
// TaskComplexityAnalyzer class
// ============================================================================

export class TaskComplexityAnalyzer {
	async analyze(planContent: string, loopConfig: LoopSwarmConfig): Promise<TaskComplexityRecommendation> {
		if (!planContent || planContent.trim().length === 0) {
			return {
				workers: loopConfig.workers.initial,
				cloners: loopConfig.cloners.count,
				maxRounds: loopConfig.workers.maxRounds,
				roundsConvergenceThreshold: loopConfig.workers.roundsConvergenceThreshold,
				complexity: "medium",
				parallelism: 1,
				safetyCritical: false,
				rationale: "empty plan — using config defaults",
				source: "fallback",
			};
		}

		const signals = extractSignals(planContent);

		// Try LLM refinement if a cheap model is available
		// (currently rules-only; LLM layer is a future enhancement)
		return recommendFromSignals(signals, loopConfig);
	}
}
