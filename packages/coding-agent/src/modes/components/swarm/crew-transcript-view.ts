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
 *   r — cycle through round filters (all → round 1 → round 2 → … → all)
 *   Esc — close the view (leave the crew)
 */

import {
	type Component,
	matchesKey,
	type OverlayFocusOwner,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@satopi/pi-tui";
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
const FALLBACK_TERMINAL_ROWS = 24;
/** Below this inner width the per-entry round label is omitted to save prefix space. */
const MIN_ROUND_LABEL_INNER_WIDTH = 60;

/**
 * Terminal height in rows. Mirrors ProcessTerminal's own resolution
 * (process.stdout.rows → $LINES → 24) so the panel's fill-height padding
 * matches the viewport the overlay engine actually paints against. Using a
 * larger fallback here than the engine's would pad the panel past the
 * viewport; the host's maxHeight clamp keeps the editor safe either way.
 */
function getTerminalRows(): number {
	return process.stdout.rows || Number(Bun.env.LINES) || FALLBACK_TERMINAL_ROWS;
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
	#filteredAgentIds = new Set<string>();
	/** Current round filter: 0 = all, N = round N only. */
	#roundFilter = 0;
	/** Scroll offset in rows from the newest transcript position (0 = follow newest). */
	#scrollOffset = 0;
	/** Largest valid scroll offset, refreshed on each render from the current filters. */
	#maxScrollOffset = 0;

	/** Overlay height the host mounted this view with; padding targets it so
	 *  the bottom border is never clipped by the engine's maxHeight clamp. */
	#targetHeight: number | undefined;
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

	/** Set the overlay height budget (from the host's mount options). */
	setTargetHeight(height: number): void {
		this.#targetHeight = height;
	}

	render(width: number): readonly string[] {
		const panel = swarmPanel(
			"Crew Transcript",
			({ innerWidth, theme: t }) => {
				const lines: string[] = [];

				// 1. Topic
				lines.push(t.fg("accent", truncateToWidth(`  Topic: ${this.#state.topic}`, innerWidth)));

				// 2. Rounds + crew activity badge (derived from entries + AgentRegistry)
				lines.push(this.#badgeLine(innerWidth, t));

				// 3. Crew member roster (only for full CrewState)
				if ("members" in this.#state.crew && this.#state.crew.members.length > 0) {
					const members = this.#state.crew.members
						.map(m => `${m.agentId}${m.role === "observer" ? "*" : ""}`)
						.join(", ");
					lines.push(t.fg("dim", truncateToWidth(`  Crew: ${members}`, innerWidth)));
				}

				lines.push("");

				// 4. Filter popup (if active)
				if (this.#showFilterPopup) {
					lines.push(t.fg("accent", "  \u250c\u2500 Agent Filter"));
					const uniqueAgents = [...new Set(this.#state.entries.map(e => e.agentId))];
					for (const agentId of uniqueAgents) {
						const hidden = this.#filteredAgentIds.has(agentId);
						const mark = hidden ? t.fg("error", "\u2717") : t.fg("success", "\u2713");
						lines.push(truncateToWidth(`  \u2502 ${mark} ${agentId}`, innerWidth));
					}
					lines.push(t.fg("dim", "  \u2514\u2500 a-z toggle  f close"));
					lines.push("");
				}

				// 5. Shortcuts hint
				lines.push(t.fg("dim", truncateToWidth("  f:filter  r:round  j/k:scroll", innerWidth)));
				lines.push("");

				// 6. Scrollable message transcript window
				let filtered = this.#state.entries;
				if (this.#roundFilter > 0) {
					filtered = filtered.filter(e => e.round === this.#roundFilter);
				}
				if (this.#filteredAgentIds.size > 0) {
					filtered = filtered.filter(e => !this.#filteredAgentIds.has(e.agentId));
				}

				if (filtered.length === 0) {
					lines.push(t.fg("dim", truncateToWidth("  No transcript entries match filter", innerWidth)));
				} else {
					// Pre-render every entry to wrapped display rows (multi-line
					// bodies), then window by ROWS so long agent replies are fully
					// readable instead of being truncated to one line.
					const rendered: string[] = [];
					for (const entry of filtered) {
						rendered.push(...this.#entryLines(entry, innerWidth, t));
					}
					const budget = this.#contentBudget(lines.length);
					const overflow = rendered.length > budget;
					const windowRows = overflow ? Math.max(1, budget - 1) : budget;
					this.#maxScrollOffset = Math.max(0, rendered.length - windowRows);
					this.#scrollOffset = Math.min(Math.max(0, this.#scrollOffset), this.#maxScrollOffset);
					const start = Math.max(0, rendered.length - windowRows - this.#scrollOffset);
					for (const line of rendered.slice(start, start + windowRows)) {
						lines.push(line);
					}
					if (overflow) {
						lines.push(t.fg("dim", `  \u2191\u2193 ${this.#maxScrollOffset} more`));
					}
				}

				// Fill the content area to the panel's target height so the
				// bottom border sits at the content edge instead of floating
				// right after the last message row. Prefer the host-provided
				// overlay budget (maxHeight) so the engine never clips the
				// border; fall back to the terminal-derived estimate.
				const available = Math.max(MIN_VIEW_ROWS, getTerminalRows() - RESERVED_BOTTOM_ROWS);
				const target = this.#targetHeight ?? available;
				const contentTarget = Math.max(lines.length, target - PANEL_CHROME_ROWS);
				for (let i = lines.length; i < contentTarget; i++) lines.push("");
				return lines;
			},
			this.#theme,
		);
		return panel.render(width);
	}

	/** Scroll the transcript window by `delta` rows (negative scrolls up). */
	scrollBy(delta: number): void {
		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset + delta, this.#maxScrollOffset));
	}

	/** Open/close the agent filter popup. */
	toggleFilter(): void {
		this.#showFilterPopup = !this.#showFilterPopup;
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
	 * crew navigation (j/k/f/r/Esc) without typing being swallowed.
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
	#badgeLine(innerWidth: number, t: Theme): string {
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
		// Truncated so the line can never re-wrap inside the frame and inflate
		// the panel past the overlay height budget.
		return truncateToWidth(line, innerWidth);
	}

	/** Highest round number seen in the transcript (0 when empty). */
	#maxRound(): number {
		let max = 0;
		for (const entry of this.#state.entries) {
			if (entry.round > max) max = entry.round;
		}
		return max;
	}

	/** Rows available for the message window after chrome. When the host has
	 *  mounted the view with an overlay height budget (setTargetHeight), that
	 *  budget is authoritative — the panel must never exceed it or the engine's
	 *  maxHeight clamp clips the bottom border. Falls back to a terminal-derived
	 *  estimate when the host never set one. */
	#contentBudget(chromeRows: number): number {
		if (this.#targetHeight !== undefined) {
			// Panel chrome: header bar + bottom border.
			return Math.max(1, this.#targetHeight - PANEL_CHROME_ROWS - chromeRows);
		}
		const available = Math.max(MIN_VIEW_ROWS, getTerminalRows() - RESERVED_BOTTOM_ROWS);
		return Math.max(1, available - PANEL_CHROME_ROWS - chromeRows);
	}

	/** Render a transcript entry as a header row + wrapped body block, followed
	 *  by exactly one blank separator row (mirrors the main-session transcript's
	 *  block rhythm). Continuation rows align under the body column. */
	#entryLines(entry: CrewTranscriptEntry, innerWidth: number, t: Theme): string[] {
		const color = agentColor(entry.agentId, t);
		const time = formatTime(entry.timestamp, t);
		const tag = color(`[${entry.agentId}]`);
		// Tool entries are not produced at this baseline (Phase B4 wires them in
		// later); kind/toolName stay on the type for that path, but every entry
		// renders through the message layout.
		const roundLabel = innerWidth < MIN_ROUND_LABEL_INNER_WIDTH ? "" : `${t.fg("dim", `R${entry.round}`)} `;
		const prefix = `  ${time} ${roundLabel}${tag} `;
		const prefixLen = visibleWidth(prefix);
		const bodyWidth = Math.max(10, innerWidth - prefixLen - 1);
		const bodyLines = wrapTextWithAnsi(entry.body, bodyWidth);
		// A body ending in "\n" wraps to a trailing empty paragraph that would
		// double the block separator — drop trailing empties so the boundary
		// between adjacent entries stays exactly one blank row.
		let bodyEnd = bodyLines.length;
		while (bodyEnd > 0 && bodyLines[bodyEnd - 1] === "") bodyEnd--;

		const out: string[] = [];
		bodyLines.slice(0, bodyEnd).forEach((body, index) => {
			if (index === 0) {
				out.push(`${prefix}${body}`);
			} else {
				// Continuation rows align under the body column (prefix width).
				out.push(`${" ".repeat(Math.max(0, prefixLen))}${body}`);
			}
		});
		if (out.length === 0) out.push(prefix);
		out.push("");
		return out;
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
	return t.fg("dim", `${hh}:${mm}`);
}
