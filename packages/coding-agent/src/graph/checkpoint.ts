/**
 * GraphRunState persistence and recovery.
 *
 * Writes full-state checkpoints as custom entries in the Swarm
 * session.jsonl file.  On recovery, replays the session file
 * backwards to reconstruct the most recent state for a given run.
 *
 * Writes full-state checkpoints as custom entries in the Swarm
 * session.jsonl file.  On recovery, replays the session file
 * backwards to reconstruct the most recent state for a given graph.
 *
 * ## Entry format
 *
 * Each checkpoint is appended via SwarmSessionManager.appendCustomEntry()
 * with customType = "graph_checkpoint" and data = GraphRunState.
 *
 * ## Recovery
 *
 * recoverState() walks session.jsonl entries from newest to oldest,
 * returning the first graph_checkpoint entry whose graphName matches.
 * Because checkpoints are full snapshots (not deltas), the first
 * match is the complete most-recent state.
 */

import { logger } from "@satopi/pi-utils";
import type { GraphRunState } from "./types";

/** Structural type for SwarmSessionManager (imported as type-only). */
interface SessionManagerLike {
	appendCustomEntry(customType: string, data: unknown): void;
}
// ============================================================================
// Persistence contract
// ============================================================================

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

// ============================================================================
// Types — re-exported from the canonical location
// ============================================================================

export type { GraphRunState, GraphRunStatus, NodeRunState, NodeStatus } from "./types";

/** Custom entry type for graph checkpoint persistence (inlined from swarm/session/swarm-session-manager CTX). */
const GRAPH_CHECKPOINT = "graph_checkpoint" as const;
// ============================================================================
// Persistence
// ============================================================================

/**
 * Append a full-state checkpoint to the session file.
 *
 * Each call writes a complete snapshot — the session file is append-only
 * so the latest matching entry always holds the current state.
 */
export function writeCheckpoint(state: GraphRunState, sessionManager: SessionManagerLike): boolean {
	try {
		sessionManager.appendCustomEntry(GRAPH_CHECKPOINT, state);
		return true;
	} catch (err) {
		logger.error("[checkpoint] Failed to write checkpoint", {
			graphName: state.graphName,
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}

// ============================================================================
// Recovery
// ============================================================================

/**
 * Reconstruct the most recent GraphRunState for a given graph by
 * replaying the session file backwards.
 *
 * Walks raw entries newest-first and returns the first graph_checkpoint
 * whose `graphName` matches. Returns null if no checkpoint exists for the
 * requested graph.
 */
export async function recoverState(
	readRawEntries: () => Promise<Array<Record<string, unknown>>>,
	graphName: string,
): Promise<GraphRunState | null> {
	const raw = await readRawEntries();

	for (let i = raw.length - 1; i >= 0; i--) {
		const entry = raw[i];
		if (entry.type === "custom" && entry.customType === GRAPH_CHECKPOINT) {
			const data = entry.data as GraphRunState | undefined;
			if (data?.graphName === graphName) {
				return data;
			}
		}
	}

	return null;
}
