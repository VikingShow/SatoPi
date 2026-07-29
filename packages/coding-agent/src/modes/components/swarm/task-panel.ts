/**
 * Task Panel — renders per-task progress as a table inside a system
 * `framedBlock`. Shows task ID, status icon, assigned agent, and duration.
 * Bottom line: wave completion percentage + simplified DAG notation.
 */

import type { Component } from "@satopi/pi-tui";
import type { AgentState, TodoItem } from "../../../swarm/core/state";
import type { Theme, ThemeColor } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";

// ============================================================================
// Types
// ============================================================================

export interface TaskPanelInput {
	todos: readonly TodoItem[];
	agents: Record<string, AgentState>;
	/** Edges for DAG summary — optional, shown as "A → B → C" when linear. */
	dagEdges?: readonly { from: string; to: string }[];
	/** Swarm start time used to compute in-progress task durations. */
	startedAt?: number;
}

// ============================================================================
// Status → icon + colour + label
// ============================================================================

const STATUS_ICON: Record<string, string> = {
	pending: "○",
	in_progress: "◌",
	completed: "✓",
};

const STATUS_COLOR: Record<string, ThemeColor> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
};

const STATUS_LABEL: Record<string, string> = {
	pending: "pend",
	in_progress: "run",
	completed: "done",
};

// ============================================================================
// Public API
// ============================================================================

export function renderTaskPanel(input: TaskPanelInput, theme: Theme): Component {
	return swarmPanel(
		"Tasks",
		({ innerWidth, theme }) => {
			const { todos } = input;

			if (todos.length === 0) {
				return [theme.fg("dim", "  No tasks")];
			}

			const lines: string[] = [];

			// Column widths — adapt to available space
			const idW = Math.min(12, Math.max(4, Math.floor(innerWidth * 0.22)));
			const stW = 6;
			const agW = Math.min(14, Math.max(6, Math.floor(innerWidth * 0.28)));
			const durW = Math.max(6, innerWidth - idW - stW - agW - 3);

			// Header
			lines.push(
				theme.fg(
					"dim",
					`  ${"Task".padEnd(idW)} ${"Status".padEnd(stW)} ${"Agent".padEnd(agW)} ${"Dur".padEnd(durW)}`,
				),
			);

			for (const todo of todos) {
				const id = truncate(todo.id, idW);
				const icon = STATUS_ICON[todo.status] ?? "·";
				const color = STATUS_COLOR[todo.status] ?? "dim";
				const label = STATUS_LABEL[todo.status] ?? todo.status;
				const agentId = findAgentForTask(todo.id, input.agents);
				const agentLabel = truncate(agentId ?? "-", agW);
				const duration = computeDuration(todo, input.startedAt);

				lines.push(
					`  ${id.padEnd(idW)} ${theme.fg(color, icon)} ${label.padEnd(stW - 2)} ${agentLabel.padEnd(agW)} ${duration.padEnd(durW)}`,
				);
			}

			// Bottom line: wave completion + DAG
			lines.push("");
			const done = todos.filter(t => t.status === "completed").length;
			const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0;
			const dag = buildDagLine(input.dagEdges);

			let bottom = theme.fg("accent", `Wave: ${done}/${todos.length} (${pct}%)`);
			if (dag) {
				bottom += `  ${theme.fg("dim", dag)}`;
			}
			lines.push(`  ${bottom}`);

			return lines;
		},
		theme,
	);
}

// ============================================================================
// Internal
// ============================================================================

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Try to find an agent that corresponds to a task by matching IDs. */
function findAgentForTask(taskId: string, agents: Record<string, AgentState>): string | undefined {
	// Direct match on agent ID
	if (agents[taskId]) return taskId;

	// Fuzzy: check if any agent ID contains the task ID or vice versa
	for (const [agentId, agent] of Object.entries(agents)) {
		if (
			agentId.toLowerCase().includes(taskId.toLowerCase()) ||
			taskId.toLowerCase().includes(agentId.toLowerCase()) ||
			agent.name.toLowerCase().includes(taskId.toLowerCase()) ||
			taskId.toLowerCase().includes(agent.name.toLowerCase())
		) {
			return agentId;
		}
	}

	return undefined;
}

function computeDuration(todo: TodoItem, startedAt?: number): string {
	const now = Date.now();
	if (todo.status === "completed" && todo.completedAt != null) {
		// Duration from swarm start to completion (best estimate)
		const start = startedAt ?? todo.completedAt;
		return formatDurationMs(todo.completedAt - start);
	}
	if (todo.status === "in_progress" && startedAt != null) {
		return formatDurationMs(now - startedAt);
	}
	return "-";
}

function formatDurationMs(ms: number): string {
	if (ms < 0) return "0s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes}m`;
}

/**
 * Convert a set of DAG edges into a simplified chain notation like
 * "planner → worker → reviewer". Non-linear graphs fall back to a
 * node/edge count summary.
 */
function buildDagLine(edges: readonly { from: string; to: string }[] | undefined): string {
	if (!edges || edges.length === 0) return "";

	// Try to build a linear chain from edges
	const chain = buildLinearChain(edges);
	if (chain.length >= 2) {
		return `DAG: ${chain.join(" → ")}`;
	}

	// Non-linear — just show counts
	const nodeSet = new Set<string>();
	for (const e of edges) {
		nodeSet.add(e.from);
		nodeSet.add(e.to);
	}
	return `DAG: ${nodeSet.size} nodes, ${edges.length} edges`;
}

function buildLinearChain(edges: readonly { from: string; to: string }[]): string[] {
	if (edges.length === 0) return [];

	// Build adjacency and in-degree maps
	const adj = new Map<string, string[]>(); // from → to[]
	const inDeg = new Map<string, number>();

	for (const e of edges) {
		const list = adj.get(e.from) ?? [];
		list.push(e.to);
		adj.set(e.from, list);

		inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
		if (!inDeg.has(e.from)) inDeg.set(e.from, 0);
	}

	// A linear chain has at most one successor and one predecessor per node.
	// Any node with >1 successor or >1 predecessor breaks linearity.
	let hasBranch = false;
	for (const [, succs] of adj) {
		if (succs.length > 1) {
			hasBranch = true;
			break;
		}
	}
	const inDegCounts = new Map<number, number>();
	for (const [, d] of inDeg) {
		inDegCounts.set(d, (inDegCounts.get(d) ?? 0) + 1);
	}
	for (const [deg, count] of inDegCounts) {
		if (deg > 1 && count > 0) {
			hasBranch = true;
			break;
		}
	}

	if (hasBranch) return []; // fall back to count summary

	// Find the start node (in-degree 0)
	const start = [...inDeg.entries()].find(([, d]) => d === 0)?.[0];
	if (!start) return [];

	// Walk the chain
	const chain: string[] = [];
	const visited = new Set<string>();
	let cur: string | undefined = start;
	while (cur && !visited.has(cur)) {
		visited.add(cur);
		chain.push(cur);
		cur = adj.get(cur)?.[0];
	}

	return chain;
}
