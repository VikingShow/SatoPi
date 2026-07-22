/**
 * offload-paths — canonical path utilities for swarm offload storage.
 *
 * All offload-related paths live under {swarmDir}/.omp/:
 *
 *   {swarmDir}/.omp/offload/        — JSONL offload entries per agent
 *   {swarmDir}/.omp/mmds/           — Mermaid context-graph diagrams
 *   {swarmDir}/.omp/refs/           — Artifact references
 *
 * This module is the SINGLE source of truth for offload directory layout.
 * Every offload consumer MUST use these functions — never hardcode a
 * path.join(…, ".omp", "offload", …) anywhere else.
 */

import * as path from "node:path";

// ============================================================================
// Directory helpers
// ============================================================================

/**
 * Offload directory root.
 *
 * Path: {swarmDir}/.omp/offload
 */
export function getOffloadDir(swarmDir: string): string {
	return path.join(swarmDir, ".omp", "offload");
}

/**
 * Mermaid diagram storage directory.
 *
 * Path: {swarmDir}/.omp/mmds
 */
export function getMmdsDir(swarmDir: string): string {
	return path.join(swarmDir, ".omp", "mmds");
}

/**
 * Artifact references directory.
 *
 * Path: {swarmDir}/.omp/refs
 */
export function getRefsDir(swarmDir: string): string {
	return path.join(swarmDir, ".omp", "refs");
}

// ============================================================================
// File path helpers
// ============================================================================

/**
 * Offload JSONL file for a specific agent.
 *
 * Path: {swarmDir}/.omp/offload/{agentId}.jsonl
 */
export function getOffloadPath(swarmDir: string, agentId: string): string {
	return path.join(getOffloadDir(swarmDir), `${agentId}.jsonl`);
}

/**
 * Active Mermaid context-graph file.
 *
 * Path: {swarmDir}/.omp/mmds/context-graph.mmd
 */
export function getMmdPath(swarmDir: string): string {
	return path.join(getMmdsDir(swarmDir), "context-graph.mmd");
}

/**
 * Archived Mermaid context-graph file for a specific iteration.
 *
 * Path: {swarmDir}/.omp/mmds-archive/iter-{iter}-context-graph.mmd
 */
export function getArchivedMmdPath(swarmDir: string, iter: number): string {
	return path.join(swarmDir, ".omp", "mmds-archive", `iter-${iter}-context-graph.mmd`);
}
