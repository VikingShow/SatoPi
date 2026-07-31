/**
 * Crew Transcript View — renders a roundtable/crew conversation transcript
 * inside a system `framedBlock`. Uses the global `theme` for all colours.
 *
 * Sections:
 *   1. Topic + convergence status + round count
 *   2. Crew member roster
 *   3. Interleaved message transcript with coloured agent tags
 *
 * Keyboard:
 *   f — toggle agent filter popup (show/hide specific agents)
 *   t — toggle between messages-only and messages+tools display
 *   r — cycle through round filters (all → round 1 → round 2 → … → all)
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
	/** Entry kind: "message" (default) or "tool" (tool output). */
	kind?: "message" | "tool";
	/** Tool name (only for kind: "tool"). */
	toolName?: string;
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
	#showFilterPopup = false;
	#showTools = true;
	#filteredAgentIds = new Set<string>();
	/** Current round filter: 0 = all, N = round N only. */
	#roundFilter = 0;

	constructor(state: CrewTranscriptState, theme: Theme) {
		this.#state = state;
		this.#theme = theme;
	}

	/** Append an entry to the transcript. */
	addEntry(entry: CrewTranscriptEntry): void {
		this.#state.entries.push(entry);
	}

	/** Update mutable transcript state fields. */
	updateState(state: Partial<CrewTranscriptState>): void {
		Object.assign(this.#state, state);
	}

	render(width: number): readonly string[] {
		const panel = swarmPanel(
			"Crew Transcript",
			({ innerWidth, theme: t }) => {
				const lines: string[] = [];

				// 1. Topic
				lines.push(t.fg("accent", `  Topic: ${this.#state.topic}`));

				// 2. Convergence badge + round count + active filters
				const convergeBadge = this.#state.converged ? t.fg("success", "CONVERGED") : t.fg("warning", "DEBATING");
				const roundInfo =
					this.#roundFilter > 0
						? t.fg("accent", `Round ${this.#roundFilter}/${this.#state.totalRounds}`)
						: t.fg("dim", `Rounds: ${this.#state.totalRounds}`);
				const toolMode = this.#showTools ? "tools" : "msg-only";
				lines.push(`  ${convergeBadge}  ${roundInfo}  ${t.fg("dim", `[${toolMode}]`)}`);

				// 3. Crew member roster (only for full CrewState)
				if ("members" in this.#state.crew && this.#state.crew.members.length > 0) {
					const members = this.#state.crew.members
						.map(m => `${m.agentId}${m.role === "observer" ? "*" : ""}`)
						.join(", ");
					lines.push(t.fg("dim", `  Crew: ${members}`));
				}

				lines.push("");

				// 4. Filter popup (if active)
				if (this.#showFilterPopup) {
					lines.push(t.fg("accent", "  \u250c\u2500 Agent Filter"));
					const uniqueAgents = [...new Set(this.#state.entries.map(e => e.agentId))];
					for (const agentId of uniqueAgents) {
						const hidden = this.#filteredAgentIds.has(agentId);
						const mark = hidden ? t.fg("error", "\u2717") : t.fg("success", "\u2713");
						lines.push(`  \u2502 ${mark} ${agentId}`);
					}
					lines.push(t.fg("dim", "  \u2514\u2500 a-z toggle  f close"));
					lines.push("");
				}

				// 5. Shortcuts hint
				lines.push(t.fg("dim", "  f:filter  t:tools  r:round  j/k:scroll"));
				lines.push("");

				// 6. Message transcript
				let filtered = this.#state.entries;
				if (this.#roundFilter > 0) {
					filtered = filtered.filter(e => e.round === this.#roundFilter);
				}
				if (this.#filteredAgentIds.size > 0) {
					filtered = filtered.filter(e => !this.#filteredAgentIds.has(e.agentId));
				}
				if (!this.#showTools) {
					filtered = filtered.filter(e => (e.kind ?? "message") !== "tool");
				}

				if (filtered.length === 0) {
					lines.push(t.fg("dim", "  No transcript entries match filter"));
				} else {
					const shown = filtered.slice(-15);
					for (const entry of shown) {
						const entryKind = entry.kind ?? "message";
						const color = agentColor(entry.agentId, t);
						const time = formatTime(entry.timestamp, t);
						const tag = color(`[${entry.agentId}]`);
						const roundLabel = t.fg("dim", `R${entry.round}`);

						if (entryKind === "tool") {
							const toolTag = t.fg("accent", `\u2699 ${entry.toolName ?? "tool"}`);
							const prefix = `  ${time} ${roundLabel} ${tag} ${toolTag} `;
							const prefixLen = visibleLen(prefix);
							const bodyBudget = Math.max(5, innerWidth - prefixLen - 1);
							const body =
								entry.body.length > bodyBudget ? `${entry.body.slice(0, bodyBudget - 1)}\u2026` : entry.body;
							lines.push(`${prefix}${t.fg("dim", body)}`);
						} else {
							const prefix = `  ${time} ${roundLabel} ${tag} `;
							const prefixLen = visibleLen(prefix);
							const bodyBudget = Math.max(5, innerWidth - prefixLen - 1);
							const body =
								entry.body.length > bodyBudget ? `${entry.body.slice(0, bodyBudget - 1)}\u2026` : entry.body;
							lines.push(`${prefix}${body}`);
						}
					}
					if (filtered.length > shown.length) {
						lines.push(t.fg("dim", `  \u2026 ${filtered.length - shown.length} more entries`));
					}
				}

				return lines;
			},
			this.#theme,
		);
		return panel.render(width);
	}

	handleInput(data: string): void {
		switch (data) {
			case "f":
			case "F":
				this.#showFilterPopup = !this.#showFilterPopup;
				break;
			case "t":
			case "T":
				this.#showTools = !this.#showTools;
				break;
			case "r":
			case "R":
				// Cycle through rounds: 0 (all) → 1 → 2 → ... → max → 0
				this.#roundFilter = (this.#roundFilter + 1) % (this.#state.totalRounds + 1);
				break;
			// In filter mode, a-z toggle specific agent visibility
			default: {
				if (this.#showFilterPopup && data.length === 1) {
					const ch = data.toLowerCase();
					if (ch >= "a" && ch <= "z") {
						const uniqueAgents = [...new Set(this.#state.entries.map(e => e.agentId))];
						const idx = ch.charCodeAt(0) - "a".charCodeAt(0);
						if (idx < uniqueAgents.length) {
							const agentId = uniqueAgents[idx];
							if (this.#filteredAgentIds.has(agentId)) {
								this.#filteredAgentIds.delete(agentId);
							} else {
								this.#filteredAgentIds.add(agentId);
							}
						}
					}
				}
			}
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

/** Stable palette used to colour agent tags. */
export const AGENT_PALETTE: ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"error",
	"thinkingMedium",
	"accent",
	"success",
	"warning",
];

export function agentColor(agentId: string, t: Theme): (text: string) => string {
	const idx = hashStr(agentId) % AGENT_PALETTE.length;
	const color = AGENT_PALETTE[idx];
	return (text: string) => t.fg(color, text);
}

/** Simple DJB2-ish hash returning an unsigned 32-bit integer. */
export function hashStr(s: string): number {
	let hash = 5381;
	for (let i = 0; i < s.length; i++) {
		hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
	}
	return hash;
}

export function formatTime(ts: number, t: Theme): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return t.fg("dim", `${hh}:${mm}:${ss}`);
}

/** Visible length of a string, stripping ANSI escape sequences. */
function visibleLen(s: string): number {
	let len = 0;
	let inEscape = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "\x1b") {
			inEscape = true;
			continue;
		}
		if (inEscape) {
			if (ch >= "@" && ch <= "~") inEscape = false;
			continue;
		}
		len++;
	}
	return len;
}
