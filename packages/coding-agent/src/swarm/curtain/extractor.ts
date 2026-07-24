/**
 * After Loop — Rule-based lesson extraction.
 *
 * Analyzes StageResult to extract structured lessons from agent output
 * suitable for storage in the experience database.
 *
 * Extraction rules:
 *   - Error patterns (what went wrong, root cause if identifiable)
 *   - Success patterns (what approach worked well)
 *   - Iteration insights (how many iterations, convergence speed)
 *   - Agent dynamics (coordination patterns, role assignment)
 *   - Review verdicts (alignment issues, safety flags)
 */

import type { StageResult } from "../stage/stage-controller";

// ============================================================================
// Types
// ============================================================================

export interface ExtractedLesson {
	/** Type of insight. */
	type: "error" | "success" | "insight" | "pattern" | "warning" | "reflection";
	/** Human-readable summary. */
	summary: string;
	/** Full detail for later retrieval. */
	detail: string;
	/** Tags for fuzzy matching / categorization. */
	tags: string[];
	/** 0-1 confidence in this lesson. */
	confidence: number;
	/** Source: which iteration/agent produced this. */
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
	finalStatus: "completed" | "failed" | "aborted" | "escalated" | "converged_failed" | "converged_partial";
	reviewApprovalRatio: number;
	agentCount: number;
	taskDescription?: string;
}

// ============================================================================
// Extractor
// ============================================================================

export function extractLessons(result: StageResult, agentCount: number, reviewerCount: number): { lessons: ExtractedLesson[]; stats: LoopRunStats } {
	const lessons: ExtractedLesson[] = [];

	const taskCount = result.taskProgress.total;
	const completedCount = result.taskProgress.completed;

	// 1. Status-based insight
	if (result.status === "completed") {
		lessons.push({
			type: "success",
			summary: `Stage completed: ${completedCount}/${taskCount} tasks done`,
			detail: `All ${completedCount} tasks completed by ${agentCount} agents with no errors.`,
			tags: ["completion", `tasks:${completedCount}`],
			confidence: 0.9,
			source: "stage-controller",
		});
	} else if (result.status === "failed") {
		lessons.push({
			type: "error",
			summary: `Stage failed: ${completedCount}/${taskCount} tasks done (${result.errors.length} error(s))`,
			detail: `${completedCount} of ${taskCount} tasks completed before failure. ${result.errors.length} error(s) encountered.`,
			tags: ["failure", `tasks:${completedCount}`],
			confidence: 0.7,
			source: "stage-controller",
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

	// 3. Agent result insights — extract lessons from successes and failures
	let totalAgentResults = 0;
	let successfulResults = 0;
	for (const [, results] of result.agentResults) {
		for (const r of results) {
			totalAgentResults++;
			if (r.exitCode === 0) successfulResults++;
			else if (r.output) {
				lessons.push({
					type: "insight",
					summary: r.output.slice(0, 200),
					detail: `Agent ${r.agent} task ${r.task} failed with exit ${r.exitCode}`,
					tags: ["agent-failure", `agent:${r.agent}`],
					confidence: 0.7,
					source: "agent-result",
				});
			}
		}
	}

	// 4. Stats
	const successRatio = totalAgentResults > 0 ? successfulResults / totalAgentResults : 0;

	const stats: LoopRunStats = {
		totalIterations: taskCount,
		finalStatus: result.status,
		reviewApprovalRatio: Math.round(successRatio * 100) / 100,
		agentCount,
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
