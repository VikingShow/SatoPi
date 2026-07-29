/**
 * Context Panel — renders context pipeline and offload status inside a system
 * `framedBlock`.  Uses the global `theme` for all colours.
 */

import type { Component } from "@satopi/pi-tui";
import { AgentRegistry } from "../../../registry/agent-registry";
import type { AgentSession } from "../../../session/agent-session";
import type { Theme } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";

// ============================================================================
// Types
// ============================================================================

export interface ContextSourceStatus {
	name: string;
	active: boolean;
}

export interface AgentContextInfo {
	agentId: string;
	tokensUsed: number;
	tokenBudget: number;
}

export interface ContextPanelState {
	sources: ContextSourceStatus[];
	l1PendingCount: number;
	l2LastFlushSeconds: number;
	l3Nodes: number;
	l3Edges: number;
	agents: AgentContextInfo[];
}

// ============================================================================
// Public API
// ============================================================================

export function renderContextPanel(state: ContextPanelState, theme: Theme, agentSession?: AgentSession): Component {
	return swarmPanel(
		"Context",
		({ innerWidth, theme: t }) => {
			const enrichedAgents = deriveAgentContext(agentSession, state.agents);
			const lines: string[] = [];

			// Sources
			lines.push(...renderSources(state.sources, t));
			if (state.l1PendingCount > 0 || state.l2LastFlushSeconds > 0) {
				const parts: string[] = [];
				if (state.l1PendingCount > 0) parts.push(t.fg("warning", `L1: ${state.l1PendingCount} pending`));
				if (state.l2LastFlushSeconds > 0) parts.push(t.fg("dim", `L2 flush: ${state.l2LastFlushSeconds}s ago`));
				lines.push(`  ${parts.join("  ")}`);
			}

			// L3 graph stats
			if (state.l3Nodes > 0 || state.l3Edges > 0) {
				lines.push(t.fg("dim", `  L3: ${state.l3Nodes} nodes, ${state.l3Edges} edges`));
			}

			// Agent context windows
			if (enrichedAgents.length > 0) {
				lines.push("");
				lines.push(...renderAgentWindows(enrichedAgents, innerWidth, t));
			}

			if (lines.length === 0) {
				return [t.fg("dim", "  No context data")];
			}
			return lines;
		},
		theme,
		{ applyBg: false },
	);
}

// ============================================================================
// Internal
// ============================================================================

function deriveAgentContext(
	agentSession: AgentSession | undefined,
	existingAgents: AgentContextInfo[],
): AgentContextInfo[] {
	if (existingAgents.length > 0) return existingAgents;
	if (!agentSession) return [];

	const refs = AgentRegistry.global().list();
	return refs
		.filter(ref => ref.kind === "persistent" || ref.kind === "sub")
		.map(ref => ({
			agentId: ref.displayName,
			tokensUsed: 0,
			tokenBudget: 0,
		}));
}

function renderSources(sources: ContextSourceStatus[], theme: Theme): string[] {
	return sources.map(s => {
		const glyph = s.active ? theme.fg("success", "●") : theme.fg("dim", "○");
		return `  ${glyph} ${s.name}`;
	});
}

function renderAgentWindows(agents: AgentContextInfo[], _maxWidth: number, theme: Theme): string[] {
	return agents.map(a => {
		const usage = a.tokenBudget > 0 ? Math.round((a.tokensUsed / a.tokenBudget) * 100) : 0;
		const bar = renderUsageBar(usage, 10, theme);
		return `  ${a.agentId}  ${bar}  ${theme.fg("dim", `${a.tokensUsed}/${a.tokenBudget}`)}`;
	});
}

function renderUsageBar(pct: number, width: number, theme: Theme): string {
	const filled = Math.round((pct / 100) * width);
	const empty = width - filled;
	const color = pct > 80 ? "error" : pct > 50 ? "warning" : "success";
	return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
}
