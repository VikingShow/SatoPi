/**
 * Crew Transcript View — renders a roundtable/crew conversation transcript
 * inside a system `framedBlock`. Uses the global `theme` for all colours.
 *
 * Sections:
 *   1. Topic + round count + crew activity badge
 *   2. Crew member roster
 *   3. Scrollable interleaved message transcript with coloured agent tags
 *
 * The view fills the terminal above the editor and keeps the editor focused:
 * the input-controller's empty-editor key chain arbitrates the shortcuts below,
 * while the view's own handleInput remains for direct focus.
 *
 * Keyboard:
 *   j/k — scroll the transcript window
 *   f — toggle agent filter popup (show/hide specific agents)
 *   t — toggle between messages-only and messages+tools display
 *   r — cycle through round filters (all → round 1 → round 2 → … → all)
 *   Esc — close the view (leave the crew)
 */

import { type Component, matchesKey, type OverlayFocusOwner } from "@satopi/pi-tui";
import type { CrewState, CrewSummary } from "../../../crew/crew-manager";
import { AgentRegistry } from "../../../registry/agent-registry";
import type { Theme, ThemeColor } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";

// ============================================================================
// Layout constants
// ============================================================================

/** Rows reserved below the view for the status line (1) + editor (conservative 3). */
const RESERVED_BOTTOM_ROWS = 4;
/** Rows the bordered panel adds beyond its content (header bar + bottom border). */
const PANEL_CHROME_ROWS = 2;
/** Floor for the view's rendered height on very short terminals. */
const MIN_VIEW_ROWS = 10;
/** Terminal height fallback when process.stdout.rows is unavailable. */
const FALLBACK_TERMINAL_ROWS = 40;

/** Terminal height in rows, with a safe fallback for non-TTY contexts. */
function getTerminalRows(): number {
	return process.stdout.rows || FALLBACK_TERMINAL_ROWS;
}

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

export class CrewTranscriptView implements Component, OverlayFocusOwner {
	readonly #state: CrewTranscriptState;
	readonly #theme: Theme;
	readonly #onClose?: () => void;
	#showFilterPopup = false;
	#showTools = true;
	#filteredAgentIds = new Set<string>();
	/** Current round filter: 0 = all, N = round N only. */
	#roundFilter = 0;
	/** Scroll offset in entries from the newest transcript position (0 = follow newest). */
	#scrollOffset = 0;
	/** Largest valid scroll offset, refreshed on each render from the current filters. */
	#maxScrollOffset = 0;

	constructor(state: CrewTranscriptState, theme: Theme, onClose?: () => void) {
		this.#state = state;
		this.#theme = theme;
		this.#onClose = onClose;
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

				// 2. Rounds + crew activity badge (derived from entries + AgentRegistry)
				lines.push(this.#badgeLine(t));

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

				// 6. Scrollable message transcript window
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
					// Window the transcript to the rows left after chrome; the scroll
					// hint shares the message area (one row) when content overflows.
					const budget = this.#contentBudget(lines.length);
					const overflow = filtered.length > budget;
					const windowRows = overflow ? Math.max(1, budget - 1) : budget;
					this.#maxScrollOffset = Math.max(0, filtered.length - windowRows);
					this.#scrollOffset = Math.min(Math.max(0, this.#scrollOffset), this.#maxScrollOffset);
					const start = Math.max(0, filtered.length - windowRows - this.#scrollOffset);
					for (const entry of filtered.slice(start, start + windowRows)) {
						lines.push(this.#entryLine(entry, innerWidth, t));
					}
					if (overflow) {
						lines.push(t.fg("dim", `  \u2191\u2193 ${this.#maxScrollOffset} more`));
					}
				}

				return lines;
			},
			this.#theme,
		);
		const lines = [...panel.render(width)];
		// Fill-height: pad to the available screen height (reserving the status
		// line + editor at the bottom) so the panel spans the terminal above it.
		const target = Math.max(MIN_VIEW_ROWS, getTerminalRows() - RESERVED_BOTTOM_ROWS);
		for (let i = lines.length; i < target; i++) lines.push("");
		return lines;
	}

