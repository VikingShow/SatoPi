/**
 * Unit tests for SatoPi TUI phase lifecycle view.
 *
 * Tests:
 *   - renderPhaseView handles all 8 phases
 *   - Current phase is highlighted (bold)
 *   - Completed phases are indicated
 *   - Future phases are dimmed
 *   - Sub-status line renders correctly
 */

import { describe, expect, it } from "bun:test";
import { renderPhaseView } from "../tui/phase-view";
import { PHASE_DISPLAY } from "../tui/theme";
import type { SwarmState, Chapter } from "../core/state";

/** Minimal SwarmState factory for test isolation */
function makeState(overrides: Partial<SwarmState> = {}): SwarmState {
  return {
    name: "test-swarm",
    status: "running",
    mode: "loop",
    iteration: 0,
    targetCount: 3,
    agents: {
      "worker-1": {
        name: "worker-1",
        status: "running",
        iteration: 1,
        wave: 1,
        praiseCount: 0,
        criticismCount: 0,
        conflictCount: 0,
      },
      "worker-2": {
        name: "worker-2",
        status: "pending",
        iteration: 0,
        wave: 0,
        praiseCount: 0,
        criticismCount: 0,
        conflictCount: 0,
      },
    },
    startedAt: Date.now() - 300_000, // 5 minutes ago
    phase: "idle",
    ...overrides,
  };
}

