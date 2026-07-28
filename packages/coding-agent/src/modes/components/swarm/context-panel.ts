/**
 * Context & Offload Panel — renders ContextManager + Offload pipeline status.
 *
 * Shows:
 *  - Context pipeline sources (active / inactive)
 *  - Offload L1→L3 pipeline stats
 *  - Per-agent context window usage
 */

import { makeFooter, makeHeader, padLine } from "./panel-utils";
import { sato } from "./theme";

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

export function renderContextPanel(state: ContextPanelState | null | undefined, maxWidth: number): string[] {
	if (!state) {
		return emptyPanel(maxWidth, "No context state");
	}

	const innerWidth = maxWidth - 4;
	if (innerWidth < 10) return [];

	const lines: string[] = [];
	lines.push(makeHeader("Context", maxWidth));

	// Sources
	lines.push(...renderSources(state.sources, innerWidth, maxWidth));

	// Offload pipeline
	lines.push(padLine("", maxWidth));
	lines.push(...renderOffloadPipeline(state, innerWidth, maxWidth));

	// Agent context windows
	if (state.agents.length > 0) {
		lines.push(padLine("", maxWidth));
		lines.push(...renderAgentWindows(state.agents, innerWidth, maxWidth));
	}

	lines.push(makeFooter(maxWidth));

	return lines;
}

// ============================================================================
// Internal
// ============================================================================

function renderSources(sources: ContextSourceStatus[], _innerWidth: number, maxWidth: number): string[] {
	const lines: string[] = [];
	lines.push(padLine(` ${sato.bold("Sources:")}`, maxWidth));

	for (const src of sources) {
		const glyph = src.active ? sato.success("✓") : sato.muted("·"); // ✓ / ·
		const name = src.active ? sato.text(src.name) : sato.muted(src.name);
		lines.push(padLine(`   ${glyph} ${name}`, maxWidth));
	}

	return lines;
}

function renderOffloadPipeline(state: ContextPanelState, _innerWidth: number, maxWidth: number): string[] {
	const lines: string[] = [];
	lines.push(padLine(` ${sato.bold("Offload:")}`, maxWidth));

	// L1
	const l1Text = state.l1PendingCount > 0 ? sato.warning(`${state.l1PendingCount} pending`) : sato.success("drained");
	lines.push(padLine(`   L1 (summarisation): ${l1Text}`, maxWidth));

	// L2
	const l2Text = formatTimeAgo(state.l2LastFlushSeconds);
	lines.push(padLine(`   L2 (MMD injection): last flush ${l2Text}`, maxWidth));

	// L3
	lines.push(
		padLine(
			`   L3 (knowledge graph): ${sato.info(String(state.l3Nodes))} nodes, ${sato.info(String(state.l3Edges))} edges`,
			maxWidth,
		),
	);

	return lines;
}

function renderAgentWindows(agents: AgentContextInfo[], _innerWidth: number, maxWidth: number): string[] {
	const lines: string[] = [];
	lines.push(padLine(` ${sato.bold("Agent Windows:")}`, maxWidth));

	for (const agent of agents) {
		const pct = agent.tokenBudget > 0 ? Math.round((agent.tokensUsed / agent.tokenBudget) * 100) : 0;
		const colorFn = pct > 80 ? sato.danger : pct > 50 ? sato.warning : sato.success;
		const bar = colorFn(`${pct}%`);
		const tokens = formatNumber(agent.tokensUsed);
		const budget = formatNumber(agent.tokenBudget);
		const name = agent.agentId.length > 20 ? `${agent.agentId.slice(0, 17)}...` : agent.agentId.padEnd(20);

		// Budget for the per-agent line
		const line = `   ${name} ${bar}  (${tokens} / ${budget} tokens)`;
		lines.push(padLine(line, maxWidth));
	}

	return lines;
}

function formatTimeAgo(seconds: number): string {
	if (seconds < 5) return sato.success("just now");
	if (seconds < 60) return sato.muted(`${seconds}s ago`);
	if (seconds < 3600) return sato.muted(`${Math.floor(seconds / 60)}m ago`);
	return sato.muted(`${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`);
}

function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}

function emptyPanel(maxWidth: number, message: string): string[] {
	const innerWidth = maxWidth - 4;
	if (innerWidth < 5) return [];
	return [makeHeader("Context", maxWidth), padLine(` ${sato.dim(message)}`, maxWidth), makeFooter(maxWidth)];
}
