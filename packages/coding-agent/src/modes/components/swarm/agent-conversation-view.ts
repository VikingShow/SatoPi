/**
 * AgentConversationView — renders the full conversation history of a single
 * agent inside a system `swarmPanel`. Uses the global `theme` for all colours.
 *
 * Sections:
 *   1. Header: agentId + displayName + credit score badge + archetype + domains
 *   2. Body: scrollable transcript colour-coded by role/agent
 *   3. Footer: shortcut hints
 *
 * Keyboard:
 *   j / down — scroll down one entry
 *   k / up   — scroll up one entry
 */

import type { Component } from "@satopi/pi-tui";
import type { AgentProfile } from "../../../agent/agent-profile";
import type { Theme, ThemeColor } from "../../theme/theme";
import { formatBadge } from "../../../tools/render-utils";
import { agentColor, formatTime } from "./crew-transcript-view";
import { swarmPanel } from "./swarm-panel-block";

// Public types
// ============================================================================

export interface AgentConversationEntry {
	role: "system" | "user" | "assistant";
	content: string;
	timestamp: number;
	toolCalls?: Array<{ name: string; args: unknown }>;
}

// ============================================================================
// AgentConversationView
// ============================================================================

/** Colour used for user (human) messages. */
const USER_COLOR: ThemeColor = "userMessageText";

/** Colour used for system messages. */
const SYSTEM_COLOR: ThemeColor = "dim";

/** Maximum preview length for tool arg summaries. */
const MAX_TOOL_ARG_LENGTH = 60;

export class AgentConversationView implements Component {
	readonly #agentId: string;
	readonly #displayName: string;
	readonly #entries: AgentConversationEntry[];
	readonly #profile: AgentProfile | undefined;
	readonly #theme: Theme;

	/** Index of the last visible entry (0-based, from end). */
	#scrollOffset = 0;

	constructor(
		agentId: string,
		displayName: string,
		entries: AgentConversationEntry[],
		profile: AgentProfile | undefined,
		theme: Theme,
	) {
		this.#agentId = agentId;
		this.#displayName = displayName;
		this.#entries = entries;
		this.#profile = profile;
		this.#theme = theme;
	}

	render(width: number): readonly string[] {
		const panel = swarmPanel(
			`Agent: ${this.#displayName}`,
			({ innerWidth, theme: t }) => {
				const lines: string[] = [];

				// ── 1. Header ──────────────────────────────────────────
				this.#renderHeader(lines, innerWidth, t);

				// ── 2. Divider ─────────────────────────────────────────
				lines.push("");

				// ── 3. Footer shortcut hints ───────────────────────────
				lines.push(t.fg("dim", "  j/\u2193:down  k/\u2191:up  g:top  G:bottom"));

				lines.push("");

				// ── 4. Transcript ───────────────────────────────────────
				this.#renderTranscript(lines, innerWidth, t);

				return lines;
			},
			this.#theme,
			{ applyBg: true },
		);
		return panel.render(width);
	}

	handleInput(data: string): void {
		switch (data) {
			case "j":
			case "\x1b[B": // down arrow
				if (this.#scrollOffset > 0) {
					this.#scrollOffset--;
				}
				break;
			case "k":
			case "\x1b[A": // up arrow
				if (this.#scrollOffset < this.#entries.length - 1) {
					this.#scrollOffset++;
				}
				break;
			case "g":
			case "G":
				if (data === "g") {
					// Scroll to top (show oldest, i.e. max offset)
					this.#scrollOffset = Math.max(0, this.#entries.length - 1);
				} else {
					// Scroll to bottom (show newest, i.e. zero offset)
					this.#scrollOffset = 0;
				}
				break;
		}
	}

	invalidate(): void {
		this.#scrollOffset = 0;
	}

	dispose(): void {
		// No resources to release
	}

	// ====================================================================
	// Private rendering helpers
	// ====================================================================

