/**
 * Swarm agent-runtime types.
 *
 * The AgentRuntime class has been deleted (Phase 5 refactoring).
 * Agent spawning is now handled by spawnAgent() / spawnAgents() in graph/agent-helpers.ts.
 * SwarmRuntime interface in core/swarm-runtime.ts defines the public contract.
 *
 * RoundtableConfig / RoundtableResult remain for test compatibility.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for a roundtable discussion among multiple agents.
 */
export interface RoundtableConfig {
	/** Number of discussion rounds. */
	rounds: number;

	/** Per-round timeout in milliseconds. */
	timeoutMs?: number;

	/** Convergence threshold for early exit (Jaccard similarity, 0-1). */
	convergenceThreshold?: number;

	/** Consecutive rounds above threshold before early exit. */
	convergenceStreak?: number;
}

/**
 * Result of a roundtable discussion.
 */
export interface RoundtableResult {
	/** Whether the roundtable converged before exhausting all rounds. */
	converged: boolean;

	/** Number of rounds actually executed. */
	rounds: number;

	/** All response strings across all rounds. */
	responses: string[];

	/** Final positions from the last round. */
	finalPositions: string[];
}
