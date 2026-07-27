/**
 * SwarmDashboard — unified SatoPi TUI dashboard.
 *
 * Assembles all TUI panels into a single multi-section view:
 *   1. Phase lifecycle progress bar
 *   2. Agent status panel
 *   3. Communications log
 *   4. Context & Offload status
 *
 * Automatically adapts layout to terminal width:
 *   >= 100 cols → two-column (agents | comm/context)
 *   >= 60 cols  → single-column
 *   < 60 cols   → compact mode (abbreviated labels)
 */

import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { SwarmState } from "../../../swarm/core/state";
import { renderAgentPanel } from "./agent-panel";
import { type CommMessage, renderCommPanel } from "./comm-panel";
import { type ContextPanelState, renderContextPanel } from "./context-panel";
import { makeFooter, makeHeader, padLine } from "./panel-utils";
import { renderPhaseView } from "./phase-view";
import { sato } from "./theme";

// ============================================================================
// Types
// ============================================================================

export interface DashboardInput {
	/** Current swarm pipeline state */
	swarm: SwarmState;
	/** Recent communication messages (newest first) */
	messages: CommMessage[];
	/** Context & offload pipeline state */
	context: ContextPanelState;
}

// ============================================================================
// Layout
// ============================================================================

/** Render the full SatoPi dashboard. */
export function renderDashboard(input: DashboardInput, width: number = 80): string[] {
	const minWidth = Math.max(40, width);
	const compactThreshold = 60;
	const twoColumnThreshold = 100;

	if (minWidth < compactThreshold) {
		return renderCompact(input, minWidth);
	}
	if (minWidth >= twoColumnThreshold) {
		return renderTwoColumn(input, minWidth);
	}
	return renderSingleColumn(input, minWidth);
}

// ── Single Column (60-99 cols) ────────────────────────────────────────────

function renderSingleColumn(input: DashboardInput, width: number): string[] {
	const lines: string[] = [];

	// Phase bar
	lines.push(...renderPhaseView(input.swarm));
	lines.push("");

	// Agent panel
	lines.push(...renderAgentPanel(input.swarm, width));
	lines.push("");

	// Comm panel (last 5 messages)
	const recentMsgs = input.messages.slice(0, 5);
	lines.push(...renderCommPanel(recentMsgs, width));
	lines.push("");

	// Context panel
	lines.push(...renderContextPanel(input.context, width));

	return lines;
}

// ── Two Column (>= 100 cols) ──────────────────────────────────────────────

function renderTwoColumn(input: DashboardInput, width: number): string[] {
	const lines: string[] = [];
	const leftWidth = Math.floor(width / 2) - 1;
	const rightWidth = width - leftWidth - 3;

	// Phase bar (full width)
	lines.push(...renderPhaseView(input.swarm));
	lines.push("");

	// Left: Agent panel | Right: Comm + Context
	const agentLines = renderAgentPanel(input.swarm, leftWidth);
	const recentMsgs = input.messages.slice(0, 5);
	const commLines = renderCommPanel(recentMsgs, rightWidth);
	const contextLines = renderContextPanel(input.context, rightWidth);

	// Interleave right panels
	const rightCombined = [...commLines, ...contextLines];

	const maxRows = Math.max(agentLines.length, rightCombined.length);
	for (let i = 0; i < maxRows; i++) {
		const left = i < agentLines.length ? agentLines[i] : " ".repeat(leftWidth);
		const right = i < rightCombined.length ? rightCombined[i] : "";
		lines.push(`${left} ${sato.dim("│")} ${right}`);
	}

	return lines;
}

// ── Compact (< 60 cols) ───────────────────────────────────────────────────

function renderCompact(input: DashboardInput, width: number): string[] {
	const lines: string[] = [];

	const phase = input.swarm.phase ?? "idle";
	const agentCount = Object.keys(input.swarm.agents ?? {}).length;
	const status = input.swarm.status ?? "idle";
	lines.push(sato.dim(`[${status}] phase=${phase} agents=${agentCount}`));

	for (const agent of Object.values(input.swarm.agents ?? {})) {
		const glyph =
			agent.status === "completed" ? "✓" : agent.status === "running" ? "◌" : agent.status === "failed" ? "✗" : "·";
		lines.push(`  ${glyph} ${agent.name} [${agent.status}]`);
	}

	return lines;
}