	/** Render the header block with agent identity and profile info. */
	#renderHeader(lines: string[], innerWidth: number, t: Theme): void {
		const agentColorFn = agentColor(this.#agentId, t);

		// Line 1: agentId + displayName
		const idStr = agentColorFn(`${t.bold(this.#displayName)}`);
		lines.push(`  ${idStr}`);

		// Line 2: profile metadata (if available)
		if (this.#profile) {
			const parts: string[] = [];

			// Credit score badge
			const score = this.#profile.credit.score;
			const scoreColor: ThemeColor =
				score >= 70 ? "success" : score >= 40 ? "warning" : "error";
			parts.push(formatBadge(`${score}`, scoreColor, t));

			// Archetype
			parts.push(t.fg("accent", this.#profile.identity.archetype));

			// Success rate
			const rate = Math.round(this.#profile.credit.successRate * 100);
			parts.push(
				t.fg("dim", `${rate}% success (${this.#profile.credit.totalTasks} tasks)`),
			);

			// Violations (if any)
			if (this.#profile.credit.violationCount > 0) {
				parts.push(
					t.fg("error", `${this.#profile.credit.violationCount} violations`),
				);
			}

			lines.push(`  ${parts.join("  ")}`);

			// Domains
			if (this.#profile.expertise.domains.length > 0) {
				const domainList = this.#profile.expertise.domains
					.map(d => t.fg("dim", d))
					.join(t.fg("dim", ", "));
				lines.push(`  ${t.fg("muted", "Domains:")} ${domainList}`);
			}

			// Specialties
			if (this.#profile.expertise.specialties.length > 0) {
				const specList = this.#profile.expertise.specialties
					.map(s => t.fg("dim", s))
					.join(t.fg("dim", ", "));
				lines.push(`  ${t.fg("muted", "Specialties:")} ${specList}`);
			}
		} else {
			lines.push(`  ${t.fg("dim", "(no profile data)")}`);
		}
	}

	/** Render the transcript body with scrolling. */
	#renderTranscript(lines: string[], innerWidth: number, t: Theme): void {
		if (this.#entries.length === 0) {
			lines.push(`  ${t.fg("dim", "No conversation history")}`);
			return;
		}

		// Count lines needed by header/footer/divider to compute visible window
		const overheadLines = lines.length;
		// Reserve 2 lines for overflow indicators
		const entryBudget = Math.max(1, innerWidth - overheadLines - 2);

		// Compute the visible slice based on scroll offset
		const total = this.#entries.length;
		const endIdx = total - this.#scrollOffset;
		const startIdx = Math.max(0, endIdx - entryBudget);

		// Overflow indicators
		if (startIdx > 0) {
			lines.push(
				t.fg("dim", `  \u2026 ${startIdx} older entries (k/\u2191 to scroll)`),
			);
		}

		// Render visible entries
		for (let i = startIdx; i < endIdx; i++) {
			const entry = this.#entries[i];
			this.#renderEntry(entry, innerWidth, t, lines);
		}

		// More recent entries below
		if (endIdx < total) {
			lines.push(
				t.fg(
					"dim",
					`  \u2026 ${total - endIdx} newer entries (j/\u2193 to scroll)`,
				),
			);
		}
	}

	/** Render a single conversation entry. */
	#renderEntry(
		entry: AgentConversationEntry,
		innerWidth: number,
		t: Theme,
		lines: string[],
	): void {
		const time = formatTime(entry.timestamp, t);
		const roleLabel = this.#roleLabel(entry.role, t);

		// Content prefix: time + role tag
		const prefix = `  ${time} ${roleLabel} `;
		const prefixLen = visibleLen(prefix);

		// Split content into lines and render each
		const contentLines = entry.content.split("\n");
		const bodyBudget = Math.max(10, innerWidth - prefixLen);


		for (let ci = 0; ci < contentLines.length; ci++) {
			const raw = contentLines[ci] || "";
			// Truncate long lines
			const body =
				raw.length > bodyBudget
					? `${raw.slice(0, bodyBudget - 1)}\u2026`
					: raw;

			if (ci === 0) {
				// First line uses the full prefix
				const coloredBody = this.#colorContent(body, entry.role, t);
				lines.push(`${prefix}${coloredBody}`);
			} else {
				// Continuation lines are indented
				const indent = " ".repeat(visibleLen(prefix));
				const coloredBody = this.#colorContent(body, entry.role, t);
				lines.push(`${indent}${coloredBody}`);
			}
		}

		// Render tool calls if present
		if (entry.toolCalls && entry.toolCalls.length > 0) {
			const indent = " ".repeat(6); // 2-space margin + 4-space indent
			for (const tc of entry.toolCalls) {
				const toolTag = t.fg("accent", `\u2699 ${tc.name}`);
				const argsSummary = this.#formatArgsSummary(tc.args, t);
				lines.push(`  ${indent}${toolTag} ${argsSummary}`);
			}
		}
	}

	/** Get the role label with appropriate styling. */
	#roleLabel(role: AgentConversationEntry["role"], t: Theme): string {
		switch (role) {
			case "user":
				return t.fg("userMessageText", t.bold("[You]"));
			case "assistant":
				return agentColor(this.#agentId, t)(t.bold(`[${this.#displayName}]`));
			case "system":
				return t.fg("dim", "[System]");
		}
	}

	/** Apply colour to message content based on role. */
	#colorContent(
		text: string,
		role: AgentConversationEntry["role"],
		t: Theme,
	): string {
		switch (role) {
			case "system":
				return t.fg(SYSTEM_COLOR, text);
			case "user":
				return t.fg(USER_COLOR, text);
			case "assistant":
				// Assistant content uses default text colour
				return text;
		}
	}

	/** Format a single-line summary of tool arguments. */
	#formatArgsSummary(args: unknown, t: Theme): string {
		if (args === undefined || args === null) return t.fg("dim", "");
		if (typeof args === "string" && args.length <= MAX_TOOL_ARG_LENGTH) {
			return t.fg("dim", args);
		}
		try {
			const json = JSON.stringify(args);
			if (json.length <= MAX_TOOL_ARG_LENGTH) {
				return t.fg("dim", json);
			}
			return t.fg("dim", `${json.slice(0, MAX_TOOL_ARG_LENGTH - 1)}\u2026`);
		} catch {
			return t.fg("dim", "(args)");
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

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
