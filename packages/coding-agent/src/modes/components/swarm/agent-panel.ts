/**
 * Agent Panel — renders swarm agent status as ANSI-coloured panel lines.
 *
 * Shows each agent with role, current task, duration, and status glyph.
 * Includes reviewer tag line when a reviewer agent is elected.
 */

import type { AgentState, SwarmState } from "../../../swarm/core/state";
import { makeFooter, makeHeader, padLine } from "./panel-utils";
import { sato } from "./theme";

// ============================================================================
// Status glyphs
// ============================================================================

const STATUS_GLYPH: Record<string, string> = {
	completed: "✓", // ✓
	running: "◌",   // ◌
	waiting: "○",   // ○
	failed: "✗",    // ✗
	pending: "·",   // ·
	aborted: "⊘",   // ⊘
};

const STATUS_COLOR: Record<string, (text: string) => string> = {
	completed: sato.success,
	running: sato.info,
	waiting: sato.warning,
	failed: sato.danger,
	pending: sato.muted,
	aborted: sato.danger,
};

const STATUS_LABEL: Record<string, string> = {
	completed: "done",
	running: "running",
	waiting: "waiting for tasks",
	failed: "failed",
	pending: "pending",
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Render the agent status panel.
 *
 * Returns an array of chalk-coloured strings, one per display line.
 * Every visible line is guaranteed to be at most `maxWidth` columns wide.
 *
 * Gracefully handles:
 *  - Empty agents (shows "No agents" placeholder)
 *  - Null/undefined state (returns empty panel with error indicator)
 *  - Missing optional fields (modelName, role, etc.)
 */
export function renderAgentPanel(state: SwarmState | null | undefined, maxWidth: number): string[] {
	if (!state) {
		return emptyPanel(maxWidth, "No swarm state");
	}

	const agents = Object.values(state.agents ?? {});
	const innerWidth = maxWidth - 4; // "│ " + content + " │"
	if (innerWidth < 10) return [];

	const lines: string[] = [];

	// Header
	lines.push(makeHeader("Agents", maxWidth));

	if (agents.length === 0) {
		lines.push(padLine(` ${sato.dim("No agents")}`, maxWidth));
	} else {
		// Sort agents: reviewer first, then by name
		const sorted = [...agents].sort((a, b) => {
			if (a.role === "reviewer" && b.role !== "reviewer") return -1;
			if (b.role === "reviewer" && a.role !== "reviewer") return 1;
			return a.name.localeCompare(b.name);
		});

		// Agent lines (up to 20, then summary)
		const maxAgentLines = 20;
		const shown = sorted.slice(0, maxAgentLines);
		for (const agent of shown) {
			lines.push(formatAgentLine(agent, innerWidth, maxWidth));
		}
		if (sorted.length > maxAgentLines) {
			lines.push(padLine(` ${sato.dim(`... and ${sorted.length - maxAgentLines} more agents`)}`, maxWidth));
		}
	}

	// Reviewer footer
	const reviewer = Object.values(state.agents ?? {}).find(a => a.role === "reviewer");
	if (reviewer) {
		const verdict = state.reviewVerdict;
		let footer = ` 👑 reviewer: ${reviewer.name}`; // 👑
		if (verdict) {
			const verdictMax = Math.max(5, innerWidth - (footer.length + 12));
			const display = verdict.length > verdictMax ? verdict.slice(0, verdictMax - 3) + "..." : verdict;
			footer += `  ·  review: "${display}"`; // ·
		}
		lines.push(padLine("", maxWidth));
		lines.push(padLine(footer, maxWidth));
	}

	// Footer
	lines.push(makeFooter(maxWidth));

	return lines;
}

// ============================================================================
// Internal
// ============================================================================

function formatAgentLine(agent: AgentState, innerWidth: number, maxWidth: number): string {
	const glyph = STATUS_GLYPH[agent.status] ?? STATUS_GLYPH.pending;
	const colorFn = STATUS_COLOR[agent.status] ?? STATUS_COLOR.pending;
	const glyphStr = colorFn(glyph);
	const name = agent.name;

	// Role badge
	const roleLabel = agent.role ?? agent.modelName ?? "";
	const roleBadge = roleLabel ? sato.dim(`[${roleLabel}]`) : "";

	// Status text
	let statusText: string;
	if (agent.status === "failed") {
		const err = agent.error ?? "unknown error";
		statusText = `${STATUS_LABEL.failed}: ${err}`;
	} else if (agent.status === "completed") {
		statusText = sato.success(STATUS_LABEL.completed);
	} else if (agent.status === "running") {
		statusText = sato.info(STATUS_LABEL.running);
	} else {
		statusText = sato.dim(STATUS_LABEL[agent.status] ?? agent.status);
	}

	// Duration
	let durationStr = "";
	if (agent.startedAt) {
		const end = agent.completedAt ?? Date.now();
		const ms = end - agent.startedAt;
		durationStr = sato.dim(`(${formatDuration(ms)})`);
	}

	// Assemble
	const segments: string[] = [glyphStr, name];
	if (roleBadge) segments.push(roleBadge);
	segments.push(statusText);
	if (durationStr) segments.push(durationStr);

	let line = " " + segments.join(" ");

	// If too long, truncate the status text
	if (line.replace(/\x1b\[[0-9;]*m/g, "").length > innerWidth) {
		const minimal = ` ${glyphStr} ${name}`;
		const minimalLen = minimal.replace(/\x1b\[[0-9;]*m/g, "").length;
		const suffix = durationStr ? ` ${durationStr}` : "";
		const suffixLen = suffix.replace(/\x1b\[[0-9;]*m/g, "").length;
		const statusBudget = innerWidth - minimalLen - suffixLen - 1;

		if (agent.status === "failed" && statusBudget > 10) {
			const err = agent.error ?? "unknown error";
			const errBudget = statusBudget - "failed: ".length;
			if (errBudget >= 3) {
				const truncated = err.length > errBudget ? err.slice(0, errBudget - 3) + "..." : err;
				line = `${minimal} ${sato.danger(`failed: ${truncated}`)}${suffix}`;
			} else {
				line = `${minimal}${suffix}`;
			}
		} else if (statusBudget >= 3) {
			const label = STATUS_LABEL[agent.status] ?? agent.status;
			const truncated = label.length > statusBudget ? label.slice(0, statusBudget - 3) + "..." : label;
			line = `${minimal} ${sato.dim(truncated)}${suffix}`;
		} else {
			line = `${minimal}${suffix}`;
		}
	}

	return padLine(line, maxWidth);
}

function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	if (ms < 1000) return "<1s";

	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;

	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;

	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function emptyPanel(maxWidth: number, message: string): string[] {
	const innerWidth = maxWidth - 4;
	if (innerWidth < 5) return [];
	return [
		makeHeader("Agents", maxWidth),
		padLine(` ${sato.dim(message)}`, maxWidth),
		makeFooter(maxWidth),
	];
}
