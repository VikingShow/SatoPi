/**
 * Crew Transcript View — renders a roundtable/crew conversation transcript
 * inside a system `framedBlock`. Uses the global `theme` for all colours.
 *
 * Sections:
 *   1. Topic + convergence status + round count
 *   2. Crew member roster
 *   3. Interleaved message transcript with coloured agent tags
 */

import type { Component } from "@satopi/pi-tui";
import type { CrewState, CrewSummary } from "../../../crew/crew-manager";
import type { Theme, ThemeColor } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";

// ============================================================================
// Public types
// ============================================================================

export interface CrewTranscriptEntry {
	/** Agent that sent this message. */
	agentId: string;
	/** Message body text. */
	body: string;
	/** UNIX epoch millis. */
	timestamp: number;
	/** Roundtable round number (1-based). */
	round: number;
}

export interface CrewTranscriptState {
	/** Crew metadata (id, name, members, etc.). */
	crew: CrewState | CrewSummary;
	/** Roundtable discussion topic. */
	topic: string;
	/** Whether the roundtable reached convergence. */
	converged: boolean;
	/** Total number of rounds. */
	totalRounds: number;
	/** Chronological transcript entries. */
	entries: CrewTranscriptEntry[];
}

// ============================================================================
// CrewTranscriptView
// ============================================================================

export class CrewTranscriptView implements Component {
	readonly #state: CrewTranscriptState;
	readonly #theme: Theme;

	constructor(state: CrewTranscriptState, theme: Theme) {
		this.#state = state;
		this.#theme = theme;
	}

	render(width: number): readonly string[] {
		const panel = swarmPanel(
			"Crew Transcript",
			({ innerWidth, theme: t }) => {
				const lines: string[] = [];

				// 1. Topic
				lines.push(t.fg("accent", `  Topic: ${this.#state.topic}`));

				// 2. Convergence badge + round count
				const convergeBadge = this.#state.converged
					? t.fg("success", "CONVERGED")
					: t.fg("warning", "DEBATING");
				lines.push(`  ${convergeBadge}  ${t.fg("dim", `Rounds: ${this.#state.totalRounds}`)}`);

				// 3. Crew member roster (only for full CrewState)
				if ("members" in this.#state.crew && this.#state.crew.members.length > 0) {
					const members = this.#state.crew.members
						.map(m => `${m.agentId}${m.role === "observer" ? "*" : ""}`)
						.join(", ");
					lines.push(t.fg("dim", `  Crew: ${members}`));
				}

				lines.push("");

				// 4. Message transcript
				if (this.#state.entries.length === 0) {
					lines.push(t.fg("dim", "  No transcript entries"));
				} else {
					const shown = this.#state.entries.slice(-10);
					for (const entry of shown) {
						const color = agentColor(entry.agentId, t);
						const time = formatTime(entry.timestamp, t);
						const tag = color(`[${entry.agentId}]`);
						const roundLabel = t.fg("dim", `R${entry.round}`);

						const prefix = `  ${time} ${roundLabel} ${tag} `;
						const prefixLen = visibleLen(prefix);
						const bodyBudget = Math.max(5, innerWidth - prefixLen - 1);
						const body =
							entry.body.length > bodyBudget
								? `${entry.body.slice(0, bodyBudget - 1)}\u2026`
								: entry.body;

						lines.push(`${prefix}${body}`);
					}
					if (this.#state.entries.length > 10) {
						lines.push(
							t.fg("dim", `  \u2026 ${this.#state.entries.length - 10} more entries`),
						);
					}
				}

				return lines;
			},
			this.#theme,
		);
		return panel.render(width);
	}
}

// ============================================================================
// Helpers
// ============================================================================

/** Stable palette used to colour agent tags. */
const AGENT_PALETTE: ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"thinkingText",
	"toolTitle",
	"mdLink",
	"syntaxFunction",
	"syntaxString",
];

/** Map agent ids to a consistent colour from the palette via hash. */
function agentColor(agentId: string, t: Theme): (text: string) => string {
	const idx = hashStr(agentId) % AGENT_PALETTE.length;
	const color = AGENT_PALETTE[idx];
	return (text: string) => t.fg(color, text);
}

/** Simple DJB2-ish hash returning an unsigned 32-bit integer. */
function hashStr(s: string): number {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	}
	return h >>> 0;
}

/** Format a UNIX-epoch-millis timestamp as HH:MM:SS. */
function formatTime(ts: number, t: Theme): string {
	const d = new Date(ts);
	const h = d.getHours().toString().padStart(2, "0");
	const m = d.getMinutes().toString().padStart(2, "0");
	const s = d.getSeconds().toString().padStart(2, "0");
	return t.fg("dim", `${h}:${m}:${s}`);
}

/** Visible length of a string, stripping ANSI escape sequences. */
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
