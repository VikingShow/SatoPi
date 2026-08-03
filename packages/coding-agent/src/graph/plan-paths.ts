/**
 * Plan-paths — canonical plan.md path utilities.
 *
 * plan.md is per-session: {swarmDir}/.session/plan.md
 * Plan archives are workspace-scoped: {workspace}/.stp/plans/plan-*.md
 *
 * This module is the SINGLE source of truth for plan.md location.
 * Every plan.md consumer MUST use these functions — never hardcode a
 * path.join(…, ".session", "plan.md") anywhere else.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Per-session plan.md path.
 *
 * Plan.md is a temporary working document created during Before Loop,
 * consumed during the loop, and archived at loop end. Because it is NOT
 * durable across sessions, it belongs in the session directory, not at
 * the workspace root.
 *
 * Path: .stp/sessions/swarm-{name}/.session/plan.md
 */
export function getSessionPlanPath(swarmDir: string): string {
	return path.join(swarmDir, ".session", "plan.md");
}

/**
 * Per-session .session directory (contains plan.md and session.jsonl).
 * Created lazily on first write.
 */
export function getSessionStpDir(swarmDir: string): string {
	return path.join(swarmDir, ".session");
}

/**
 * Workspace-scoped plan archive directory.
 * Historical plans persist here so the Planner can reference them in the
 * Before Loop prompt across sessions.
 *
 * Path: {workspace}/.stp/plans/
 */
export function getPlanArchiveDir(workspace: string): string {
	return path.join(workspace, ".stp", "plans");
}

/**
 * Archive the current plan.md to .stp/plans/ for historical reference.
 *
 * Archives are workspace-scoped so Planner can reference past plans
 * in the Before Loop prompt across sessions. The plan is copied with
 * a timestamped filename (plan-YYYY-MM-DDTHHMMSS.md) into
 * {workspace}/.stp/plans/.
 *
 * The stamp comment (<!-- plan-generated: … -->) is stripped before
 * archiving — the archive holds raw plan content.
 */
export async function archivePlanForHistory(swarmDir: string, workspace: string): Promise<void> {
	const planPath = getSessionPlanPath(swarmDir);

	let content: string;
	try {
		content = await Bun.file(planPath).text();
	} catch {
		return; // No plan to archive
	}

	if (content.trim().length === 0) return;

	// Strip stamp comment if present — archived plans are raw plan content.
	if (content.startsWith("<!-- plan-generated:")) {
		const nl = content.indexOf("\n");
		content = nl >= 0 ? content.slice(nl + 1) : "";
	}

	const archiveDir = getPlanArchiveDir(workspace);
	await fs.mkdir(archiveDir, { recursive: true });
	const ts = new Date().toISOString().replace(/:/g, "").slice(0, 19);
	const archivePath = path.join(archiveDir, `plan-${ts}.md`);
	await Bun.write(archivePath, content);
}
