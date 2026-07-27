/**
 * Agent Panel — renders swarm agent status as ANSI-colored panel lines.
 *
 * Shows each agent with role, current task, duration, and status glyph.
 * Includes reviewer tag line when a reviewer agent is elected.
 */

import type { AgentState, AgentStatus, SwarmState } from "../../../swarm/core/state";
import { ansiBold, ansiDim, ansiFg, SATOPI_COLORS } from "../../../swarm/tui/theme";

// ============================================================================
// ANSI stripping (not exported by theme)
// ============================================================================

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function visibleLength(text: string): number {
	return stripAnsi(text).length;
}

// ============================================================================
// Status glyphs
// ============================================================================

const STATUS_GLYPH: Record<string, string> = {
	completed: "✓",
	running: "◌",
	waiting: "○",
	failed: "✗",
	pending: "·",
	aborted: "⊘",
};

const STATUS_COLOR: Record<string, number> = {
	completed: SATOPI_COLORS.success.ansi256,
	running: SATOPI_COLORS.info.ansi256,
	waiting: SATOPI_COLORS.warning.ansi256,
	failed: SATOPI_COLORS.danger.ansi256,
	pending: SATOPI_COLORS.muted.ansi256,
	aborted: SATOPI_COLORS.danger.ansi256,
};

const STATUS_LABEL: Record<string, string> = {
	completed: "done",
	running: "running",
	waiting: "waiting for tasks",
	failed: "failed",
	pending: "pending",
};

// ============================================================================
// Box-drawing constants
// ============================================================================

const H = "─";
const TOP_LEFT = "┌";
const TOP_RIGHT = "┐";
const BOTTOM_LEFT = "└";
const BOTTOM_RIGHT = "┘";
const V = "│";

// ============================================================================
// Public API
// ============================================================================

/**
 * Render the agent status panel.
 *
 * Returns an array of ANSI-colored strings, one per display line.
 * Every visible line is guaranteed to be at most `maxWidth` characters wide.
 *
 * Gracefully handles:
 *  - Empty agents (shows "No agents" placeholder)
 *  - Null/undefined state (returns empty panel with error indicator)
 *  - Missing optional fields (modelName, role, etc.)
 */
export function renderAgentPanel(state: SwarmState | null | undefined, maxWidth: number): string[] {
	if (!state) {
		return _emptyPanel(maxWidth, "No swarm state");
	}

	const agents = Object.values(state.agents ?? {});
	const innerWidth = maxWidth - 4; // "│ " + content + " │"
	if (innerWidth < 10) return []; // too narrow to render anything useful

	const lines: string[] = [];

	// Header
	lines.push(_makeHeader("Agents", maxWidth, H, TOP_LEFT, TOP_RIGHT));

	if (agents.length === 0) {
		lines.push(_padLine(` ${ansiDim("No agents")}`, maxWidth));
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
			lines.push(_formatAgentLine(agent, innerWidth, maxWidth, state.status));
		}
		if (sorted.length > maxAgentLines) {
			lines.push(_padLine(` ${ansiDim(`... and ${sorted.length - maxAgentLines} more agents`)}`, maxWidth));
		}
	}

	// Reviewer footer: show the elected reviewer with any review verdict
	const reviewer = Object.values(state.agents ?? {}).find(a => a.role === "reviewer");
	if (reviewer) {
		const verdict = state.reviewVerdict;
		let footer = ` 👑 reviewer: ${reviewer.name}`;
		if (verdict) {
			// Calculate how many verdict chars fit
			const prefix = visibleLength(footer) + visibleLength(`  ·  review: ""`);
			const verdictBudget = innerWidth - prefix;
			let verdictDisplay: string;
			if (verdictBudget >= 5) {
				verdictDisplay =
					verdict.length > verdictBudget ? verdict.slice(0, Math.max(1, verdictBudget - 3)) + "..." : verdict;
			} else {
				verdictDisplay = verdict.length > 3 ? verdict.slice(0, 1) + ".." : verdict;
			}
			footer += `  ·  review: "${verdictDisplay}"`;
		}
		lines.push(_padLine("", maxWidth)); // blank spacer
		lines.push(_padLine(footer, maxWidth));
	}

	// Footer
	lines.push(_makeFooter(maxWidth, H, BOTTOM_LEFT, BOTTOM_RIGHT));

	return lines;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Format a single agent line.
 *
 * Layout:  STATUS_GLYPH AGENT_NAME  [ROLE]  STATUS_TEXT  (DURATION)
 *
 * Truncates error messages to fit within the available width.
 */
