/**
 * GraphView — Mermaid-like ASCII DAG rendering component for the SwarmDashboard.
 *
 * Renders a theatre graph's nodes and edges as ANSI-coloured box-drawing art
 * organised in topological waves (top-to-bottom).  Supports five statuses
 * (pending/running/completed/failed/skipped) with colour coding and
 * current-wave highlighting.
 *
 * ## Layout strategy (v1)
 *   - Compute topological depth via dependency graph → group into waves.
 *   - Each wave's nodes are rendered as boxes, evenly spaced across the width.
 *   - Edges between consecutive waves are drawn as box-drawing connector lines
 *     with arrowheads and optional artifact labels.
 *   - Colours are applied inline (chalk) — no grid post-processing needed.
 */

import { visibleWidth } from "@oh-my-pi/pi-tui";
import { makeFooter, makeHeader, padLine } from "./panel-utils";
import { sato } from "./theme";

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
	status: string; // "pending" | "running" | "completed" | "failed" | "skipped"
}

export interface GraphViewEdge {
	from: string;
	to: string;
	artifacts?: string[];
}

// ============================================================================
// Constants
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

const STATUS_COLOR: Record<string, (text: string) => string> = {
	completed: sato.success,
	running: sato.info,
	waiting: sato.warning,
	failed: sato.danger,
	pending: sato.muted,
	aborted: sato.danger,
	skipped: sato.muted,
};

const MIN_BOX_CONTENT_W = 12;
const INTER_NODE_GAP = 4;

// ============================================================================
// Internal layout types
// ============================================================================

interface NodeLayout {
	id: string;
	label: string;
	status: string;
	col: number; // left column of the box
	boxW: number; // outer box width
	contentW: number; // inner width
}

