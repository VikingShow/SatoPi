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

import type { Component } from "@satopi/pi-tui";
import type { AgentRef } from "../../../registry/agent-registry";
import type { SwarmState } from "../../../swarm/core/state";
import type { Theme } from "../../theme/theme";
import { renderAgentPanel } from "./agent-panel";
import { type CommMessage, renderCommPanel } from "./comm-panel";
import { type ContextPanelState, renderContextPanel } from "./context-panel";
import { type ModelCostInfo, renderCostLine } from "./cost-panel";
import { type GraphViewInput, renderGraphView } from "./graph-view";
import { renderPhaseView } from "./phase-view";
import { renderPlanPanel } from "./plan-view";
import { type RoundtableViewState, renderRoundtableView } from "./roundtable-view";
import { renderTaskPanel, type TaskPanelInput } from "./task-panel";

// ============================================================================
// Types
// ============================================================================

export interface DashboardInput {
	agents: AgentRef[];
	swarm: SwarmState;
	messages: CommMessage[];
	context: ContextPanelState;
	graphView?: GraphViewInput;
	taskPanel?: TaskPanelInput;
	theme: Theme;
	/** Per-million-token pricing for the active model, used to estimate cost. */
	modelCost?: ModelCostInfo;
	/** Raw plan.md content for the plan structure panel. */
	planContent?: string;
	/** Roundtable debate state — populated during plan debate phase. */
	roundtable?: RoundtableViewState;
}

// ============================================================================
// Public API
// ============================================================================

export function renderDashboard(input: DashboardInput): Component {
	const { theme, graphView } = input;

	// Graph-only mode
	if (graphView?.graph && Object.keys(graphView.graph.nodes).length > 0) {
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

function renderSingleColumn(input: DashboardInput, width: number): string[] {
	const lines: string[] = [];
	const { agents, swarm, messages, context, theme, modelCost, planContent } = input;

	lines.push(...renderPhaseView(swarm, theme, width));
	lines.push(...renderPlanPanel(planContent, theme).render(width));
	lines.push("");
	lines.push("");
	lines.push(...renderAgentPanel(agents, swarm, theme).render(width));
	lines.push("");
	if (input.roundtable) {
		lines.push(...renderRoundtableView(input.roundtable, theme).render(width));
		lines.push("");
	}
	lines.push(...renderCommPanel(messages, theme).render(width));
	lines.push("");
	lines.push(...renderContextPanel(context, theme).render(width));
	if (input.taskPanel && input.taskPanel.todos.length > 0) {
		lines.push(...renderTaskPanel(input.taskPanel, theme).render(width));
		lines.push("");
	}
	lines.push("");
	lines.push(renderCostLine(swarm.totalTokens, modelCost, theme));

	return lines;
}

function renderTwoColumn(input: DashboardInput, width: number): string[] {
	const lines: string[] = [];
	const { agents, swarm, messages, context, theme, planContent } = input;

	const leftWidth = Math.floor(width * 0.45);
	const rightWidth = width - leftWidth - 2;

	// Phase bar (full width)
	lines.push(...renderPhaseView(swarm, theme, width));
	lines.push("");
	lines.push(...renderPlanPanel(planContent, theme).render(width));
	lines.push("");
	const agentLines = renderAgentPanel(agents, swarm, theme).render(leftWidth);

	// Right: Roundtable (during debate) or Comm + Context stacked
	let rightLines: string[];
	if (input.roundtable) {
		const rtLines = renderRoundtableView(input.roundtable, theme).render(rightWidth);
		const ctxLines = renderContextPanel(context, theme).render(rightWidth);
		rightLines = [...rtLines, "", ...ctxLines];
	} else {
		const recentMsgs = messages.slice(0, 5);
		const commLines = renderCommPanel(recentMsgs, theme).render(rightWidth);
		const contextLines = renderContextPanel(context, theme).render(rightWidth);
		rightLines = [...commLines, ...contextLines];
	}

	// Interleave
	const maxLeft = agentLines.length;
	const maxRight = rightLines.length;
	const spacer = "  ";

	for (let i = 0; i < Math.max(maxLeft, maxRight); i++) {
		const left = i < maxLeft ? agentLines[i] : "";
		const right = i < maxRight ? rightLines[i] : "";
		lines.push(`${left.padEnd(leftWidth)}${spacer}${right}`);
	}
	// Task panel — full width below columns
	if (input.taskPanel && input.taskPanel.todos.length > 0) {
		lines.push("");
		const taskLines = renderTaskPanel(input.taskPanel, theme).render(width);
		lines.push(...taskLines);
	}
	return lines;
}

function renderCompact(input: DashboardInput, _width: number): string[] {
	const lines: string[] = [];
	const { agents, swarm, theme, modelCost } = input;

	lines.push(...renderPhaseView(swarm, theme, _width));

	const agentCount = agents.length > 0 ? agents.length : Object.keys(swarm.agents ?? {}).length;
	const status = swarm.status ?? "idle";
	lines.push(theme.fg("dim", `[${status}] phase=${swarm.phase ?? "idle"} agents=${agentCount}`));

	// Condensed roundtable
	if (input.roundtable) {
		const rt = input.roundtable;
		const convergeIcon = rt.converged ? theme.fg("success", "✓") : theme.fg("warning", "◌");
		lines.push(theme.fg("accent", `  Roundtable: Round ${rt.currentRound}/${rt.totalRounds} ${convergeIcon}`));
	}

	if (agents.length > 0) {
		for (const ref of agents) {
			const glyph = ref.status === "running" ? "◌" : ref.status === "idle" || ref.status === "parked" ? "✓" : "·";
			lines.push(`  ${glyph} ${ref.displayName}`);
		}
	} else {
		for (const agent of Object.values(swarm.agents ?? {})) {
			const glyph = agent.status === "completed" ? "✓" : agent.status === "running" ? "◌" : "·";
			lines.push(`  ${glyph} ${agent.role ?? "agent"}`);
		}
	}

	lines.push("");
	lines.push(renderCostLine(swarm.totalTokens, modelCost, theme));

	return lines;
}
