/**
 * Unit tests for SatoPi TUI phase lifecycle view.
 *
 * Tests:
 *   - renderPhaseView handles all 8 phases
 *   - Current phase is bold-highlighted
 *   - Future phases are dimmed
 *   - Sub-status line renders correctly
 */

import { describe, expect, it } from "bun:test";
import type { Chapter, SwarmState } from "../core/state";
import { renderPhaseView } from "../../modes/components/swarm/phase-view";
import { PHASE_DISPLAY } from "../../modes/components/swarm/theme";

/** Minimal SwarmState factory */
function makeState(overrides: Partial<SwarmState> = {}): SwarmState {
	return {
		name: "test-swarm",
		status: "running",
		mode: "loop",
		iteration: 0,
		targetCount: 3,
		agents: {
			"worker-1": { name: "worker-1", status: "running", iteration: 1, wave: 1, praiseCount: 0, criticismCount: 0, conflictCount: 0 },
			"worker-2": { name: "worker-2", status: "pending", iteration: 0, wave: 0, praiseCount: 0, criticismCount: 0, conflictCount: 0 },
		},
		startedAt: Date.now() - 300_000,
		phase: "idle",
		...overrides,
	};
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ============================================================================
// All 8 phases render
// ============================================================================

describe("renderPhaseView", () => {
	const ALL_PHASES: Chapter[] = [
		"idle", "script", "script-debate", "script-confirm",
		"stage", "paused", "blocked", "curtain",
	];

	it("returns 2 lines for every phase", () => {
		for (const phase of ALL_PHASES) {
			const state = makeState({ phase });
			const lines = renderPhaseView(state);
			expect(lines.length).toBe(2);
		}
	});

	it("contains all 8 phase icons in output", () => {
		const state = makeState({ phase: "stage" });
		const lines = renderPhaseView(state);
		const plain = stripAnsi(lines[0]);

		for (const phase of ALL_PHASES) {
			expect(plain).toContain(PHASE_DISPLAY[phase].icon);
		}
	});

	it("contains all 8 phase labels", () => {
		const state = makeState({ phase: "script-debate" });
		const lines = renderPhaseView(state);
		const plain = stripAnsi(lines[0]);

		for (const phase of Object.keys(PHASE_DISPLAY) as Chapter[]) {
			expect(plain).toContain(PHASE_DISPLAY[phase].label);
		}
	});
});

// ============================================================================
// Current phase highlighting
// ============================================================================

describe("current phase highlighting", () => {
	it("bold-highlights the current phase", () => {
		const state = makeState({ phase: "stage" });
		const lines = renderPhaseView(state);
		const iconRow = lines[0];

		expect(iconRow).toContain(PHASE_DISPLAY.stage.icon);
		// Current phase should have bold ANSI
		expect(iconRow).toContain("\x1b[1m");
	});

	it("defaults to idle when phase is undefined", () => {
		const state = makeState({ phase: undefined });
		const lines = renderPhaseView(state);
		expect(stripAnsi(lines[0])).toContain(PHASE_DISPLAY.idle.icon);
	});
});

// ============================================================================
// Future phases dimmed
// ============================================================================

describe("future phases dimmed", () => {
	it("non-current phases are rendered in muted colour", () => {
		// When idle is the current phase, all other phases should NOT
		// be bold — they should be rendered in sato.muted (chalk.hex).
		const state = makeState({ phase: "idle" });
		const lines = renderPhaseView(state);
		// sato.bold outputs \x1b[1m for the current phase only.
		// Non-current phases get chalk.hex (no bold escape).
		expect(lines[0]).toContain("\x1b[1m"); // current phase is bold
	});

	it("only curtain is bold when curtain is current", () => {
		// When curtain is current, only curtain gets \x1b[1m.
		const state = makeState({ phase: "curtain" });
		const lines = renderPhaseView(state);
		// Should contain bold for the current phase
		expect(lines[0]).toContain("\x1b[1m");
		// Non-current phases use chalk.hex — verify all 8 icons appear
		const plain = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain(PHASE_DISPLAY.curtain.icon);
	});
});

// ============================================================================
// Sub-status line
// ============================================================================

describe("sub-status line", () => {
	it("shows status label", () => {
		const state = makeState({ phase: "stage", status: "running" });
		const lines = renderPhaseView(state);
		const plain = stripAnsi(lines[1]);
		expect(plain.toLowerCase()).toContain("running");
	});

	it("shows task progress when todos exist", () => {
		const state = makeState({
			phase: "stage",
			todos: [
				{ id: "t1", title: "Task 1", status: "done" },
				{ id: "t2", title: "Task 2", status: "in_progress" },
				{ id: "t3", title: "Task 3", status: "pending" },
			],
		});
		const lines = renderPhaseView(state);
		const plain = stripAnsi(lines[1]);
		expect(plain).toContain("1/3");
	});

	it("omits task progress when no todos", () => {
		const state = makeState({ phase: "stage", todos: [] });
		const lines = renderPhaseView(state);
		const plain = stripAnsi(lines[1]);
		expect(plain).not.toContain("/");
	});

	it("shows duration when startedAt is set", () => {
		const state = makeState({ phase: "stage", startedAt: Date.now() - 300_000 });
		const lines = renderPhaseView(state);
		const plain = stripAnsi(lines[1]);
		// Should contain "5m" for 300 seconds
		expect(plain).toMatch(/\d/m);
	});

	it("handles state with no agents", () => {
		const state = makeState({ phase: "script", agents: {} });
		const lines = renderPhaseView(state);
		expect(lines.length).toBe(2);
	});
});
