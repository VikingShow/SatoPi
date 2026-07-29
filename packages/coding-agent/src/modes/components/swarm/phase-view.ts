/**
 * Phase View — renders the 8-phase lifecycle progress bar + sub-status line.
 *
 * All 8 lifecycle phases shown with icons and labels. The current phase is
 * highlighted (bold + amber with pulse animation), past phases show a ✓
 * checkmark, and future phases are dimmed. A sub-status line beneath shows
 * human-readable pipeline status + elapsed time.
 *
 * Narrow terminals (< 60 cols) collapse completed phases into an ellipsis.
 */

import { truncateToWidth, visibleWidth } from "@satopi/pi-tui";
import type { Chapter, SwarmState, TodoItem, TransitionRecord } from "../../../swarm/core/state";
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
// Pulse animation (module-level state)
// ============================================================================

let pulseTick = 0;
let pulseTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the phase-bar pulse animation. Calls `onTick` every ~500ms so the
 * caller can schedule a TUI render. Idempotent — a second call while already
 * running is a no-op.
 */
export function startPhasePulse(onTick: () => void): void {
	if (pulseTimer) return;
	pulseTimer = setInterval(() => {
		pulseTick++;
		onTick();
	}, 500);
}

/**
 * Stop the phase-bar pulse animation. Safe to call when already stopped.
 */
export function stopPhasePulse(): void {
	if (pulseTimer !== null) {
		clearInterval(pulseTimer);
		pulseTimer = null;
	}
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Render the phase lifecycle progress bar.
 *
 * Returns an array of chalk-coloured lines:
 *   Line 1:  ✓ Idle → ✓ Script → ◇ Debate ◆ [2m34s] → ...
 *   Line 2:  ─ status: Running  [tasks 3/7]  [12m 34s] ─
 *
 * @param state  Current swarm state snapshot.
 * @param theme  Active TUI theme for colour lookups.
 * @param width  Available terminal width in columns (for adaptive collapse).
 */
export function renderPhaseView(state: SwarmState, theme: Theme, width: number): string[] {
	const currentPhase = state.phase ?? "idle";
	const currentIdx = PHASE_ORDER.indexOf(currentPhase);
	const isPulseOn = pulseTick % 2 === 0;

	// Resolve when the *current* phase started via the FSM audit trail.
	const phaseStartedAt = resolvePhaseStartedAt(state, currentPhase);

	// Build individual phase segments (icon + label, already styled).
	const segments = PHASE_ORDER.map((phase, i) => {
		if (i < currentIdx) return renderPastPhase(phase, theme);
		if (i === currentIdx) return renderCurrentPhase(phase, theme, isPulseOn, phaseStartedAt);
		return renderFuturePhase(phase, theme);
	});

	const arrow = theme.fg("dim", " → ");

	// Phase line — collapse completed phases on narrow terminals.
	const phaseLine = buildPhaseLine(segments, currentIdx, arrow, theme, width);

	// Sub-status line
	const subLine = buildSubStatusLine(state, theme);

	return [phaseLine, subLine];
}

// ============================================================================
// Phase segment renderers
// ============================================================================

function renderPastPhase(phase: Chapter, theme: Theme): string {
	return theme.fg("success", `✓ ${PHASE_LABEL[phase]}`);
}

function renderCurrentPhase(phase: Chapter, theme: Theme, pulseOn: boolean, startedAt: number): string {
	const icon = PHASE_ICON[phase];
	let label = PHASE_LABEL[phase];

	// Append elapsed time for the current phase.
	const elapsed = formatDuration(Date.now() - startedAt);
	label = `${label} [${elapsed}]`;

	const inner = `${icon} ${label}`;
	return pulseOn ? theme.bold(theme.fg("warning", inner)) : theme.fg("warning", inner);
}

function renderFuturePhase(phase: Chapter, theme: Theme): string {
	return theme.fg("dim", `${PHASE_ICON[phase]} ${PHASE_LABEL[phase]}`);
}

// ============================================================================
// Phase-line builder (with narrow-terminal collapse)
// ============================================================================

function buildPhaseLine(segments: string[], currentIdx: number, arrow: string, theme: Theme, width: number): string {
	// Fast path: enough room for full bar.
	const fullLine = segments.join(arrow);
	if (visibleWidth(fullLine) <= width) return fullLine;

	// Collapse: keep the current + future phases, replace all past phases
	// with a single ellipsis.
	const collapsedParts: string[] = [];

	// How many past phases to collapse?
	const pastCount = currentIdx;
	if (pastCount > 0) {
		const collapsedLabel =
			pastCount === 1
				? theme.fg("success", segments[0]!) // just show the one
				: theme.fg("dim", "…");
		collapsedParts.push(collapsedLabel);
	}

	// Keep current + future phases.
	for (let i = currentIdx; i < segments.length; i++) {
		collapsedParts.push(segments[i]!);
	}

	const collapsedLine = collapsedParts.join(arrow);
	if (visibleWidth(collapsedLine) <= width) return collapsedLine;

	// Still too wide — truncate the right side with ellipsis.
	return truncateToWidth(collapsedLine, width);
}

// ============================================================================
// Sub-status line
// ============================================================================

function buildSubStatusLine(state: SwarmState, theme: Theme): string {
	const status = state.status ?? "idle";
	const statusLabel = theme.fg("warning", status.charAt(0).toUpperCase() + status.slice(1));

	const progress = computeTaskProgress(state.todos ?? []);
	const taskPart = progress.total > 0 ? theme.fg("dim", `[tasks ${progress.done}/${progress.total}]`) : "";

	const duration = state.startedAt != null ? theme.fg("dim", `[${formatDuration(Date.now() - state.startedAt)}]`) : "";

	const parts = [theme.fg("dim", "status:"), statusLabel, taskPart, duration].filter(Boolean);
	const subLine = `─ ${parts.join("  ")} ${"─".repeat(4)}`;

	return theme.fg("dim", subLine);
}

// ============================================================================
// Helpers
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

/**
 * Find the timestamp when the swarm entered `phase` by scanning the
 * FSM transition audit trail backwards. Falls back to `state.startedAt`.
 */
function resolvePhaseStartedAt(state: SwarmState, phase: Chapter): number {
	const history: readonly TransitionRecord[] | undefined = state.transitionHistory;
	if (history && history.length > 0) {
		// Walk backwards to find the most recent transition INTO `phase`.
		for (let i = history.length - 1; i >= 0; i--) {
			const rec = history[i]!;
			if (rec.to === phase) return rec.timestamp;
		}
	}
	return state.startedAt;
}
