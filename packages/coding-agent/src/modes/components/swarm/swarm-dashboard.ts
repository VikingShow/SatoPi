/**
 * SwarmDashboard — unified SatoPi TUI dashboard.
 *
 * Assembles all TUI panels into a single multi-section view using `Component`
 * composition. Each panel is now a `Component` backed by `framedBlock`.
 *
 * Layout adapts to terminal width:
 *   >= 100 cols → two-column (agents | comm/context)
 *   >= 60 cols  → single-column
 *   < 60 cols   → compact mode
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { Container } from "@oh-my-pi/pi-tui";
import type { AgentRef } from "../../../registry/agent-registry";
import type { SwarmState } from "../../../swarm/core/state";
import type { Theme } from "../../theme/theme";
import { renderAgentPanel } from "./agent-panel";
import { type CommMessage, renderCommPanel } from "./comm-panel";
import { type ContextPanelState, renderContextPanel } from "./context-panel";
import { type GraphViewInput, renderGraphView } from "./graph-view";
import { renderPhaseView } from "./phase-view";

// ============================================================================
// Types
// ============================================================================

export interface DashboardInput {
	agents: AgentRef[];
	swarm: SwarmState;
	messages: CommMessage[];
	context: ContextPanelState;
	graphView?: GraphViewInput;
	theme: Theme;
}

// ============================================================================
// Public API
// ============================================================================

export function renderDashboard(input: DashboardInput): Component {
	const { theme, graphView } = input;

	// Graph-only mode
	if (graphView && graphView.graph && Object.keys(graphView.graph.nodes).length > 0) {
		return renderGraphView(graphView, theme);
	}

	return {
		render: (width: number): readonly string[] => {
			if (width < 60) return renderCompact(input, width);
			if (width < 100) return renderSingleColumn(input, width);
			return renderTwoColumn(input, width);
		},
		invalidate: () => {},
	};
}

// ============================================================================
// Layouts
// ============================================================================

function renderSingleColumn(input: DashboardInput, width: number): string[] {
	const lines: string[] = [];
	const { agents, swarm, messages, context, theme } = input;

	lines.push(...renderPhaseView(swarm, theme));
	lines.push("");
	lines.push(...renderAgentPanel(agents, swarm, theme).render(width));
	lines.push("");
	lines.push(...renderCommPanel(messages, theme).render(width));
	lines.push("");
	lines.push(...renderContextPanel(context, theme).render(width));

	return lines;
}

function renderTwoColumn(input: DashboardInput, width: number): string[] {
	const lines: string[] = [];
	const { agents, swarm, messages, context, theme } = input;

	const leftWidth = Math.floor(width * 0.45);
	const rightWidth = width - leftWidth - 2;

	// Phase bar (full width)
	lines.push(...renderPhaseView(swarm, theme));
	lines.push("");

	// Left: Agent panel
	const agentLines = renderAgentPanel(agents, swarm, theme).render(leftWidth);

	// Right: Comm + Context stacked
	const recentMsgs = messages.slice(0, 5);
	const commLines = renderCommPanel(recentMsgs, theme).render(rightWidth);
	const contextLines = renderContextPanel(context, theme).render(rightWidth);

	// Interleave
	const maxLeft = agentLines.length;
	const maxRight = Math.max(commLines.length, contextLines.length);
	const spacer = "  ";

	for (let i = 0; i < Math.max(maxLeft, maxRight); i++) {
		const left = i < maxLeft ? agentLines[i] : "";
		const right = i < maxRight
			? (i < commLines.length ? commLines[i] : contextLines[i - commLines.length] ?? "")
			: "";
		lines.push(`${left.padEnd(leftWidth)}${spacer}${right}`);
	}

	return lines;
}

function renderCompact(input: DashboardInput, _width: number): string[] {
	const lines: string[] = [];
	const { agents, swarm, theme } = input;

	lines.push(...renderPhaseView(swarm, theme));

	const agentCount = agents.length > 0 ? agents.length : Object.keys(swarm.agents ?? {}).length;
	const status = swarm.status ?? "idle";
	lines.push(theme.fg("dim", `[${status}] phase=${swarm.phase ?? "idle"} agents=${agentCount}`));

	if (agents.length > 0) {
		for (const ref of agents) {
			const glyph = ref.status === "running" ? "◌" : (ref.status === "idle" || ref.status === "parked") ? "✓" : "·";
			lines.push(`  ${glyph} ${ref.displayName}`);
		}
	} else {
		for (const agent of Object.values(swarm.agents ?? {})) {
			const glyph = agent.status === "completed" ? "✓" : agent.status === "running" ? "◌" : "·";
			lines.push(`  ${glyph} ${agent.role ?? "agent"}`);
		}
	}

	return lines;
}
