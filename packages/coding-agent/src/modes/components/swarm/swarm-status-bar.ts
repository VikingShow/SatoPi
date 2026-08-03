/**
 * SwarmStatusBar — compact inline status bar for swarm agent progress.
 *
 * Renders between the status line and the transcript during Stage phase.
 * Width-adaptive:
 *   >= 60 cols → agent names (truncated) + counts + phase label
 *   < 60 cols  → colored dots per agent + counts + phase label
 *
 * Hidden when no swarm is active (currentSwarmPhase === "idle" or no subagents).
 */

import type { Component } from "@satopi/pi-tui";
import { AgentRegistry } from "../../../registry/agent-registry";
import { currentSwarmPhase } from "../../../swarm/core/state";
import { theme } from "../../theme/theme";

// ============================================================================
// Status → glyph + colour
// ============================================================================

const AGENT_GLYPH: Record<string, string> = {
	running: "\u25c6", // ◆
	completed: "\u2713", // ✓
	failed: "\u2717", // ✗
	aborted: "\u2717",
	pending: "\u25c7", // ◇
	idle: "\u25c7",
	parked: "\u25c7",
};

const AGENT_COLOR: Record<string, "accent" | "success" | "error" | "dim"> = {
	running: "accent",
	completed: "success",
	failed: "error",
	aborted: "error",
	pending: "dim",
	idle: "dim",
	parked: "dim",
};

const PHASE_COLORS: Record<string, "accent" | "warning" | "success" | "dim"> = {
	script: "accent",
	"script-debate": "warning",
	stage: "accent",
	curtain: "success",
};

// ============================================================================
// SwarmStatusBar
// ============================================================================

export class SwarmStatusBar implements Component {
	render(width: number): readonly string[] {
		const phase = currentSwarmPhase;
		if (phase === "idle") return [];

		const refs = AgentRegistry.global()
			.list()
			.filter(r => r.kind !== "advisor" && r.kind !== "main");
		if (refs.length === 0) return [];

		// Count agent statuses
		let running = 0;
		let completed = 0;
		let failed = 0;
		for (const ref of refs) {
			switch (ref.status) {
				case "running":
					running++;
					break;
				case "aborted":
					failed++;
					break;
				// idle + parked = completed (agent finished its work)
				case "idle":
				case "parked":
					completed++;
					break;
			}
		}

		const phaseColor = PHASE_COLORS[phase] ?? "dim";
		const phaseLabel = phase === "script-debate" ? "debate" : phase;

		if (width >= 60) {
			return this.#renderWide(refs, running, completed, failed, phaseLabel, phaseColor);
		}
		return this.#renderCompact(refs, running, completed, failed, phaseLabel, phaseColor);
	}

	// ── Wide mode (>= 60 cols): agent names + counts ─────────────────────

	#renderWide(
		refs: Array<{ id: string; displayName: string; status?: string }>,
		running: number,
		completed: number,
		failed: number,
		phaseLabel: string,
		phaseColor: "accent" | "warning" | "success" | "dim",
	): readonly string[] {
		const parts: string[] = [];

		// Agent dots with abbreviated names
		for (const ref of refs) {
			const status = ref.status ?? "idle";
			const glyph = AGENT_GLYPH[status] ?? AGENT_GLYPH.pending;
			const color = AGENT_COLOR[status] ?? "dim";
			const name = ref.displayName.length > 12 ? `${ref.displayName.slice(0, 11)}\u2026` : ref.displayName;
			parts.push(theme.fg(color, `${glyph} ${name}`));
		}

		// Counts
		const counts: string[] = [];
		if (running > 0) counts.push(theme.fg("accent", `${running}r`));
		if (completed > 0) counts.push(theme.fg("success", `${completed}d`));
		if (failed > 0) counts.push(theme.fg("error", `${failed}f`));
		const pending = refs.length - running - completed - failed;
		if (pending > 0) counts.push(theme.fg("dim", `${pending}p`));

		const countStr = counts.length > 0 ? `[${counts.join(" ")}]` : "";
		const phaseStr = theme.fg(phaseColor, theme.bold(phaseLabel));

		return [` ${parts.join("  ")}  ${countStr}  ${phaseStr}`];
	}

	// ── Compact mode (< 60 cols): dots only ──────────────────────────────

	#renderCompact(
		refs: Array<{ status?: string }>,
		running: number,
		completed: number,
		failed: number,
		phaseLabel: string,
		phaseColor: "accent" | "warning" | "success" | "dim",
	): readonly string[] {
		const parts: string[] = [];

		// Dots per agent
		for (const ref of refs) {
			const status = ref.status ?? "idle";
			const glyph = AGENT_GLYPH[status] ?? AGENT_GLYPH.pending;
			const color = AGENT_COLOR[status] ?? "dim";
			parts.push(theme.fg(color, glyph));
		}

		// Counts
		const counts: string[] = [];
		if (running > 0) counts.push(theme.fg("accent", String(running)));
		if (completed > 0) counts.push(theme.fg("success", String(completed)));
		if (failed > 0) counts.push(theme.fg("error", String(failed)));

		const countStr = counts.length > 0 ? ` ${counts.join("/")}` : "";
		const phaseStr = theme.fg(phaseColor, theme.bold(phaseLabel));

		return [` ${parts.join("")}${countStr}  ${phaseStr}`];
	}

	handleInput(_data: string): void {}
	invalidate(): void {}
	dispose(): void {}
}
