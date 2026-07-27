/**
 * Context & Offload Panel — renders ContextManager + Offload pipeline status.
 *
 * Shows:
 *  - Context pipeline sources (active / inactive)
 *  - Offload L1→L3 pipeline stats
 *  - Per-agent context window usage
 */
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
 * Render the Context & Offload status panel.
 *
 * Returns an array of ANSI-colored strings, one per display line.
 * Every visible line is guaranteed to be at most `maxWidth` characters wide.
 *
 * Sections:
 *  1. Context Pipeline sources (✓ = active, · = inactive)
 *  2. Offload L1→L3 pipeline stats
 *  3. Per-agent context window usage (tokens / budget + percentage)
 *
 * Gracefully handles:
 *  - Empty sources / agents arrays
 *  - Null/undefined state (returns empty panel with message)
 *  - Zero tokenBudget (avoids division by zero)
 */
export function renderContextPanel(state: ContextPanelState | null | undefined, maxWidth: number): string[] {
	if (!state) {
		return _emptyPanel(maxWidth, "No context state");
	}

	const innerWidth = maxWidth - 4; // "│ " + content + " │"
	if (innerWidth < 10) return [];

	const lines: string[] = [];

	// Header
	lines.push(_makeHeader("Context & Offload", maxWidth));

	// Section 1: Sources
	lines.push(..._renderSources(state.sources, innerWidth, maxWidth));

	// Section 2: Offload pipeline
	lines.push(..._renderOffloadPipeline(state, innerWidth, maxWidth));

	// Section 3: Agent context windows
	lines.push(..._renderAgentWindows(state.agents, innerWidth, maxWidth));

	// Footer
	lines.push(_makeFooter(maxWidth));

	return lines;
}

// ============================================================================
// Section renderers
// ============================================================================

/**
 * Render context pipeline sources.
 *
 *   ✓ RoleSource · ✓ ProfileSource · ✓ ExperienceSource
 *   ✓ StigmergySource · ✓ OffloadSource (MMD)
 */
function _renderSources(sources: ContextSourceStatus[], innerWidth: number, maxWidth: number): string[] {
	const lines: string[] = [];

	if (sources.length === 0) {
		lines.push(_padLine(` ${ansiDim("No context sources configured")}`, maxWidth));
		return lines;
	}

	let sourceLine = " ";
	for (let i = 0; i < sources.length; i++) {
		const src = sources[i];
		const marker = src.active ? ansiFg(SATOPI_COLORS.success.ansi256, "✓") : ansiDim("·");
		const name = src.active ? ansiBold(src.name) : ansiDim(src.name);
		const segment = `${marker} ${name}`;

		if (i > 0) sourceLine += "  ";
		sourceLine += segment;
	}

	lines.push(_padLineTrunc(sourceLine, innerWidth, maxWidth));
	return lines;
}

/**
 * Render the offload L1→L3 pipeline summary.
 *
 *   L1 Pending: 7 entries · L2 Last flush: 2m ago
 *   L3 Mermaid: context-graph.mmd (12 nodes, 8 edges)
 */
function _renderOffloadPipeline(state: ContextPanelState, innerWidth: number, maxWidth: number): string[] {
	const lines: string[] = [];

	// L1 + L2 on one line
	const l1Text = ansiFg(
		state.l1PendingCount > 0 ? SATOPI_COLORS.warning.ansi256 : SATOPI_COLORS.muted.ansi256,
		`${state.l1PendingCount}`,
	);
	const l2Text = _formatTimeAgo(state.l2LastFlushSeconds);

	const l1l2Line = ` L1 Pending: ${l1Text} entries · L2 Last flush: ${l2Text}`;
	lines.push(_padLineTrunc(l1l2Line, innerWidth, maxWidth));

	// L3
	const l3Line = ` L3 Mermaid: context-graph.mmd (${state.l3Nodes} nodes, ${state.l3Edges} edges)`;
	lines.push(_padLineTrunc(l3Line, innerWidth, maxWidth));

	return lines;
}

/**
 * Render per-agent context window usage.
 *
 *   agent-1:  8,234 / 32,768 tokens (25%)
 *   agent-2: 12,456 / 32,768 tokens (38%)
 *
 * Color-coded: green < 50%, amber 50-80%, red > 80%.
 */
