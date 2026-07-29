/**
 * Roundtable View — renders structured debate/roundtable status inside a
 * system `framedBlock`. Uses the global `theme` for all colours.
 *
 * Sections:
 *   1. Participant list (role + position summary)
 *   2. Round counter (current / total)
 *   3. Convergence meter (progress bar)
 *   4. Position history (each round's key points)
 */

import type { Component } from "@satopi/pi-tui";
import type { Theme } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";

// ============================================================================
// Types
// ============================================================================

export interface RoundtableParticipant {
	role: string;
	position: string;
}

export interface RoundtableRoundData {
	round: number;
	/** Jaccard similarity vs previous round (null for round 1). */
	similarity: number | null;
	/** Abbreviated key points / outputs from each participant this round. */
	outputs: string[];
}

export interface RoundtableViewState {
	participants: RoundtableParticipant[];
	rounds: RoundtableRoundData[];
	currentRound: number;
	totalRounds: number;
	converged: boolean;
	convergenceThreshold?: number;
}

// ============================================================================
// Public API
// ============================================================================

export function renderRoundtableView(state: RoundtableViewState, theme: Theme): Component {
	return swarmPanel(
		"Roundtable",
		({ innerWidth, theme: t }) => {
			const lines: string[] = [];

			if (state.participants.length === 0 && state.rounds.length === 0) {
				return [t.fg("dim", "  No roundtable data")];
			}

			// 1. Participants
			if (state.participants.length > 0) {
				lines.push(t.fg("accent", "  Participants"));
				for (const p of state.participants) {
					const displayWidth = Math.max(1, innerWidth - 4);
					const role = t.bold(p.role);
					const pos = truncateText(p.position, displayWidth - visibleLen(p.role) - 3);
					lines.push(`    ${role}: ${t.fg("dim", pos)}`);
				}
				lines.push("");
			}

			// 2. Round counter + convergence badge
			const roundLabel = t.fg("accent", `Round ${state.currentRound} / ${state.totalRounds}`);
			const convergeBadge = state.converged ? t.fg("success", "CONVERGED") : t.fg("warning", "DEBATING");
			lines.push(`  ${roundLabel}  ${convergeBadge}`);

			// 3. Convergence bar
			if (state.rounds.length > 1) {
				const bar = buildConvergenceBar(state, innerWidth, t);
				if (bar) lines.push(bar);
			}

			// 4. Position history
			if (state.rounds.length > 0) {
				lines.push("");
				lines.push(t.fg("accent", "  Position History"));
				for (const r of state.rounds) {
					const simStr = r.similarity !== null ? `${(r.similarity * 100).toFixed(0)}%` : "—";
					const simColor =
						r.similarity !== null && r.similarity >= (state.convergenceThreshold ?? 0.85) ? "success" : "warning";
					const header = `    Round ${r.round}  [similarity: ${t.fg(simColor, simStr)}]`;
					lines.push(header);

					// Show at most 3 outputs per round, truncated
					const maxOutputs = Math.min(r.outputs.length, 3);
					for (let i = 0; i < maxOutputs; i++) {
						const prefix = `      ${String.fromCharCode(0x251c)} `; // ├─
						const remaining = innerWidth - visibleLen(prefix) - 1;
						const snippet = truncateText(r.outputs[i], remaining);
						lines.push(`${prefix}${t.fg("dim", snippet)}`);
					}
					if (r.outputs.length > maxOutputs) {
						lines.push(t.fg("dim", `      … ${r.outputs.length - maxOutputs} more`));
					}
				}
			}

			return lines;
		},
		theme,
	);
}

// ============================================================================
// Helpers
// ============================================================================

function visibleLen(s: string): number {
	let len = 0;
	let inEscape = false;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\x1b") {
			inEscape = true;
			continue;
		}
		if (inEscape) {
			if (s[i] === "m") inEscape = false;
			continue;
		}
		len++;
	}
	return len;
}

function truncateText(s: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	const stripped = s.replace(/\n/g, " ").trim();
	if (stripped.length <= maxLen) return stripped;
	return `${stripped.slice(0, maxLen - 1)}…`;
}

function buildConvergenceBar(state: RoundtableViewState, width: number, t: Theme): string {
	const threshold = state.convergenceThreshold ?? 0.85;
	const barWidth = Math.max(8, width - 4);

	// Find the last similarity value
	const lastSim = state.rounds[state.rounds.length - 1]?.similarity;
	if (lastSim === null || lastSim === undefined) return "";

	const thresholdPos = Math.round(threshold * barWidth);
	const fillPos = Math.min(barWidth, Math.round(Math.min(lastSim, 1) * barWidth));

	let bar = "  ";
	for (let i = 0; i < barWidth; i++) {
		if (i === thresholdPos) {
			bar += t.fg("dim", "\u2502"); // │
		} else if (i < fillPos) {
			bar += t.fg("success", "\u2588"); // █
		} else {
			bar += t.fg("dim", "\u2592"); // ▒
		}
	}
	bar += ` ${t.fg("dim", `${(lastSim * 100).toFixed(0)}%`)}`;

	return bar;
}
