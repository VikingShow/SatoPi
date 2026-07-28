/**
 * GraphView — Mermaid-like ASCII DAG rendering component for the SwarmDashboard.
 *
 * Renders a theatre graph's nodes and edges as ANSI-coloured box-drawing art
 * inside a system `framedBlock`.  Uses the global `theme` for all colours.
 */

import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";
import type { Theme, ThemeColor } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";

// ============================================================================
// Public types
// ============================================================================

export interface GraphViewInput {
	graph: GraphViewGraph;
	currentWave?: number;
	totalWaves?: number;
	width: number;
}

export interface GraphViewGraph {
	nodes: Record<string, GraphViewNode>;
	edges?: GraphViewEdge[];
}

export interface GraphViewNode {
	label: string;
	status: string;
}

export interface GraphViewEdge {
	from: string;
	to: string;
	artifacts?: string[];
}

// ============================================================================
// Constants
// ============================================================================

const MIN_BOX_CONTENT_W = 12;
const INTER_NODE_GAP = 4;

// ============================================================================
// Internal layout types
// ============================================================================

interface NodeLayout {
	id: string;
	label: string;
	status: string;
	col: number;
	boxW: number;
	contentW: number;
}

interface WaveLayout {
	nodes: NodeLayout[];
}

// ============================================================================
// Public API
// ============================================================================

export function renderGraphView(input: GraphViewInput, theme: Theme): Component {
	const maxWidth = input.width;
	const nodeIds = Object.keys(input.graph.nodes ?? {});

	const title = nodeIds.length > 0
		? `Theatre Graph · ${nodeIds.length} nodes`
		: "Theatre Graph";

	return swarmPanel(title, ({ innerWidth, theme: t }) => {
		if (maxWidth < 40) return narrowFallback(input, maxWidth, t);
		if (nodeIds.length === 0) return [t.fg("dim", "  (no graph loaded)")];

		const depths = computeDepths(input.graph);
		const waveGroups = groupByDepth(depths);
		const waves = assignColumns(waveGroups, input.graph, maxWidth);
		const totalWaves = input.totalWaves ?? waves.length;
		const currentWave = input.currentWave ?? 0;

		const lines: string[] = [];

		lines.push(""); // spacing after header
		lines.push(...renderWaveBar(waves, currentWave, totalWaves, maxWidth, t));
		lines.push("");

		for (let wi = 0; wi < waves.length; wi++) {
			lines.push(...renderWaveBoxes(waves[wi], maxWidth, t));
			if (wi < waves.length - 1) {
				lines.push(...renderEdgeLines(waves[wi], waves[wi + 1], input.graph.edges ?? [], maxWidth, t));
			}
		}

		return lines;
	}, theme, { headerMeta: buildFooterStats(input) });
}

// ============================================================================
// Topological layout
// ============================================================================

function computeDepths(graph: GraphViewGraph): Map<string, number> {
	const nodeIds = Object.keys(graph.nodes);
	const edges = graph.edges ?? [];

	const predecessors = new Map<string, string[]>();
	for (const id of nodeIds) predecessors.set(id, []);

	for (const e of edges) {
		const preds = predecessors.get(e.to);
		if (preds) preds.push(e.from);
	}

	const depths = new Map<string, number>();
	const visited = new Set<string>();

	function dfs(id: string): number {
		if (visited.has(id)) return depths.get(id) ?? 0;
		visited.add(id);
		let maxDepth = 0;
		for (const pred of predecessors.get(id) ?? []) {
			maxDepth = Math.max(maxDepth, dfs(pred) + 1);
		}
		depths.set(id, maxDepth);
		return maxDepth;
	}

	for (const id of nodeIds) dfs(id);
	return depths;
}

function groupByDepth(depths: Map<string, number>): string[][] {
	const groups = new Map<number, string[]>();
	for (const [id, depth] of depths) {
		const list = groups.get(depth) ?? [];
		list.push(id);
		groups.set(depth, list);
	}
	const result: string[][] = [];
	for (let d = 0; groups.has(d); d++) {
		result.push(groups.get(d)!);
	}
	return result;
}

function assignColumns(
	waveGroups: string[][],
	graph: GraphViewGraph,
	maxWidth: number,
): WaveLayout[] {
	return waveGroups.map(group => {
		const nodeCount = group.length;
		const contentW = Math.min(
			MIN_BOX_CONTENT_W,
			Math.floor((maxWidth - INTER_NODE_GAP * (nodeCount - 1) - 4) / nodeCount),
		);
		const boxW = contentW + 4;
		const totalWidth = nodeCount * boxW + INTER_NODE_GAP * (nodeCount - 1);
		const startCol = Math.floor((maxWidth - totalWidth) / 2);

		const nodes: NodeLayout[] = group.map((id, i) => ({
			id,
			label: graph.nodes[id]?.label ?? id,
			status: graph.nodes[id]?.status ?? "pending",
			col: startCol + i * (boxW + INTER_NODE_GAP),
			boxW,
			contentW,
		}));

		return { nodes };
	});
}

// ============================================================================
// Rendering helpers — colours via theme
// ============================================================================

const STATUS_GLYPH: Record<string, string> = {
	completed: "✓",
	running: "◌",
	waiting: "○",
	failed: "✗",
	pending: "·",
	aborted: "⊘",
	skipped: "⊘",
};