function _renderAgentWindows(agents: AgentContextInfo[], innerWidth: number, maxWidth: number): string[] {
	const lines: string[] = [];

	if (agents.length === 0) {
		lines.push(_padLine(` ${ansiDim("No agent context windows")}`, maxWidth));
		return lines;
	}

	// Section label
	lines.push(_padLine(` ${ansiBold("Context Windows:")}`, maxWidth));

	// Sort by usage percentage descending
	const sorted = [...agents].sort((a, b) => {
		const pctA = a.tokenBudget > 0 ? a.tokensUsed / a.tokenBudget : 0;
		const pctB = b.tokenBudget > 0 ? b.tokensUsed / b.tokenBudget : 0;
		return pctB - pctA;
	});

	for (const agent of sorted) {
		const pct = agent.tokenBudget > 0 ? agent.tokensUsed / agent.tokenBudget : 0;
		const pctColor =
			pct > 0.8
				? SATOPI_COLORS.danger.ansi256
				: pct > 0.5
					? SATOPI_COLORS.warning.ansi256
					: SATOPI_COLORS.success.ansi256;

		const used = _formatNumber(agent.tokensUsed);
		const budget = _formatNumber(agent.tokenBudget);
		const pctStr = `${Math.round(pct * 100)}%`;

		const line = `  ${agent.agentId}: ${used} / ${budget} tokens (${ansiFg(pctColor, pctStr)})`;
		lines.push(_padLineTrunc(line, innerWidth, maxWidth));
	}

	return lines;
}

// ============================================================================
// Utility helpers
// ============================================================================

/**
 * Format a duration in seconds as a human-friendly string.
 *  < 5s  → "just now"
 *  < 60s → "Xs ago"
 *  < 3600s → "Xm ago"
 *  >= 3600s → "Xh Xm ago"
 */
function _formatTimeAgo(seconds: number): string {
	if (seconds < 0) return "just now";
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${Math.floor(seconds)}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	const hr = Math.floor(seconds / 3600);
	const min = Math.floor((seconds % 3600) / 60);
	return min > 0 ? `${hr}h ${min}m ago` : `${hr}h ago`;
}

/**
 * Format a number with locale-aware thousands separators.
 * Falls back to a simple regex if Intl is not available.
 */
function _formatNumber(n: number): string {
	if (typeof Intl !== "undefined" && Intl.NumberFormat) {
		return new Intl.NumberFormat("en-US").format(n);
	}
	return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Build a top border line.
 */
function _makeHeader(title: string, width: number): string {
	const inner = `─ ${title} `;
	const remaining = width - TOP_LEFT.length - inner.length - TOP_RIGHT.length;
	const fill = remaining > 0 ? H.repeat(remaining) : "";
	return `${TOP_LEFT}${inner}${fill}${TOP_RIGHT}`;
}

/**
 * Build a bottom border line.
 */
function _makeFooter(width: number): string {
	const fill = width - BOTTOM_LEFT.length - BOTTOM_RIGHT.length;
	return `${BOTTOM_LEFT}${H.repeat(Math.max(0, fill))}${BOTTOM_RIGHT}`;
}

/**
 * Pad a content line so its visible width fills to `width - 1`,
 * then close with the right border.
 */
function _padLine(content: string, width: number): string {
	const visible = visibleLength(content);
	const padding = Math.max(0, width - visible - 1); // -1 for right border V
	return content + " ".repeat(padding) + V;
}

/**
 * Pad a content line, truncating if it exceeds innerWidth.
 */
function _padLineTrunc(content: string, innerWidth: number, maxWidth: number): string {
	if (visibleLength(content) <= innerWidth) {
		return _padLine(content, maxWidth);
	}
	// Truncate to fit
	let truncated = "";
	let visible = 0;
	const limit = innerWidth - 3; // reserve space for "..."
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
	truncated += "...";
	return _padLine(truncated, maxWidth);
}

/**
 * Render an empty/error panel with a single message line.
 */
function _emptyPanel(maxWidth: number, message: string): string[] {
	const innerWidth = maxWidth - 4;
	if (innerWidth < 5) return [];
	const lines: string[] = [];
	lines.push(_makeHeader("Context & Offload", maxWidth));
	lines.push(_padLine(` ${ansiDim(message)}`, maxWidth));
	lines.push(_makeFooter(maxWidth));
	return lines;
}
