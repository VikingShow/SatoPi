/**
 * ActivityLogger event taxonomy — shared types for swarm activity events.
 *
 * Extracted from `swarm/infra/activity-logger.ts` so non-swarm sessions can
 * consume the event type definitions without pulling in the full swarm infra.
 */

// ============================================================================
// Event type union
// ============================================================================

export type ActivityEventType =
	| "broadcast"
	| "subgroup"
	| "steering"
	| "steering_ack"
	| "phase"
	| "convergence"
	| "verdict"
	| "conflict"
	| "scaling"
	| "nomination"
	| "crash"
	| "tool_call"
	| "error_flag"
	| "file_change"
	| "stream_start"
	| "stream_delta"
	| "stream_end"
	| "stream_thinking"
	| "deliberation_challenge"
	| "deliberation_rebuttal"
	| "deliberation_ruling"
	| "reviewer_individual"
	| "file_coordination"
	| "agent_state"
	| "pipeline_state";

// ============================================================================
// Event payload
// ============================================================================

export interface ActivityEntry {
	ts: number;
	type: ActivityEventType;
	from?: string;
	to?: string;
	body?: string;
	/** Phase-specific fields */
	phase?: string;
	round?: number;
	iteration?: number;
	/** Convergence-specific fields */
	scope?: string;
	jaccard?: number;
	converged?: boolean;
	/** Verdict-specific fields */
	passed?: boolean;
	approval?: number;
	total?: number;
	findings?: string[];
	disagreed?: boolean;
	praised?: string[];
	criticized?: string[];
	/** Conflict-specific fields */
	file?: string;
	writers?: string[];
	severity?: string;
	/** Scaling-specific fields */
	action?: string;
	agent?: string;
	reason?: string;
	/** Nomination-specific fields */
	elected?: string | null;
	votes?: Record<string, string[]>;
	/** Crash-specific fields */
	error?: string;
	/** Steering-ack fields */
	messageId?: string;
	acknowledgedBy?: string;
	/** Tool-call fields */
	toolName?: string;
	toolInput?: string;
	toolOutput?: string;
	toolError?: string;
	toolDurationMs?: number;
	/** Error-flag fields */
	errorFlag?: string;
	recoverable?: boolean;
	suggestion?: string;
	/** File-change fields */
	linesChanged?: number;
	/** Stream-end fields */
	thinking?: string;
	/** Agent-state extension fields */
	agentName?: string;
	status?: string;
	praiseCount?: number;
	criticismCount?: number;
	conflictCount?: number;
	role?: string;
	modelName?: string;
	/** Pipeline-state extension fields */
	loopIteration?: number;
	roundtablePhase?: string;
	todos?: unknown[];
	totalTokens?: number;
	totalRequests?: number;
}

// ============================================================================
// SSE broadcaster interface
// ============================================================================

export interface ActivityBroadcaster {
	broadcast(sessionName: string, entry: ActivityEntry): void;
}
