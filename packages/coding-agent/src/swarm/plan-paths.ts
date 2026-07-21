/**
 * Plan-paths — canonical plan.md path utilities.
 *
 * plan.md is per-session: {swarmDir}/.omp/plan.md
 * Plan archives are workspace-scoped: {workspace}/.omp/plans/plan-*.md
 *
 * This module is the SINGLE source of truth for plan.md location.
 * Every plan.md consumer MUST use these functions — never hardcode a
 * path.join(…, ".omp", "plan.md") anywhere else.
 */

import * as path from "node:path";

/**
 * Per-session plan.md path.
 *
 * Plan.md is a temporary working document created during Before Loop,
 * consumed during the loop, and archived at loop end. Because it is NOT
 * durable across sessions, it belongs in the session directory, not at
 * the workspace root.
 *
 * Path: .swarm_{name}/.omp/plan.md
 */
export function getSessionPlanPath(swarmDir: string): string {
	return path.join(swarmDir, ".omp", "plan.md");
}

/**
 * Per-session .omp directory (contains plan.md and session.jsonl).
 * Created lazily on first write.
 */
export function getSessionOmpDir(swarmDir: string): string {
	return path.join(swarmDir, ".omp");
}

/**
 * Workspace-scoped plan archive directory.
 * Historical plans persist here so Socrates can reference them in the
 * Before Loop prompt across sessions.
 *
 * Path: {workspace}/.omp/plans/
 */
export function getPlanArchiveDir(workspace: string): string {
	return path.join(workspace, ".omp", "plans");
}
