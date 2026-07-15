/**
 * After Loop — Rule-based lesson extraction.
 *
 * Analyzes LoopResult + worker/cloner output to extract structured lessons
 * suitable for storage in the experience database.
 *
 * Extraction rules:
 *   - Error patterns (what went wrong, root cause if identifiable)
 *   - Success patterns (what approach worked well)
 *   - Iteration insights (how many iterations, convergence speed)
 *   - Worker dynamics (coordination patterns, role emergence)
 *   - Cloner verdicts (alignment issues, safety flags)
 */

import type { LoopResult } from "../loop-controller";

// ============================================================================
// Types
// ============================================================================

export interface ExtractedLesson {
	/** Type of insight. */
	type: "error" | "success" | "insight" | "pattern" | "warning";
	/** Human-readable summary. */
	summary: string;
	/** Full detail for later retrieval. */
	detail: string;
	/** Tags for fuzzy matching / categorization. */
	tags: string[];
	/** 0-1 confidence in this lesson. */
	confidence: number;
	/** Source: which iteration/cloner/worker produced this. */
	source: string;
}

export interface ExtractionResult {
	/** Extracted lessons from this loop run. */
	lessons: ExtractedLesson[];
	/** Summary statistics for the experience store. */
	stats: LoopRunStats;
}

export interface LoopRunStats {
	totalIterations: number;
	finalStatus: "completed" | "failed" | "aborted" | "escalated";
	clonerApprovalRatio: number;
	workerCount: number;
	clonerCount: number;
	taskDescription?: string;
}

// ============================================================================
// Extractor
// ============================================================================

export function extractLessons(result: LoopResult, workerCount: number, clonerCount: number): ExtractionResult {
	const lessons: ExtractedLesson[] = [];

	// 1. Status-based insight
	if (result.status === "completed") {
		lessons.push({
			type: "success",
			summary: `Loop completed in ${result.iterations} iteration(s)`,
			detail: `The swarm reached consensus after ${result.iterations} iteration(s) with ${workerCount} workers and ${clonerCount} cloners.`,
			tags: ["completion", "consensus", `iterations:${result.iterations}`],
			confidence: 0.9,
			source: "loop-controller",
		});
	} else if (result.status === "escalated") {
		lessons.push({
			type: "warning",
			summary: `Loop escalated to human after ${result.iterations} iteration(s)`,
			detail: "The swarm could not reach consensus. Cloners disagreed or confidence was too low. Human intervention needed.",
			tags: ["escalation", "no-consensus", "human-intervention"],
			confidence: 0.8,
			source: "loop-controller",
		});
	} else if (result.status === "failed") {
		lessons.push({
			type: "error",
			summary: `Loop failed after ${result.iterations} iteration(s)`,
			detail: `Max iterations (${result.iterations}) reached without passing review. Consider: clearer acceptance criteria, more workers, or task decomposition.`,
			tags: ["failure", "max-iterations", "no-consensus"],
			confidence: 0.7,
			source: "loop-controller",
		});
	}

	// 2. Error extraction
	for (const error of result.errors) {
		const tags: string[] = ["error"];
		if (error.includes("timeout") || error.includes("Timeout")) tags.push("timeout");
		if (error.includes("abort") || error.includes("AbortSignal")) tags.push("aborted");

		lessons.push({
			type: "error",
			summary: error.slice(0, 200),
			detail: error,
			tags,
			confidence: 0.6,
			source: "executor",
		});
	}

	// 3. Review verdict insights
	for (const verdict of result.reviewVerdicts) {
		if (!verdict.passed) {
			for (const finding of verdict.findings) {
				const tags = parseFindingTags(finding);
				lessons.push({
					type: "insight",
					summary: finding.slice(0, 200),
					detail: `Review finding (${verdict.approvalCount}/${verdict.totalCount} passed): ${finding}`,
					tags: [...tags, "review", "finding"],
					confidence: 0.7,
					source: "cloner-review",
				});
			}
		}
	}

	// 4. Stats
	const approvalCount = result.reviewVerdicts.reduce((sum, v) => sum + v.approvalCount, 0);
	const totalReviews = result.reviewVerdicts.reduce((sum, v) => sum + v.totalCount, 0);
	const approvalRatio = totalReviews > 0 ? approvalCount / totalReviews : 0;

	const stats: LoopRunStats = {
		totalIterations: result.iterations,
		finalStatus: result.status,
		clonerApprovalRatio: Math.round(approvalRatio * 100) / 100,
		workerCount,
		clonerCount,
	};

	return { lessons, stats };
}

// ============================================================================
// Helpers
// ============================================================================

function parseFindingTags(finding: string): string[] {
	const tags: string[] = [];
	const lower = finding.toLowerCase();

	if (lower.includes("security") || lower.includes("vulnerab") || lower.includes("exploit")) {
		tags.push("security");
	}
	if (lower.includes("quality") || lower.includes("poor") || lower.includes("bug")) {
		tags.push("quality");
	}
	if (lower.includes("alignment") || lower.includes("misalign") || lower.includes("off-track")) {
		tags.push("alignment");
	}
	if (lower.includes("complete") || lower.includes("incomplete") || lower.includes("missing")) {
		tags.push("completeness");
	}
	if (lower.includes("format") || lower.includes("style") || lower.includes("convention")) {
		tags.push("code-style");
	}

	return tags;
}