	/** Scroll the transcript window by `delta` entries (negative scrolls up). */
	scrollBy(delta: number): void {
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset + delta, this.#maxScrollOffset));
	}

	/** Open/close the agent filter popup. */
	toggleFilter(): void {
		this.#showFilterPopup = !this.#showFilterPopup;
	}

	/** Toggle between messages-only and messages+tools display. */
	toggleTools(): void {
		this.#showTools = !this.#showTools;
	}

	/** Cycle through round filters: 0 (all) → 1 → 2 → … → max → 0. */
	cycleRound(): void {
		this.#roundFilter = (this.#roundFilter + 1) % (this.#maxRound() + 1);
	}

	/** Whether the agent filter popup is currently open. */
	isFilterPopupOpen(): boolean {
		return this.#showFilterPopup;
	}

	/**
	 * The crew overlay delegates keyboard focus to the main editor: the host
	 * focuses the editor while this overlay is up so its key chain can arbitrate
	 * crew navigation (j/k/f/t/r/Esc) without typing being swallowed.
	 */
	ownsOverlayFocusTarget(_component: Component): boolean {
		return true;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.#onClose?.();
			return;
		}
		switch (data) {
			case "f":
			case "F":
				this.toggleFilter();
				break;
			case "t":
			case "T":
				this.toggleTools();
				break;
			case "r":
			case "R":
				this.cycleRound();
				break;
			case "j":
				this.scrollBy(1);
				break;
			case "k":
				this.scrollBy(-1);
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

	/** Badge line: round count derived from entries + live crew member activity. */
	#badgeLine(t: Theme): string {
		const rounds = Math.max(1, this.#maxRound());
		const roundInfo =
			this.#roundFilter > 0
				? t.fg("accent", `Round ${this.#roundFilter}/${rounds}`)
				: t.fg("dim", `Rounds: ${rounds}`);
		let line = `  ${roundInfo}`;
		if ("members" in this.#state.crew && this.#state.crew.members.length > 0) {
			const registry = AgentRegistry.global();
			const memberIds = this.#state.crew.members.map(m => m.agentId);
			const replying = memberIds.filter(id => registry.get(id)?.status === "running").length;
			line += t.fg("dim", ` \u00b7 ${replying}/${memberIds.length} replying`);
		}
		const toolMode = this.#showTools ? "tools" : "msg-only";
		line += `  ${t.fg("dim", `[${toolMode}]`)}`;
		return line;
	}

	/** Highest round number seen in the transcript (0 when empty). */
	#maxRound(): number {
		let max = 0;
		for (const entry of this.#state.entries) {
			if (entry.round > max) max = entry.round;
		}
		return max;
	}

	/** Rows available for the message window after chrome, capped to the screen. */
	#contentBudget(chromeRows: number): number {
		const available = Math.max(MIN_VIEW_ROWS, getTerminalRows() - RESERVED_BOTTOM_ROWS);
		// Panel chrome: header bar + bottom border.
		return Math.max(1, available - PANEL_CHROME_ROWS - chromeRows);
	}

	/** Render a single transcript entry (tool vs message). */
	#entryLine(entry: CrewTranscriptEntry, innerWidth: number, t: Theme): string {
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
			const body = entry.body.length > bodyBudget ? `${entry.body.slice(0, bodyBudget - 1)}\u2026` : entry.body;
			return `${prefix}${t.fg("dim", body)}`;
		}
		const prefix = `  ${time} ${roundLabel} ${tag} `;
		const prefixLen = visibleLen(prefix);
		const bodyBudget = Math.max(5, innerWidth - prefixLen - 1);
		const body = entry.body.length > bodyBudget ? `${entry.body.slice(0, bodyBudget - 1)}\u2026` : entry.body;
		return `${prefix}${body}`;
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
