/**
 * CheckpointStore — persistence abstraction for graph execution state.
 *
 * The GraphEngine uses this interface to save and recover execution
 * progress. Implementations back it with SwarmSessionManager (swarm),
 * SQLite, or any other durable store.
 *
 * Checkpoints are full-state snapshots, not deltas — the most recent
 * write for a given `graphName` represents the complete execution state.
 */

import type { GraphRunState } from "./types";

/**
 * Persistence contract for graph checkpoint state.
 *
 * Implemented by SwarmSessionManager-backed stores in the swarm
 * layer, but kept abstract here so GraphEngine has zero swarm deps.
 */
export interface CheckpointStore {
	/** Persist a full-state checkpoint. Returns true on success. */
	write(state: GraphRunState): boolean;

	/** Recover the most recent checkpoint for a graph, or null if none exists. */
	recover(graphName: string): Promise<GraphRunState | null>;
}