function _formatAgentLine(agent: AgentState, innerWidth: number, maxWidth: number, _pipelineStatus: string): string {
	const glyph = STATUS_GLYPH[agent.status] ?? STATUS_GLYPH.pending;
	const color = STATUS_COLOR[agent.status] ?? STATUS_COLOR.pending;

	// Build pieces
	const glyphStr = ansiFg(color, glyph);
	const name = agent.name;

	// Role badge
	const roleLabel = agent.role ?? agent.modelName ?? "";
	const roleBadge = roleLabel ? ansiDim(`[${roleLabel}]`) : "";

	// Status text
	let statusText: string;
	if (agent.status === "failed") {
		const err = agent.error ?? "unknown error";
		statusText = `${STATUS_LABEL.failed}: ${err}`;
	} else if (agent.status === "completed") {
		statusText = ansiFg(SATOPI_COLORS.success.ansi256, STATUS_LABEL.completed);
	} else if (agent.status === "running") {
		statusText = ansiFg(SATOPI_COLORS.info.ansi256, STATUS_LABEL.running);
	} else {
		statusText = ansiDim(STATUS_LABEL[agent.status] ?? agent.status);
	}

	// Duration
	let durationStr = "";
	if (agent.startedAt) {
		const end = agent.completedAt ?? Date.now();
		const ms = end - agent.startedAt;
		durationStr = ansiDim(`(${_formatDuration(ms)})`);
	}

	// Assemble and fit
	const segments: string[] = [glyphStr, name];
	if (roleBadge) segments.push(roleBadge);
	segments.push(statusText);
	if (durationStr) segments.push(durationStr);

	let line = " " + segments.join(" ");

	// If too long, truncate the status text (keep prefix + duration)
	if (visibleLength(line) > innerWidth) {
		const minimal = ` ${glyphStr} ${name}`;
		const suffix = durationStr ? ` ${durationStr}` : "";
		// Space budget for the status text portion after "minimal suffix"
		const statusBudget = innerWidth - visibleLength(minimal) - visibleLength(suffix) - 1; // -1 for space before status

		if (agent.status === "failed" && statusBudget > 10) {
			const err = agent.error ?? "unknown error";
			const failedLabel = "failed: ";
			// The error portion has `failed: ` prefix taking up space
			const errBudget = statusBudget - failedLabel.length;
			if (errBudget >= 3) {
				const truncated = err.length > errBudget ? err.slice(0, Math.max(1, errBudget - 3)) + "..." : err;
				line = `${minimal} ${ansiFg(SATOPI_COLORS.danger.ansi256, `${failedLabel}${truncated}`)}${suffix}`;
			} else {
				line = `${minimal}${suffix}`;
			}
		} else if (statusBudget >= 3) {
			const label = STATUS_LABEL[agent.status] ?? agent.status;
			const truncated = label.length > statusBudget ? label.slice(0, Math.max(1, statusBudget - 3)) + "..." : label;
			line = `${minimal} ${ansiDim(truncated)}${suffix}`;
		} else {
			line = `${minimal}${suffix}`;
		}
	}

	return _padLine(line, maxWidth);
}

/**
 * Format a millisecond duration into a human-readable string.
 *
 *  < 1s  → "<1s"
 *  < 60s → "Xs"
 *  < 1h  → "Xm Xs"
 *  >= 1h → "Xh Xm"
 */
function _formatDuration(ms: number): string {
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

/**
 * Build a top border line.
 *   ┌─ Title ────────────────────────────┐
 */
function _makeHeader(title: string, width: number, h: string, tl: string, tr: string): string {
	const inner = `─ ${title} `;
	const remaining = width - tl.length - inner.length - tr.length;
	const fill = remaining > 0 ? h.repeat(remaining) : "";
	return `${tl}${inner}${fill}${tr}`;
}

/**
 * Build a bottom border line.
 *   └─────────────────────────────────────┘
 */
function _makeFooter(width: number, h: string, bl: string, br: string): string {
	const fill = width - bl.length - br.length;
	return `${bl}${h.repeat(Math.max(0, fill))}${br}`;
}

/**
 * Pad a content line with spaces so its visible width equals `width`,
 * then close with the right border. Truncates content if it exceeds
 * the available width.
 */
function _padLine(content: string, width: number): string {
	const maxContent = width - 1; // -1 for right border V
	let result = content;
	if (visibleLength(content) > maxContent) {
		// Truncate preserving ANSI codes
		let truncated = "";
		let visible = 0;
		const limit = maxContent - 3; // reserve for "..."
		let inAnsi = false;
		for (const ch of content) {
			if (ch === "\x1b") {
				inAnsi = true;
				truncated += ch;
				continue;
			}
			if (inAnsi) {
				truncated += ch;
				if (ch === "m") inAnsi = false;
				continue;
			}
			if (visible >= limit) break;
			truncated += ch;
			visible++;
		}
		result = truncated + "...";
	}
	const padding = Math.max(0, width - visibleLength(result) - 1);
	return result + " ".repeat(padding) + V;
}

/**
 * Render an empty/error panel with a single message line.
 */
function _emptyPanel(maxWidth: number, message: string): string[] {
	const innerWidth = maxWidth - 4;
	if (innerWidth < 5) return [];
	const lines: string[] = [];
	lines.push(_makeHeader("Agents", maxWidth, H, TOP_LEFT, TOP_RIGHT));
	lines.push(_padLine(` ${ansiDim(message)}`, maxWidth));
	lines.push(_makeFooter(maxWidth, H, BOTTOM_LEFT, BOTTOM_RIGHT));
	return lines;
}