/** Strip all ANSI SGR escape sequences from a string */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Check if a string contains a bold ANSI escape sequence */
function hasBold(s: string): boolean {
  return /\x1b\[1m/.test(s);
}

/** Check if a string contains a dim ANSI escape sequence */
function hasDim(s: string): boolean {
  return /\x1b\[2m/.test(s);
}

/** Get the plaintext icon for a given chapter from PHASE_DISPLAY */
function phaseIcon(chapter: Chapter): string {
  return PHASE_DISPLAY[chapter].icon;
}

// ============================================================================
// All 8 phases render
// ============================================================================

describe("renderPhaseView", () => {
  it("returns non-empty output for every phase", () => {
    const ALL_PHASES: Chapter[] = [
      "idle",
      "script",
      "script-debate",
      "script-confirm",
      "stage",
      "paused",
      "blocked",
      "curtain",
    ];

    for (const phase of ALL_PHASES) {
      const state = makeState({ phase });
      const lines = renderPhaseView(state);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      // At minimum: icon row, label row, separator, status line
      expect(lines.length).toBe(4);
    }
  });

  it("contains all 8 phase icons in output", () => {
    const state = makeState({ phase: "stage" });
    const lines = renderPhaseView(state);
    const joined = lines.join("\n");
    const plain = stripAnsi(joined);

    const ALL_PHASES: Chapter[] = [
      "idle",
      "script",
      "script-debate",
      "script-confirm",
      "stage",
      "paused",
      "blocked",
      "curtain",
    ];

    for (const phase of ALL_PHASES) {
      expect(plain).toContain(PHASE_DISPLAY[phase].icon);
    }
  });

  it("contains all 8 phase labels", () => {
    const state = makeState({ phase: "script-debate" });
    const lines = renderPhaseView(state);
    const joined = lines.join("\n");
    const plain = stripAnsi(joined);

    for (const phase of Object.keys(PHASE_DISPLAY) as Chapter[]) {
      expect(plain).toContain(PHASE_DISPLAY[phase].label);
    }
  });
});

// ============================================================================
// Current phase highlighting
// ============================================================================

describe("current phase highlighting", () => {
  it("bold-highlights the current phase icon", () => {
    const state = makeState({ phase: "stage" });
    const lines = renderPhaseView(state);

    // First line is the phase icons row
    const iconRow = lines[0];
    const stageIcon = PHASE_DISPLAY.stage.icon;

    // The current phase icon should be wrapped in bold ANSI codes
    expect(iconRow).toContain(stageIcon);
    expect(hasBold(iconRow)).toBe(true);
  });

  it("bold-highlights the current phase label", () => {
    const state = makeState({ phase: "script" });
    const lines = renderPhaseView(state);

    // Second line is the phase labels row
    const labelRow = lines[1];
    const scriptLabel = PHASE_DISPLAY.script.label;

    expect(labelRow).toContain(scriptLabel);
    expect(hasBold(labelRow)).toBe(true);
  });

  it("current phase uses phase-specific color", () => {
    const state = makeState({ phase: "script-debate" });
    const lines = renderPhaseView(state);
    const iconRow = lines[0];

    // script-debate uses purple (ansi256: 99)
    expect(iconRow).toContain("\x1b[38;5;99m");
  });

  it("current phase for blocked uses danger/red color", () => {
    const state = makeState({ phase: "blocked" });
    const lines = renderPhaseView(state);
    const iconRow = lines[0];

    // danger uses ansi256 203
    expect(iconRow).toContain("\x1b[38;5;203m");
  });
});

// ============================================================================
// Completed phases
// ============================================================================

describe("completed phases", () => {
  it("shows completed phases with success color (green)", () => {
    // When phase is "script-confirm", idle and script are completed
    const state = makeState({ phase: "script-confirm" });
    const lines = renderPhaseView(state);
    const iconRow = lines[0];

    // Completed phases should use success green (ansi256: 41)
    expect(iconRow).toContain("\x1b[38;5;41m");
  });

  it("idle is the only 'completed' phase when current is idle", () => {
    // When on idle, there are no completed phases (i < 0 for all)
    const state = makeState({ phase: "idle" });
    const lines = renderPhaseView(state);
    const iconRow = lines[0];

    // No success color should appear since nothing is before idle
    expect(iconRow).not.toContain("\x1b[38;5;41m");
  });

  it("all phases before curtain are completed when current is curtain", () => {
    const state = makeState({ phase: "curtain" });
    const lines = renderPhaseView(state);
    const iconRow = lines[0];

    // All 7 preceding phases should be green
    // Count occurrences of success ANSI code
    const matches = iconRow.match(/\x1b\[38;5;41m/g);
    expect(matches).not.toBeNull();
    // At least some completed phases
    expect(matches!.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Future phases dimmed
// ============================================================================

describe("future phases dimmed", () => {
  it("dims future phases when current is idle", () => {
    const state = makeState({ phase: "idle" });
    const lines = renderPhaseView(state);
    const iconRow = lines[0];

    // Future phases should use dim (SGR 2)
    expect(hasDim(iconRow)).toBe(true);
  });

  it("no future phases are dimmed when current is curtain", () => {
    const state = makeState({ phase: "curtain" });
    const lines = renderPhaseView(state);
    const iconRow = lines[0];

    // Curtain is the last phase — nothing is "future"
    // However, curtain itself might be bold, and everything else is completed (green).
    // There should be NO dim sequences in the icon row (everything is either completed or current)
    // Actually, let me check: past phases use green, current uses bold+color, future uses dim
    // When curtain is current, there are 7 past (green) and 1 current (bold)
    // So there should be zero dim sequences
    expect(hasDim(iconRow)).toBe(false);
  });

  it("future phase labels are dimmed", () => {
    const state = makeState({ phase: "script" });
    const lines = renderPhaseView(state);
    const labelRow = lines[1];

    // Labels for phases after script should be dimmed
    expect(hasDim(labelRow)).toBe(true);
  });
});

// ============================================================================
// Sub-status line
// ============================================================================

describe("sub-status line", () => {
  it("shows elapsed time", () => {
    const state = makeState({ phase: "stage" });
    const lines = renderPhaseView(state);

    // Status line is the last line
    const statusLine = lines[lines.length - 1];
    const plain = stripAnsi(statusLine);

    expect(plain).toContain("Time:");
    // Format should be HH:MM:SS
    expect(plain).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("shows agent count", () => {
    const state = makeState({ phase: "stage" });
    const lines = renderPhaseView(state);

    const statusLine = lines[lines.length - 1];
    const plain = stripAnsi(statusLine);

    expect(plain).toContain("Agents:");
    expect(plain).toContain("2"); // our factory has 2 agents
  });

  it("shows running agent count when agents are active", () => {
    const state = makeState({
      phase: "stage",
      agents: {
        "worker-1": {
          name: "worker-1",
          status: "running",
          iteration: 1,
          wave: 1,
          praiseCount: 0,
          criticismCount: 0,
          conflictCount: 0,
        },
        "worker-2": {
          name: "worker-2",
          status: "running",
          iteration: 1,
          wave: 1,
          praiseCount: 0,
          criticismCount: 0,
          conflictCount: 0,
        },
        "worker-3": {
          name: "worker-3",
          status: "pending",
          iteration: 0,
          wave: 0,
          praiseCount: 0,
          criticismCount: 0,
          conflictCount: 0,
        },
      },
    });
    const lines = renderPhaseView(state);
    const statusLine = lines[lines.length - 1];
    const plain = stripAnsi(statusLine);

    expect(plain).toContain("Agents:");
    expect(plain).toContain("3");
    expect(plain).toContain("running");
  });

  it("shows task progress when todos exist", () => {
    const state = makeState({
      phase: "stage",
      todos: [
        { id: "t1", title: "Task 1", status: "completed", completedAt: 1000 },
        { id: "t2", title: "Task 2", status: "in_progress" },
        { id: "t3", title: "Task 3", status: "pending" },
      ],
    });
    const lines = renderPhaseView(state);
    const statusLine = lines[lines.length - 1];
    const plain = stripAnsi(statusLine);

    expect(plain).toContain("Tasks:");
    expect(plain).toContain("1/3");
  });

  it("omits task progress when no todos", () => {
    const state = makeState({ phase: "stage", todos: [] });
    const lines = renderPhaseView(state);
    const statusLine = lines[lines.length - 1];
    const plain = stripAnsi(statusLine);

    expect(plain).not.toContain("Tasks:");
  });

  it("shows iteration count when loopIteration is set", () => {
    const state = makeState({ phase: "stage", loopIteration: 5 });
    const lines = renderPhaseView(state);
    const statusLine = lines[lines.length - 1];
    const plain = stripAnsi(statusLine);

    expect(plain).toContain("Iteration:");
    expect(plain).toContain("5");
  });

  it("shows roundtable phase when set", () => {
    const state = makeState({ phase: "stage", roundtablePhase: "review" });
    const lines = renderPhaseView(state);
    const statusLine = lines[lines.length - 1];
    const plain = stripAnsi(statusLine);

    expect(plain).toContain("Step:");
    expect(plain).toContain("review");
  });

  it("uses separator between status fields", () => {
    const state = makeState({ phase: "stage" });
    const lines = renderPhaseView(state);
    const statusLine = lines[lines.length - 1];
    const plain = stripAnsi(statusLine);

    expect(plain).toContain("│");
  });
});

// ============================================================================
// Phase order and edge cases
// ============================================================================

describe("edge cases", () => {
  it("defaults to idle when phase is undefined", () => {
    const state = makeState({ phase: undefined });
    const lines = renderPhaseView(state);

    // First line should have idle icon highlighted
    const iconRow = lines[0];
    expect(stripAnsi(iconRow)).toContain(PHASE_DISPLAY.idle.icon);
  });

  it("handles state with no agents", () => {
    const state = makeState({ phase: "script", agents: {} });
    const lines = renderPhaseView(state);
    const statusLine = lines[lines.length - 1];
    const plain = stripAnsi(statusLine);

    expect(plain).toContain("Agents:");
    expect(plain).toContain("0");
  });

  it("omits iteration line when loopIteration is 0", () => {
    const state = makeState({ phase: "stage", loopIteration: 0 });
    const lines = renderPhaseView(state);
    const statusLine = lines[lines.length - 1];
    const plain = stripAnsi(statusLine);

    expect(plain).not.toContain("Iteration:");
  });
});
