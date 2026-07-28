/**
 * Phase View — renders the 8-phase lifecycle progress bar + sub-status line.
 *
 * All 8 lifecycle phases shown with icons and labels. The current phase is
 * highlighted (bold + amber), future phases are dimmed. A sub-status line
 * beneath shows human-readable pipeline status + elapsed time.
 */

import type { Chapter, SwarmState, TodoItem } from "../../../swarm/core/state";
import type { Theme } from "../../theme/theme";
// ============================================================================
// Constants
// ============================================================================

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

const PHASE_ICON: Record<Chapter, string> = {
	idle: "○",
	script: "◇",
	"script-debate": "◆",
	"script-confirm": "◇",
	stage: "●",
	paused: "⏸",
	blocked: "⛔",
	curtain: "◈",
};

const PHASE_LABEL: Record<Chapter, string> = {
	idle: "Idle",
	script: "Script",
	"script-debate": "Debate",
	"script-confirm": "Confirm",
	stage: "Stage",
	paused: "Paused",
	blocked: "Blocked",
	curtain: "Curtain",
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Render the phase lifecycle progress bar.
 *
 * Returns an array of chalk-coloured lines:
 *   Line 1:  ○ Idle → ◇ Script → ◆ Debate → ● Stage → ...
 *   Line 2:  ─ status: Running  [tasks 3/7]  [12m 34s] ─
 */
export function renderPhaseView(state: SwarmState, theme: Theme): string[] {
	const currentPhase = state.phase ?? "idle";

	const icons = PHASE_ORDER.map(phase => {
		const isCurrent = phase === currentPhase;
		const icon = PHASE_ICON[phase];
		const label = PHASE_LABEL[phase];
		const coloredIcon = isCurrent ? theme.bold(theme.fg("warning", icon)) : theme.fg("dim", icon);
		const coloredLabel = isCurrent ? theme.bold(label) : theme.fg("dim", label);
		return `${coloredIcon} ${coloredLabel}`;
	});

	const arrow = theme.fg("dim", " → ");
	const phaseLine = icons.join(arrow);

	// Sub-status line
	const status = state.status ?? "idle";
	const statusLabel = theme.fg("warning", status.charAt(0).toUpperCase() + status.slice(1));

	const progress = computeTaskProgress(state.todos ?? []);
	const taskPart = progress.total > 0 ? theme.fg("dim", `[tasks ${progress.done}/${progress.total}]`) : "";

	const duration = state.startedAt != null ? theme.fg("dim", `[${formatDuration(Date.now() - state.startedAt)}]`) : "";

	const parts = [theme.fg("dim", "status:"), statusLabel, taskPart, duration].filter(Boolean);
	const subLine = `─ ${parts.join("  ")} ${"─".repeat(4)}`;

	return [phaseLine, theme.fg("dim", subLine)];
}

// ============================================================================
// Internal
// ============================================================================

interface TaskProgress {
	done: number;
	total: number;
}

function computeTaskProgress(todos: TodoItem[]): TaskProgress {
	const done = todos.filter(t => t.status === "completed").length;
	return { done, total: todos.length };
}

function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	if (ms < 1000) return "<1s";

	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;

	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return `${min}m ${sec}s`;

	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return `${hr}h ${remMin}m`;
}