function statusColor(status: string, theme: Theme): ThemeColor {
	switch (status) {
		case "completed": return "success";
		case "running": return "accent";
		case "waiting": return "warning";
		case "failed": return "error";
		case "aborted": return "error";
		default: return "dim";
	}
}

function truncateToFit(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 1) + "…";
}

function buildFooterStats(input: GraphViewInput): string {
	const nodes = Object.values(input.graph.nodes ?? {});
	const total = nodes.length;
	const completed = nodes.filter(n => n.status === "completed").length;
	const running = nodes.filter(n => n.status === "running").length;
	const parts: string[] = [];
	if (completed > 0) parts.push(`${completed} done`);
	if (running > 0) parts.push(`${running} running`);
	parts.push(`${total} total`);
	return parts.join(" · ");
}

// ============================================================================
// Wave bar
// ============================================================================

function renderWaveBar(
	waves: WaveLayout[],
	currentWave: number,
	totalWaves: number,
	maxWidth: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const barWidth = Math.min(maxWidth - 4, 60);
	for (let wi = 0; wi < waves.length; wi++) {
		const wave = waves[wi];
		const isCurrent = wi === currentWave;
		const nodeGlyphs = wave.nodes.map(n => {
			const glyph = STATUS_GLYPH[n.status] ?? "·";
			const c = statusColor(n.status, theme);
			if (isCurrent) return theme.fg(c, glyph);
			return theme.fg("dim", glyph);
		});
		const marker = isCurrent ? theme.fg("accent", "▶") : " ";
		const waveLabel = `w${wi + 1}/${totalWaves}`;
		lines.push(` ${marker} ${theme.fg("dim", waveLabel)} ${nodeGlyphs.join(" ")}`);
	}
	return lines;
}

// ============================================================================
// Node boxes
// ============================================================================

function renderWaveBoxes(wave: WaveLayout, maxWidth: number, theme: Theme): string[] {
	const lines: string[] = [];

	// Top edge
	let topLine = "";
	for (const node of wave.nodes) {
		const c = statusColor(node.status, theme);
		const top = theme.fg(c, "┌") + theme.fg(c, "─".repeat(node.boxW - 2)) + theme.fg(c, "┐");
		const pad = node.col - (topLine.length);
		topLine += " ".repeat(Math.max(0, pad)) + top;
	}
	lines.push(topLine);

	// Content row
	let contentLine = "";
	for (const node of wave.nodes) {
		const c = statusColor(node.status, theme);
		const label = truncateToFit(node.label, node.contentW);
		const padded = label.padEnd(node.contentW);
		const content = theme.fg(c, "│") + " " + padded + " " + theme.fg(c, "│");
		const pad = node.col - (contentLine.length);
		contentLine += " ".repeat(Math.max(0, pad)) + content;
	}
	lines.push(contentLine);

	// Bottom edge
	let bottomLine = "";
	for (const node of wave.nodes) {
		const c = statusColor(node.status, theme);
		const bottom = theme.fg(c, "└") + theme.fg(c, "─".repeat(node.boxW - 2)) + theme.fg(c, "┘");
		const pad = node.col - (bottomLine.length);
		bottomLine += " ".repeat(Math.max(0, pad)) + bottom;
	}
	lines.push(bottomLine);

	return lines;
}

// ============================================================================
// Edge lines
// ============================================================================

function renderEdgeLines(
	fromWave: WaveLayout,
	toWave: WaveLayout,
	edges: GraphViewEdge[],
	maxWidth: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const edgeMap = new Map<string, string[]>();
	for (const e of edges) {
		const key = `${e.from}→${e.to}`;
		const list = edgeMap.get(key) ?? [];
		list.push(...(e.artifacts ?? []));
		edgeMap.set(key, list);
	}

	// Find center columns for each node
	const fromCenters = new Map<string, number>();
	for (const n of fromWave.nodes) {
		fromCenters.set(n.id, n.col + Math.floor(n.boxW / 2));
	}
	const toCenters = new Map<string, number>();
	for (const n of toWave.nodes) {
		toCenters.set(n.id, n.col + Math.floor(n.boxW / 2));
	}

	for (const [key, artifacts] of edgeMap) {
		const [fromId, toId] = key.split("→");
		const fromCol = fromCenters.get(fromId);
		const toCol = toCenters.get(toId);
		if (fromCol == null || toCol == null) continue;

		const minCol = Math.min(fromCol, toCol);
		const maxCol = Math.max(fromCol, toCol);
		let line = " ".repeat(minCol);

		if (fromCol <= toCol) {
			// Down-right
			line += theme.fg("dim", "│");
			line += " ".repeat(maxCol - minCol - 1);
			line += theme.fg("dim", "▼");
		} else {
			// Down-left
			line += theme.fg("dim", "▼");
			line += " ".repeat(maxCol - minCol - 1);
			line += theme.fg("dim", "│");
		}

		if (artifacts.length > 0) {
			line += "  " + theme.fg("dim", artifacts.slice(0, 3).join(", "));
		}
		lines.push(line);
	}

	return lines;
}

// ============================================================================
// Fallbacks
// ============================================================================

function narrowFallback(_input: GraphViewInput, maxWidth: number, theme: Theme): string[] {
	return [theme.fg("dim", "  (terminal too narrow for graph view)")];
}
