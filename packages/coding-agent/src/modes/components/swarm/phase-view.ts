import type { Chapter, SwarmState } from "../../../swarm/core/state";
import { ansiBold, ansiDim, ansiFg, PHASE_DISPLAY, SATOPI_COLORS } from "../../../swarm/tui/theme";

/**
 * Ordered list of all phases in lifecycle sequence.
 * Paused and Blocked appear after Stage since they can interrupt it.
 */
const PHASE_ORDER: Chapter[] = [
	"idle",
	"script",
	"script-debate",
	"script-confirm",
	"stage",
	"paused",
	"blocked",
	"curtain",
];

/** Format a duration in milliseconds as HH:MM:SS */
function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Compute task progress from todo items */
function computeTaskProgress(todos: SwarmState["todos"]): { done: number; total: number } {
	if (!todos || todos.length === 0) return { done: 0, total: 0 };
	const done = todos.filter(t => t.status === "completed").length;
	return { done, total: todos.length };
}

/**
 * Render the phase lifecycle progress view.
 *
 * Displays all 8 workflow phases as a horizontal progress bar:
 *   - Completed phases: colored icon with checkmark indicator
 *   - Current phase: bold colored icon + bold label (caller can animate via re-render)
 *   - Future phases: dimmed icon
 *
 * Also renders a sub-status line: elapsed time, agent count, task progress.
 *
 * @param state - Current swarm state snapshot.
 * @returns Array of ANSI-color-coded strings, one per line.
 */
export function renderPhaseView(state: SwarmState): string[] {
	const currentPhase = state.phase ?? "idle";
	const currentIdx = PHASE_ORDER.indexOf(currentPhase);

	const lines: string[] = [];

	// --- Phase bar ---
	const phaseParts: string[] = [];

	for (let i = 0; i < PHASE_ORDER.length; i++) {
		const phase = PHASE_ORDER[i];
		const display = PHASE_DISPLAY[phase];
		const colorCode = display.color.ansi256;

		if (i < currentIdx) {
			// Completed phase: colored icon with checkmark
			phaseParts.push(ansiFg(SATOPI_COLORS.success.ansi256, display.icon));
		} else if (i === currentIdx) {
			// Current phase: bold + colored
			phaseParts.push(ansiBold(ansiFg(colorCode, display.icon)));
		} else {
			// Future phase: dimmed
			phaseParts.push(ansiDim(display.icon));
		}
	}

	// Join phase icons with arrow separator and add labels below
	const phaseIcons = phaseParts.join("  ");
	lines.push(phaseIcons);

	// --- Phase labels row ---
	const labelParts: string[] = [];
	for (let i = 0; i < PHASE_ORDER.length; i++) {
		const phase = PHASE_ORDER[i];
		const display = PHASE_DISPLAY[phase];
		const colorCode = display.color.ansi256;

		let label: string;
		if (i < currentIdx) {
			label = ansiDim(display.label);
		} else if (i === currentIdx) {
			label = ansiBold(ansiFg(colorCode, display.label));
		} else {
			label = ansiDim(display.label);
		}
		labelParts.push(label);
	}
	lines.push(labelParts.join("  "));

	// --- Separator ---
	lines.push(ansiDim("─".repeat(Math.max(40, phaseIcons.replace(/\x1b\[[0-9;]*m/g, "").length))));

	// --- Sub-status line ---
	const elapsed = Date.now() - state.startedAt;
	const elapsedStr = formatDuration(elapsed);

	const agentCount = Object.keys(state.agents).length;
	const runningAgents = Object.values(state.agents).filter(a => a.status === "running").length;

	const { done, total } = computeTaskProgress(state.todos);

	const statusParts: string[] = [];

	// Time
	statusParts.push(`${ansiDim("Time:")} ${ansiFg(SATOPI_COLORS.text.ansi256, elapsedStr)}`);

	// Agent count
	const agentStr = runningAgents > 0 ? `${agentCount} (${runningAgents} running)` : `${agentCount}`;
	statusParts.push(`${ansiDim("Agents:")} ${ansiFg(SATOPI_COLORS.text.ansi256, agentStr)}`);

	// Task progress
	if (total > 0) {
		statusParts.push(
			`${ansiDim("Tasks:")} ${ansiFg(SATOPI_COLORS.info.ansi256, `${done}/${total}`)}${ansiDim(" done")}`,
		);
	}

	// Iteration
	if (state.loopIteration !== undefined && state.loopIteration > 0) {
		statusParts.push(`${ansiDim("Iteration:")} ${ansiFg(SATOPI_COLORS.text.ansi256, String(state.loopIteration))}`);
	}

	// Roundtable sub-phase
	if (state.roundtablePhase) {
		statusParts.push(`${ansiDim("Step:")} ${ansiFg(SATOPI_COLORS.purple.ansi256, state.roundtablePhase)}`);
	}

	lines.push(statusParts.join(`  ${ansiDim("│")}  `));

	return lines;
}