interface WaveLayout {
	nodes: NodeLayout[];
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Render a theatre graph as ANSI-coloured ASCII art.
 *
 * Returns lines suitable for direct display in a pi-tui component.
 */
export function renderGraphView(input: GraphViewInput): string[] {
	const maxWidth = input.width;
	if (maxWidth < 40) return narrowFallback(input, maxWidth);

	const nodeIds = Object.keys(input.graph.nodes ?? {});
	if (nodeIds.length === 0) return emptyPanel(input, maxWidth);

	// Phase 1: topological layout
	const depths = computeDepths(input.graph);
	const waveGroups = groupByDepth(depths);
	const waves = assignColumns(waveGroups, input.graph, maxWidth);
	const totalWaves = input.totalWaves ?? waves.length;
	const currentWave = input.currentWave ?? 0;

	// Phase 2: render
	const lines: string[] = [];

	// Header
	lines.push(makeHeader(`Theatre Graph · ${nodeIds.length} nodes`, maxWidth));
	lines.push(padLine("", maxWidth));

	// Wave progress bar
	lines.push(...renderWaveBar(waves, currentWave, totalWaves, maxWidth));
	lines.push(padLine("", maxWidth));

	// Body: wave nodes + edges
	for (let wi = 0; wi < waves.length; wi++) {
		// Node boxes for this wave
		lines.push(...renderWaveBoxes(waves[wi], maxWidth));
		// Edge lines to next wave
		if (wi < waves.length - 1) {
			lines.push(...renderEdgeLines(waves[wi], waves[wi + 1], input.graph.edges ?? [], maxWidth));
		}
	}

	// Footer
	lines.push(padLine("", maxWidth));
	lines.push(makeFooter(maxWidth, buildFooterStats(input)));

	return lines;
}

// ============================================================================
// Topological layout
// ============================================================================

/** Compute topological depth for each node from the edge list. */
function computeDepths(graph: GraphViewGraph): Map<string, number> {
	const nodeIds = Object.keys(graph.nodes);
	const edges = graph.edges ?? [];

	const predecessors = new Map<string, string[]>();
	for (const id of nodeIds) predecessors.set(id, []);
	for (const e of edges) {
		if (predecessors.has(e.to)) predecessors.get(e.to)!.push(e.from);
	}

	const depths = new Map<string, number>();
	const visited = new Set<string>();

	function dfs(id: string): number {
		if (depths.has(id)) return depths.get(id)!;
		if (visited.has(id)) return 0;
		visited.add(id);
		let maxPred = 0;
		for (const pred of predecessors.get(id) ?? []) {
			maxPred = Math.max(maxPred, dfs(pred) + 1);
		}
		depths.set(id, maxPred);
		return maxPred;
	}

	for (const id of nodeIds) dfs(id);
	return depths;
}

/** Group node ids by topological depth (ascending). */
function groupByDepth(depths: Map<string, number>): string[][] {
	const maxDepth = Math.max(0, ...depths.values());
	const waves: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
	for (const [id, depth] of depths) {
		waves[depth].push(id);
	}
	return waves.filter(w => w.length > 0);
}

// ============================================================================
// Column assignment
// ============================================================================

function assignColumns(waveGroups: string[][], graph: GraphViewGraph, maxWidth: number): WaveLayout[] {
	// Compute per-node box widths
	const boxSizes = new Map<string, { boxW: number; contentW: number }>();
	for (const [id, node] of Object.entries(graph.nodes)) {
		const labelLen = (node.label ?? id).length;
		const statusLen = visibleWidth(statusLine(node.status));
		const contentW = Math.max(labelLen, statusLen, MIN_BOX_CONTENT_W) + 2; // +2 pad
		boxSizes.set(id, { boxW: contentW + 2, contentW }); // +2 for borders
	}

	return waveGroups.map(waveIds => {
		const totalBoxW = waveIds.reduce((s, id) => s + (boxSizes.get(id)?.boxW ?? 14), 0);
		const totalGap = INTER_NODE_GAP * (waveIds.length - 1);
		const needed = totalBoxW + totalGap;

		// Center if fits; left-align with margin otherwise
		const available = maxWidth - 2; // border margin
		const offset = Math.max(1, Math.floor((available - needed) / 2));

		let cursor = offset;
		const nodes: NodeLayout[] = [];
		for (const id of waveIds) {
			const sz = boxSizes.get(id)!;
			const node = graph.nodes[id];
			nodes.push({
				id,
				label: node?.label ?? id,
				status: node?.status ?? "pending",
				col: cursor,
				boxW: sz.boxW,
				contentW: sz.contentW,
			});
			cursor += sz.boxW + INTER_NODE_GAP;
		}

		return { nodes };
	});
}

// ============================================================================
// Wave box rendering
// ============================================================================

function renderWaveBoxes(wave: WaveLayout, maxWidth: number): string[] {
	if (wave.nodes.length === 0) return [];

	const topLine = buildBoxLine(wave, "top", maxWidth);
	const labelLine = buildBoxLine(wave, "label", maxWidth);
	const statusLine = buildBoxLine(wave, "status", maxWidth);
	const bottomLine = buildBoxLine(wave, "bottom", maxWidth);

	return [topLine, labelLine, statusLine, bottomLine];
}

function buildBoxLine(wave: WaveLayout, row: "top" | "label" | "status" | "bottom", maxWidth: number): string {
	// Build a string of exact width, then pad with panel-utils
	let result = "";
	for (const node of wave.nodes) {
		const padBefore = node.col - result.length;
		if (padBefore > 0) result += " ".repeat(padBefore);
		result += renderBoxSegment(node, row);
	}
	return padLine(result, maxWidth);
}

function renderBoxSegment(node: NodeLayout, row: "top" | "label" | "status" | "bottom"): string {
	const cw = node.contentW;
	const pad = 1;

	switch (row) {
		case "top":
			return `┌${"─".repeat(cw)}┐`;
		case "label": {
			const text = truncateToFit(node.label, cw - pad * 2);
			const padded = ` ${text}${" ".repeat(cw - pad * 2 - text.length + 1)}`;
			return `│${padded}│`;
		}
		case "status": {
			const glyph = STATUS_GLYPH[node.status] ?? "·";
			const colorFn = STATUS_COLOR[node.status] ?? sato.muted;
			const statusText = `${glyph} ${node.status}`;
			const padded = ` ${statusText}${" ".repeat(cw - pad * 2 - statusText.length + 1)}`;
			return `│${colorFn(padded)}│`;
		}
		case "bottom":
			return `└${"─".repeat(cw)}┘`;
	}
}

// ============================================================================
// Edge line rendering
// ============================================================================

function renderEdgeLines(srcWave: WaveLayout, dstWave: WaveLayout, edges: GraphViewEdge[], maxWidth: number): string[] {
	const srcMap = new Map(srcWave.nodes.map(n => [n.id, n]));
	const dstMap = new Map(dstWave.nodes.map(n => [n.id, n]));

	// Group edges by target node for merged rendering
	const byTarget = new Map<string, { src: NodeLayout; edge: GraphViewEdge }[]>();
	for (const edge of edges) {
		const src = srcMap.get(edge.from);
		const dst = dstMap.get(edge.to);
		if (!src || !dst) continue;
		if (!byTarget.has(edge.to)) byTarget.set(edge.to, []);
		byTarget.get(edge.to)!.push({ src, edge });
	}

	const allLines: string[] = [];

	for (const [, group] of byTarget) {
		const targetNode = dstMap.get(group[0].edge.to)!;
		const dstMid = targetNode.col + Math.floor(targetNode.boxW / 2);

		if (group.length === 1) {
			// Single edge: simple connector
			const srcMid = group[0].src.col + Math.floor(group[0].src.boxW / 2);
			allLines.push(buildSingleEdgeLine(srcMid, dstMid, group[0].edge, maxWidth));
		} else {
			// Multiple edges → merge into one tree: vertical drops → horizontal trunk → arrow
			allLines.push(...buildMergedEdgeLines(group, dstMid, maxWidth));
		}
	}

	return allLines;
}

function buildSingleEdgeLine(srcCol: number, dstCol: number, edge: GraphViewEdge, maxWidth: number): string {
	const right = Math.max(srcCol, dstCol) + 1;
	let line = " ".repeat(right);

	line = replaceAt(line, srcCol, "│");
	line = replaceAt(line, dstCol, "▼");

	if (srcCol !== dstCol) {
		const left = Math.min(srcCol, dstCol);
		for (let c = left; c <= Math.max(srcCol, dstCol); c++) {
			// Don't overwrite the source drop
			if (c === srcCol) continue;
			const existing = line[c] ?? " ";
			line = replaceAt(line, c, existing === " " ? "─" : existing);
		}
		// Corner at source
		line = replaceAt(line, srcCol, "├");
	}

	if (edge.artifacts?.length) {
		const rawLabel = edge.artifacts.join(", ");
		const label = sato.muted(rawLabel);
		const midCol = Math.floor((srcCol + dstCol) / 2);
		const labelCol = Math.max(0, midCol - Math.floor(rawLabel.length / 2));
		for (let i = 0; i < label.length && labelCol + i < line.length; i++) {
			line = replaceAt(line, labelCol + i, label[i]);
		}
	}

	return padLine(line.trimEnd(), maxWidth);
}

function buildMergedEdgeLines(
	group: { src: NodeLayout; edge: GraphViewEdge }[],
	dstMid: number,
	maxWidth: number,
): string[] {
	// Element 0: vertical drops from each source
	// Element 1: horizontal trunk + labels + arrow to target
	const lines: string[] = [];

	// Compute max column extent
	let maxCol = dstMid;
	const srcMids: number[] = [];
	for (const { src } of group) {
		const sm = src.col + Math.floor(src.boxW / 2);
		srcMids.push(sm);
		maxCol = Math.max(maxCol, sm);
	}

	// Line 1: vertical drops
	let dropLine = " ".repeat(maxCol + 1);
	for (const sm of srcMids) {
		dropLine = replaceAt(dropLine, sm, "│");
	}
	// Add artifact labels near each drop
	for (let i = 0; i < group.length; i++) {
		const { edge } = group[i];
		const sm = srcMids[i];
		if (edge.artifacts?.length) {
			const rawLabel = edge.artifacts.join(", ");
			const label = sato.muted(rawLabel);
			const labelCol = Math.max(sm + 2, 0);
			for (let j = 0; j < label.length && labelCol + j < dropLine.length; j++) {
				dropLine = replaceAt(dropLine, labelCol + j, label[j]);
			}
		}
	}
	lines.push(padLine(dropLine.trimEnd(), maxWidth));

	// Line 2: horizontal trunk from leftmost source to target
	const leftmost = Math.min(...srcMids);
	const rightmost = Math.max(dstMid, ...srcMids);
	let trunkLine = " ".repeat(rightmost + 1);

	for (let c = leftmost; c <= rightmost; c++) {
		const existing = trunkLine[c] ?? " ";
		trunkLine = replaceAt(trunkLine, c, existing === " " ? "─" : existing);
	}
	// Corners at each source drop
	for (const sm of srcMids) {
		trunkLine = replaceAt(trunkLine, sm, sm === leftmost ? "└" : "┴");
	}
	// Arrow at destination
	trunkLine = replaceAt(trunkLine, dstMid, "▼");

	// If dstMid is same as a source mid, don't overwrite with arrow
	if (srcMids.includes(dstMid)) {
		trunkLine = replaceAt(trunkLine, dstMid, "│");
	}

	lines.push(padLine(trunkLine.trimEnd(), maxWidth));

	return lines;
}

function replaceAt(s: string, index: number, replacement: string): string {
	return s.substring(0, index) + replacement + s.substring(index + replacement.length);
}
// ============================================================================
// Wave progress bar
// ============================================================================

function renderWaveBar(waves: WaveLayout[], currentWave: number, totalWaves: number, maxWidth: number): string[] {
	const displayWaves = Math.max(totalWaves, waves.length);
	if (displayWaves === 0) return [];

	const populatedWaves = new Set<number>();
	for (let wi = 0; wi < waves.length; wi++) {
		if (waves[wi].nodes.length > 0) populatedWaves.add(wi);
	}

	const segments: string[] = [];
	for (let i = 0; i < displayWaves; i++) {
		const isCurrent = i === currentWave;
		const isPast = i < currentWave;
		const hasNodes = populatedWaves.has(i);
		let glyph = "·";
		let colorFn = sato.muted;
		if (isPast) {
			glyph = "✓";
			colorFn = sato.success;
		} else if (isCurrent) {
			glyph = "▶";
			colorFn = sato.info;
		} else if (!hasNodes) {
			colorFn = sato.dim;
		}
		segments.push(colorFn(`Wave ${i + 1} ${glyph}`));
	}

	const bar = `  ${segments.join("  ")}  (${currentWave + 1}/${displayWaves})`;
	return [padLine(bar, maxWidth)];
}

// ============================================================================
// Helpers
// ============================================================================

function statusLine(status: string): string {
	const glyph = STATUS_GLYPH[status] ?? "·";
	return `${glyph} ${status}`;
}

function truncateToFit(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(1, maxLen - 1))}…`;
}

function buildFooterStats(input: GraphViewInput): string {
	const nodes = Object.values(input.graph.nodes ?? {});
	const total = nodes.length;
	const completed = nodes.filter(n => n.status === "completed").length;
	const failed = nodes.filter(n => n.status === "failed").length;
	return `${total} nodes · ${completed}/${total} done${failed > 0 ? ` · ${failed} failed` : ""}`;
}

function emptyPanel(_input: GraphViewInput, maxWidth: number): string[] {
	return [
		makeHeader("Theatre Graph", maxWidth),
		padLine("", maxWidth),
		padLine(sato.muted("  (no graph loaded)"), maxWidth),
		makeFooter(maxWidth),
	];
}

function narrowFallback(_input: GraphViewInput, maxWidth: number): string[] {
	const nodes = Object.entries(_input.graph.nodes ?? {});
	return [
		makeHeader("Graph (compact)", maxWidth),
		padLine("", maxWidth),
		...nodes.map(([id, n]) => {
			const glyph = STATUS_GLYPH[n.status] ?? "·";
			const colorFn = STATUS_COLOR[n.status] ?? sato.muted;
			return padLine(`  ${colorFn(glyph)} ${id}`, maxWidth);
		}),
		makeFooter(maxWidth, buildFooterStats(_input)),
	];
}
