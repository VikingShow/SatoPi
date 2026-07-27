/**
 * GraphRunState persistence and recovery.
 *
 * Writes full-state checkpoints as custom entries in the Swarm
 * session.jsonl file.  On recovery, replays the session file
 * backwards to reconstruct the most recent state for a given run.
 *
 * ## Entry format
 *
 * Each checkpoint is appended via SwarmSessionManager.appendCustomEntry()
 * with customType = "graph_checkpoint" and data = GraphRunState.
 *
 * ## Recovery
 *
 * recoverState() walks session.jsonl entries from newest to oldest,
 * returning the first graph_checkpoint entry whose runId matches.
 * Because checkpoints are full snapshots (not deltas), the first
 * match is the complete most-recent state.
 */

import { CTX, SwarmSessionManager } from "../session/swarm-session-manager";

// ============================================================================
// Types
// ============================================================================

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type GraphRunStatus = "running" | "completed" | "failed" | "aborted";

export interface NodeRunState {
	nodeId: string;
	status: NodeStatus;
	startedAt?: number;
	completedAt?: number;
	error?: string;
	/** References to output artifacts produced by this node (file paths, artifact URIs). */
	outputRefs?: string[];
}

export interface GraphRunState {
	/** Logical name of the graph definition (e.g. "theatre-main"). */
	graphName: string;
	/** Unique run identifier — survives restarts. */
	runId: string;
	/** Epoch ms when this run was initiated. */
	startedAt: number;
	/** Node state keyed by node id. */
	nodes: Record<string, NodeRunState>;
	/** Which wave the executor is currently processing (0-based). */
	currentWave: number;
	/** Overall run status. */
	status: GraphRunStatus;
}

// ============================================================================
// Persistence
// ============================================================================

/**
 * Append a full-state checkpoint to the session file.
 *
 * Each call writes a complete snapshot — the session file is append-only
 * so the latest matching entry always holds the current state.
 */
export function writeCheckpoint(state: GraphRunState, sessionManager: SwarmSessionManager): void {
	sessionManager.appendCustomEntry(CTX.GRAPH_CHECKPOINT, state);
}

// ============================================================================
// Recovery
// ============================================================================

/**
 * Reconstruct the most recent GraphRunState for a given run by
 * replaying the session file backwards.
 *
 * Walks raw entries newest-first and returns the first graph_checkpoint
 * whose `runId` matches. Returns null if no checkpoint exists for the
 * requested run.
 */
export async function recoverState(
	sessionManager: SwarmSessionManager,
	runId: string,
): Promise<GraphRunState | null> {
	const raw = await SwarmSessionManager.readRawEntries(sessionManager.swarmDir);

	for (let i = raw.length - 1; i >= 0; i--) {
		const entry = raw[i];
		if (entry.type === "custom" && entry.customType === CTX.GRAPH_CHECKPOINT) {
			const data = entry.data as GraphRunState | undefined;
			if (data?.runId === runId) {
				return data;
			}
		}
	}

	return null;
}
