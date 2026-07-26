/**
 * Shared types for the Curtain phase.
 */

/** AfterLoop result — shared between loop controller and curtain pipeline. */
export interface AfterLoopResult {
	runId: string;
	status: string;
	iterations: number;
	summaryMarkdown: string;
	lessons: Array<{
		type: string;
		summary: string;
		detail: string;
		tags: string[];
		confidence: number;
		source: string;
	}>;
	reflection: {
		rootCauses: string[];
		effectivePatterns: string[];
		structuralIssues: string[];
		recommendations: string[];
		confidence: number;
	} | null;
	stats: {
		totalIterations: number;
		finalStatus: string;
		reviewApprovalRatio: number;
		agentCount: number;
	};
}

// ============================================================================
// Reporter election — extracted from monitor/reporter-election.ts
// ============================================================================

export interface ContributionData {
	agentId: string;
	name: string;
	/** Number of tasks completed */
	tasksCompleted: number;
	/** Number of lines changed */
	codeLinesChanged: number;
}
